import { Env } from "../types";
import { rateLimited, tooManyRes } from "../rate-limit";
import { recordLoader, requireSession, type RecordSource } from "../sessions";
import {
  corsHeaders,
  errorRes,
  jsonRes,
  methodNotAllowedRes,
  notFoundRes,
  readJsonBody,
} from "../utils";

/**
 * A full year of Intra events is a few tens of KB of ICS. D1 refuses rows past
 * 2 MB with an unhandled error, and the stored body is served to every
 * calendar client every hour, so anything past this is a wrong client.
 */
export const MAX_ICS_BYTES = 256 * 1024;

/**
 * Calendar links (/calendar/<token>.ics) live in D1, one live token per
 * login. They used to be KV keys CALENDAR_TOKEN_<token> -> login hash that
 * nothing ever deleted, so "Regenerate" and "Wipe all data" left every old
 * link serving the student's schedule. A revoked token keeps its row
 * (revoked_at set): nobody can register it again and feed their own events to
 * the calendars still subscribed to it.
 *
 * Those legacy KV keys are no longer read: the live namespace holds none
 * (checked 2026-09-25), so every link that works has a row here, and a feed
 * or a registration costs no KV read.
 */

/** What the extension generates (crypto.randomUUID()), with room to spare. */
const NEW_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** A secret link read by its owner: never kept by a cache on the way. */
const NO_STORE = { "Cache-Control": "no-store" };

const ensuredDbs = new WeakSet<object>();

/**
 * Created on first use, from before migrations/ existed: a deploy does not
 * apply migrations. Kept until migrations/0001_baseline.sql is confirmed
 * applied on the live database, then to be removed with its test. Called on
 * every path, reads included, so that a missing table never reads as "no
 * link".
 */
async function ensureTokensTable(env: Env): Promise<void> {
  const db = env.better_intra_d1;
  if (ensuredDbs.has(db)) return;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS calendar_tokens (token TEXT PRIMARY KEY, login_hash TEXT NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch()))",
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS calendar_tokens_login ON calendar_tokens (login_hash)",
    ),
  ]);
  ensuredDbs.add(db);
}

/**
 * The login's live link, or null (never made one, stopped, wiped). The
 * `wiped:` marker rows an earlier worker wrote always have revoked_at set,
 * so they never come back as a link.
 */
export async function liveCalendarToken(
  env: Env,
  loginHash: string,
): Promise<string | null> {
  await ensureTokensTable(env);
  const row = await env.better_intra_d1
    .prepare(
      "SELECT token FROM calendar_tokens WHERE login_hash = ? AND revoked_at IS NULL LIMIT 1",
    )
    .bind(loginHash)
    .first<{ token: string }>();
  return row?.token ?? null;
}

/** Whether the login has a live link, and a stored calendar (the export). */
export async function calendarState(
  env: Env,
  loginHash: string,
): Promise<{ live: boolean; feedStored: boolean }> {
  await ensureTokensTable(env);
  const row = await env.better_intra_d1
    .prepare(
      "SELECT EXISTS (SELECT 1 FROM calendar_tokens WHERE login_hash = ? AND revoked_at IS NULL) AS live, EXISTS (SELECT 1 FROM calendar_ics WHERE login_hash = ?) AS feed",
    )
    .bind(loginHash, loginHash)
    .first<{ live: number; feed: number }>();
  return { live: !!row?.live, feedStored: !!row?.feed };
}

/**
 * /api/v1/private/calendar/token?login=<hash>
 *  - GET: {"token": <the live link's token> | null}. Only the browser that
 *    made a link used to know it: another one offered "Generate", which
 *    revoked the link a phone was subscribed to, and a regenerated or
 *    stopped link kept showing there. No write and no rate limit: the
 *    session holder can already read the synced copy, and regenerate it.
 *  - POST {token}: registers a new link, which revokes the previous one.
 *  - DELETE: "Stop sharing". Revokes the link and deletes the stored
 *    calendar (204), without the rest of "Wipe all data": until then the
 *    only way to take a timetable off the server was to wipe the settings
 *    backup, images and sessions with it.
 */
