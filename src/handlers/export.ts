import { Env } from "../types";
import { calendarState } from "./calendar";
import { IMAGE_SLOTS, imageKey, type ImageSlot } from "./images";
import { publicVisuals, revOf } from "./settings";
import { rateLimited, tooManyRes } from "../rate-limit";
import { publicRecord } from "../public-visuals";
import {
  authenticate,
  listSessions,
  recordLoader,
  type RecordSource,
} from "../sessions";
import { jsonRes, methodNotAllowedRes, unauthorizedRes } from "../utils";

/**
 * Settings keys whose value opens something (the calendar link's token, a
 * session token an old build may have synced): the export is a file a
 * student may hand to anyone, so their values are replaced. The student sees
 * them in the extension anyway, and `calendar.live` says whether a link exists.
 */
const SECRET_KEY_RE = /(^|_)TOKEN$/;
const REDACTED = "[redacted]";

/** A users.created_at (unix seconds, or a date string from an older schema) in ms. */
function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Slots holding an upload. Three metadata reads, each body cancelled
 * unread: a list would cost one of the free plan's 1,000 list operations a
 * day, and a plain get would download up to 2 MB per image.
 */
async function storedImages(env: Env, loginHash: string): Promise<ImageSlot[]> {
  const found: ImageSlot[] = [];
  for (const slot of IMAGE_SLOTS) {
    const { value } = await env.BETTER_INTRA_KV.getWithMetadata(imageKey(loginHash, slot), {
      type: "stream",
    });
    if (value) {
      await value.cancel().catch(() => {});
      found.push(slot);
    }
  }
  return found;
}

/**
 * GET /api/v1/private/export?login=<hash>: everything the worker keeps about
 * the caller, as one JSON file ("Download my cloud data"). The only other
 * way to know was a request on the public issue tracker, which names the
 * student, and wrangler queries by the operator.
 *
 * Never a token (sessions are listed by their short id, token-like settings
 * are redacted) and never another login's data: every read is keyed by the
 * caller's own hash, behind their session. Writes nothing; rate limited in
 * the write bucket, since it is the most expensive read a student can ask
 * for (the record, three image reads, a few D1 queries).
 */
export async function handleExport(
  request: Request,
  env: Env,
  loginParam: string,
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowedRes();
  const record = recordLoader(source);
  const session = await authenticate(request, env, loginParam, record);
  if (!session) return unauthorizedRes();
  if (await rateLimited(env, "write", loginParam)) return tooManyRes();

  const [data, sessions, calendar, images, user] = await Promise.all([
    record(),
    listSessions(env, loginParam),
    calendarState(env, loginParam),
    storedImages(env, loginParam),
    env.better_intra_d1
      .prepare("SELECT created_at FROM users WHERE hash = ?")
      .bind(loginParam)
      .first<{ created_at: unknown }>(),
  ]);
  const settings: Record<string, unknown> = { ...(data?.settings || {}) };
  for (const key of Object.keys(settings)) {
    if (SECRET_KEY_RE.test(key) && settings[key] !== "" && settings[key] != null) {
      settings[key] = REDACTED;
    }
  }
  // What visitors are served, from the same source as the public route.
  const visible = publicVisuals(await publicRecord(env, loginParam, record));

  return jsonRes(
    {
      exportedAt: Date.now(),
      loginHash: loginParam,
      settings,
      rev: revOf(data),
      sessions: sessions.map((s) => ({ id: s.tokenHash.slice(0, 8), createdAt: s.createdAt })),
      firstSignIn: toMs(user?.created_at),
      calendar,
      images,
      publicVisuals: visible,
    },
    200,
    {
      "Cache-Control": "no-store",
      "Content-Disposition": 'attachment; filename="cuter-intra-cloud-data.json"',
    },
  );
}
