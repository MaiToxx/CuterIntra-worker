import { Env } from "./types";
import { FETCH_DEADLINES } from "./utils";

/**
 * Client of the official 42 API (api.intra.42.fr/v2) with the deployment's own
 * 42 application: a client_credentials token, no user token. Read-only GETs.
 *
 * The application's quota (2 requests a second, 1,200 an hour, shared by every
 * student who uses the extension) is the scarce resource, so:
 * - requests are spaced per isolate, under 2 a second;
 * - a 429, or an hourly counter at 0, stops every call of this isolate until
 *   the quota comes back, instead of retrying into it;
 * - callers cache what they get (see handlers/logtime-history.ts).
 *
 * The token lives in isolate memory only: a KV copy would spend a write of the
 * 1,000 a day the whole namespace shares (src/budget.ts), and a token costs one
 * request to get again. Unconfigured (no FT_CLIENT_ID or FT_CLIENT_SECRET), the
 * routes that need the API answer 404, as before this client existed.
 */

export const FT_API = "https://api.intra.42.fr";
const USER_AGENT = "CuterIntra-worker (+https://github.com/MaiToxx/CuterIntra)";
/** One request every 550 ms per isolate stays under 2 a second. */
const GAP_MS = 550;
/** A token is renewed this long before 42 says it expires. */
const TOKEN_MARGIN_S = 60;
/** Without a Retry-After, how long a 429 or an empty hourly counter pauses calls. */
const DEFAULT_PAUSE_MS = 10 * 60_000;
/** Warn in the logs this long before the application secret expires. */
const SECRET_WARNING_S = 7 * 86_400;

export function ftConfigured(env: Env): boolean {
  return !!env.FT_CLIENT_ID && !!env.FT_CLIENT_SECRET;
}

type Token = { value: string; expiresAt: number };
let token: Token | null = null;
let tokenPending: Promise<Token | null> | null = null;
let nextRequestAt = 0;
let pausedUntil = 0;
let secretWarned = false;

/** For the tests: forget the token, the pacing and any pause. */
export function resetFtApi(): void {
  token = null;
  tokenPending = null;
  nextRequestAt = 0;
  pausedUntil = 0;
  secretWarned = false;
}

export type FtResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: "unconfigured" | "quota" | "upstream" | "not_found" };

async function paced(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + GAP_MS;
  if (at > now) await new Promise((done) => setTimeout(done, at - now));
}

function pauseFrom(res: Response): void {
  const after = Number(res.headers.get("Retry-After"));
  pausedUntil = Date.now() + (after > 0 ? after * 1000 : DEFAULT_PAUSE_MS);
  console.warn(`[ft-api] quota reached: 42 API calls paused until ${new Date(pausedUntil).toISOString()}`);
}

async function fetchToken(env: Env): Promise<Token | null> {
  await paced();
  const res = await fetch(`${FT_API}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.FT_CLIENT_ID ?? "",
      client_secret: env.FT_CLIENT_SECRET ?? "",
    }).toString(),
    // The body carries the secret: never let it follow a redirect.
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_DEADLINES.ftApiMs),
  });
  if (res.status === 429) {
    pauseFrom(res);
    return null;
  }
  if (!res.ok) {
    // 401 is a wrong or rotated secret: `npx wrangler secret put FT_CLIENT_SECRET`.
    console.error(`[ft-api] token refused by 42: HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    secret_valid_until?: unknown;
  };
  if (typeof body.access_token !== "string" || !body.access_token) return null;
  const until = Number(body.secret_valid_until);
  if (!secretWarned && until > 0 && until - Date.now() / 1000 < SECRET_WARNING_S) {
    secretWarned = true;
    console.warn(
      `[ft-api] the 42 application secret expires on ${new Date(until * 1000).toISOString().slice(0, 10)}: set the new one with npx wrangler secret put FT_CLIENT_SECRET`,
    );
  }
  const lifetime = Number(body.expires_in) > 0 ? Number(body.expires_in) : 7200;
  return { value: body.access_token, expiresAt: Date.now() + (lifetime - TOKEN_MARGIN_S) * 1000 };
}

/** The application token, fetched once per isolate and shared by concurrent calls. */
async function appToken(env: Env): Promise<Token | null> {
  if (token && token.expiresAt > Date.now()) return token;
  tokenPending ??= fetchToken(env).finally(() => {
    tokenPending = null;
  });
  token = await tokenPending;
  return token;
}

/**
 * GET `path` (starting with /v2/) with the application token. Never throws:
 * a network error, a timeout or an answer that is not JSON is "upstream".
 */
export async function ftGet(env: Env, path: string): Promise<FtResult> {
  if (!ftConfigured(env)) return { ok: false, reason: "unconfigured" };
  if (Date.now() < pausedUntil) return { ok: false, reason: "quota" };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await appToken(env);
      if (!current) return { ok: false, reason: Date.now() < pausedUntil ? "quota" : "upstream" };
      await paced();
      const res = await fetch(`${FT_API}${path}`, {
        headers: {
          Authorization: `Bearer ${current.value}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_DEADLINES.ftApiMs),
      });
      if (res.status === 401 && attempt === 0) {
        // Revoked or expired early: one new token, one more try.
        token = null;
        continue;
      }
      if (res.status === 429) {
        pauseFrom(res);
        return { ok: false, reason: "quota" };
      }
      if (res.headers.get("x-hourly-ratelimit-remaining") === "0") pauseFrom(res);
      if (res.status === 404) return { ok: false, reason: "not_found" };
      if (!res.ok) {
        // Path only, with the student's login or id taken out.
        console.error(`[ft-api] GET ${path.split("?")[0].replace(/\/users\/[^/]+/, "/users/:user")} answered HTTP ${res.status}`);
        return { ok: false, reason: "upstream" };
      }
      return { ok: true, data: await res.json() };
    }
    return { ok: false, reason: "upstream" };
  } catch (e) {
    console.error(`[ft-api] request failed: ${e instanceof Error ? e.name : typeof e}`);
    return { ok: false, reason: "upstream" };
  }
}