export async function handleCalendarToken(
  request: Request,
  env: Env,
  loginParam: string,
  source: RecordSource,
): Promise<Response> {
  if (!["GET", "POST", "DELETE"].includes(request.method)) {
    return methodNotAllowedRes();
  }

  // The session alone: none of these paths reads the KV record any more.
  const denied = await requireSession(request, env, loginParam, recordLoader(source));
  if (denied) return denied;

  if (request.method === "GET") {
    return jsonRes({ token: await liveCalendarToken(env, loginParam) }, 200, NO_STORE);
  }

  if (request.method === "DELETE") {
    if (await rateLimited(env, "write", loginParam)) return tooManyRes();
    await deleteCalendarData(env, loginParam);
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const body = await readJsonBody<{ token?: unknown }>(
    request,
    4096,
    "Body too large",
  );
  if (!body.ok) return body.response;

  const token = body.value?.token;
  if (typeof token !== "string" || !NEW_TOKEN_RE.test(token)) {
    return errorRes("bad_request", "Invalid token", 400);
  }

  await ensureTokensTable(env);
  const db = env.better_intra_d1;

  // A token is bound once, for good: taking over a link someone learnt (from a
  // screenshot, a QR code on a screen) would let them rewrite the calendar of
  // everyone subscribed to it.
  const row = await db
    .prepare(
      "SELECT login_hash, revoked_at FROM calendar_tokens WHERE token = ?",
    )
    .bind(token)
    .first<{ login_hash: string; revoked_at: number | null }>();
  if (row) {
    if (row.login_hash === loginParam && row.revoked_at === null) {
      return jsonRes({ ok: true });
    }
    return errorRes("conflict", "Token already in use", 409);
  }

  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  await db.batch([
    // "New link invalidates the old one": the previous link stops here
    db
      .prepare(
        "UPDATE calendar_tokens SET revoked_at = unixepoch() WHERE login_hash = ? AND revoked_at IS NULL",
      )
      .bind(loginParam),
    db
      .prepare("INSERT INTO calendar_tokens (token, login_hash) VALUES (?, ?)")
      .bind(token, loginParam),
  ]);

  return jsonRes({ ok: true });
}

/**
 * "Wipe all data" and "Stop sharing": revokes every calendar link of the
 * login and deletes the stored calendar. A login with no link row gets none:
 * an earlier worker inserted a revoked `wiped:<uuid>` marker there, so that a
 * legacy KV link (CALENDAR_TOKEN_*, which had no row) read as stopped. Those
 * links are gone, so the marker only left a new, permanent row naming the
 * login in a database the wipe had just taken it out of, for every student
 * who never used the calendar. Such a login holds no link to upload with
 * (the extension stores one only once POST /token succeeded), and
 * handleCalendarUpdate still answers 410 to every login whose rows are all
 * revoked. Markers already written stay revoked and inert.
 */
export async function deleteCalendarData(
  env: Env,
  loginParam: string,
): Promise<void> {
  await ensureTokensTable(env);
  const db = env.better_intra_d1;
  await db.batch([
    db
      .prepare(
        "UPDATE calendar_tokens SET revoked_at = unixepoch() WHERE login_hash = ? AND revoked_at IS NULL",
      )
      .bind(loginParam),
    db
      .prepare("DELETE FROM calendar_ics WHERE login_hash = ?")
      .bind(loginParam),
  ]);
}

export async function handleCalendarUpdate(
  request: Request,
  env: Env,
  loginParam: string,
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowedRes();

  // The session alone: once the login's sessions are in D1, this path (taken
  // on profile visits) reads no KV record.
  const denied = await requireSession(request, env, loginParam, recordLoader(source));
  if (denied) return denied;

  const body = await readJsonBody<{ ics?: unknown }>(
    request,
    MAX_ICS_BYTES,
    `Calendar too large (max ${MAX_ICS_BYTES / 1024} KB)`,
  );
  if (!body.ok) return body.response;

  const ics = body.value?.ics;
  if (typeof ics !== "string" || ics.length < 50) {
    return errorRes("bad_request", "Invalid ics body", 400);
  }

  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  // CALENDAR_SYNC_TOKEN is a synced setting: another browser that restored it
  // keeps uploading on every profile visit after "Stop sharing". Nobody could
  // read that copy (no live link), but the timetable the student took off the
  // server would be back on it. So the row is only written while the login
  // has a live link, or no link row at all (none registered yet). One
  // statement rather than a check then a write: a stop landing in between
  // would be undone by the write.
  await ensureTokensTable(env);
  const { meta } = await env.better_intra_d1
    .prepare(
      "INSERT OR REPLACE INTO calendar_ics (login_hash, ics_body, updated_at) SELECT ?, ?, unixepoch() WHERE NOT EXISTS (SELECT 1 FROM calendar_tokens WHERE login_hash = ?) OR EXISTS (SELECT 1 FROM calendar_tokens WHERE login_hash = ? AND revoked_at IS NULL)",
    )
    .bind(loginParam, ics, loginParam, loginParam)
    .run();
  // Strictly 0: the 410 makes the extension forget its link, so a result
  // that says nothing must not read as "stopped".
  if (meta.changes === 0) {
    return errorRes(
      "calendar_stopped",
      "Calendar sharing was stopped: make a new link to share again",
      410,
    );
  }

  return jsonRes({ ok: true });
}

/** Login hash whose calendar `token` serves, or null (unknown or revoked). */
async function resolveCalendarToken(
  token: string,
  env: Env,
): Promise<string | null> {
  await ensureTokensTable(env);
  const row = await env.better_intra_d1
    .prepare(
      "SELECT login_hash, revoked_at FROM calendar_tokens WHERE token = ?",
    )
    .bind(token)
    .first<{ login_hash: string; revoked_at: number | null }>();
  return row && row.revoked_at === null ? row.login_hash : null;
}

export async function handleCalendarIcs(
  token: string,
  env: Env,
): Promise<Response> {
  if (!token || token.length < 8 || token.length > 200) {
    return notFoundRes();
  }

  const login = await resolveCalendarToken(token, env);
  if (!login) return notFoundRes();

  const row = await env.better_intra_d1
    .prepare("SELECT ics_body FROM calendar_ics WHERE login_hash = ?")
    .bind(login)
    .first<{ ics_body: string }>();

  if (!row) {
    const emptyIcs = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//BetterIntra//Events//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "END:VCALENDAR",
    ].join("\r\n");
    return new Response(emptyIcs, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="cuter-intra-calendar.ics"',
        // private: one student's timetable behind a secret link, not
        // something a shared cache should keep
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return new Response(row.ics_body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="cuter-intra-calendar.ics"',
      // private: one student's timetable behind a secret link, not
      // something a shared cache should keep
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
