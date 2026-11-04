import { Env } from "./types";

const ALLOWED_ORIGINS = [
  "https://profile-v3.intra.42.fr",
  "https://meta.intra.42.fr",
];

export function isOriginAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin.startsWith("moz-extension://")) return true;
  if (/^https:\/\/(?:[a-z0-9-]+\.)*intra\.42\.fr$/.test(origin)) return true;
  return false;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  // JSON and text bodies opened as a page on the worker's own origin must
  // never be sniffed into HTML.
  "X-Content-Type-Options": "nosniff",
};

export const jsonRes = (
  body: any,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...headers },
  });

export const textRes = (
  text: string,
  status = 200,
  contentType = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
) =>
  new Response(text, {
    status,
    headers: { ...corsHeaders, "Content-Type": contentType, ...headers },
  });

/**
 * The codes an error body can carry. They are the contract: the extension
 * picks its (translated) message from the code, never from the English
 * `message`, which is there for logs and bug reports. Add a code rather than
 * reuse one for a new meaning.
 */
export type ErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "daily_write_budget"
  | "too_large"
  | "conflict"
  | "calendar_stopped"
  | "bad_request"
  | "not_found"
  | "kv_busy"
  | "unsupported_image_type"
  | "image_too_large"
  | "server_error";

/**
 * Every error answer: `{"error":<code>,"message":<English>}` plus `extra`
 * fields, CORS-readable. The statuses are the ones each case always had, so
 * builds that only look at the status see no change; the ones that read the
 * body get `message` through workerFetch, which parses JSON first (the text
 * they used to show is now that field).
 */
export const errorRes = (
  code: ErrorCode,
  message: string,
  status: number,
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) => jsonRes({ error: code, message, ...extra }, status, headers);

export const methodNotAllowedRes = () =>
  errorRes("bad_request", "Method not allowed", 405);

export const notFoundRes = () => errorRes("not_found", "Not found", 404);

/**
 * True for the error KV throws when a key is written again within a second
 * ("KV PUT failed: 429 Too Many Requests"): KV allows one write per key per
 * second. The daily limit throws a different message and is not retried.
 */
export function isKvRateLimited(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /\b429\b|Too Many Requests/i.test(message);
}

/** Wait before the one retry of a refused KV write: past KV's one second. */
export const KV_RETRY = { delayMs: 1100 };

/** What retryKvBusy answers when both attempts were refused. */
export const KV_BUSY = Symbol("kv_busy");

/**
 * Runs `attempt`, and once more after KV_RETRY.delayMs when KV refused a
 * write in it for the per-key limit. The extension sends a second push as
 * soon as the first answers, a friend added twice, the hub and a republished
 * look: that write lands within the second and used to come back as a 500
 * that nothing retried. `again` is true on the second run, which must build
 * what it writes from a fresh read, never re-put what the first run read (a
 * push written in between would be rolled back). The wait is wall time: no
 * CPU is billed while it runs. Any other error is thrown as is.
 */
export async function retryKvBusy<T>(
  attempt: (again: boolean) => Promise<T>,
): Promise<T | typeof KV_BUSY> {
  try {
    return await attempt(false);
  } catch (e) {
    if (!isKvRateLimited(e)) throw e;
  }
  await new Promise((resolve) => setTimeout(resolve, KV_RETRY.delayMs));
  try {
    return await attempt(true);
  } catch (e) {
    if (!isKvRateLimited(e)) throw e;
  }
  return KV_BUSY;
}

/**
 * Both runs of retryKvBusy were refused. 503 rather than 429: every build
 * files a 429 as "busy" and schedules its own retry a minute later, while
 * this clears in seconds.
 */
export const kvBusyRes = () =>
  errorRes("kv_busy", "Storage busy, retry in a few seconds", 503, {
    "Retry-After": "2",
  });

/** Env keys whose values must never appear in a response body. */
const SECRET_ENV_KEYS = ["ANNOUNCEMENT_SECRET", "FT_CLIENT_SECRET"] as const;

/**
 * Answer for an exception nothing else caught. Without it the runtime serves
 * its own HTML error page with no CORS header, which the extension can only
 * read as "could not reach the server". The body carries the message alone
 * (never the stack), cut short, with every configured secret blanked out in
 * case an upstream error echoed one back. The log line names the method and
 * path so a failing route can be told apart in Workers Logs, but never the
 * query string (login hashes, calendar tokens), and never a secret part of
 * the path either: see redactPath().
 */
/**
 * A path as it may appear in the logs: the calendar link's token (the secret
 * link itself: whoever reads it reads the feed), and login hashes (the
 * /img/<hash>/<slot> routes) are replaced by placeholders. Workers Logs keep
 * lines for days, and a D1 outage used to write every subscriber's link
 * there on each calendar refresh.
 */
export function redactPath(pathname: string): string {
  return pathname
    .replace(/^\/calendar\/[^/]+$/, "/calendar/:token.ics")
    .replace(/\/[0-9a-f]{64}(?=\/|$)/gi, "/:hash")
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=[/.]|$)/gi, "/:id");
}

export function serverErrorRes(
  e: unknown,
  env: Partial<Env>,
  request?: Request,
): Response {
  let where = "?";
  if (request) {
    let pathname = "?";
    try {
      pathname = redactPath(new URL(request.url).pathname);
    } catch {}
    where = `${request.method} ${pathname}`;
  }
  const name = e instanceof Error ? e.name : typeof e;
  let message = e instanceof Error ? e.message : String(e);
  console.error(`[worker] unhandled error: ${where} ${name}: ${message}`);
  for (const key of SECRET_ENV_KEYS) {
    const secret = env[key];
    if (typeof secret === "string" && secret.length >= 6) {
      message = message.split(secret).join("[redacted]");
    }
  }
  return jsonRes(
    { error: "server_error", message: message.slice(0, 200) },
    500,
  );
}

/**
 * The `login` query parameter is always hashLogin() output. Checking the
 * shape before the KV read keeps the user routes away from the internal keys
 * that share the namespace (INTRA_JWKS_CACHE, ANNOUNCEMENT, img:*...).
 */
export function isLoginHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/**
 * Deadline of each outbound fetch, body included (the signal also aborts the
 * body stream), in ms. Without one, a host that accepts the connection and
 * then stalls held the request until the extension gave up (10 s, 20 s for a
 * sign-in) and the client showed its "could not reach the server" text, or,
 * on the GitHub proxy, never got to the second source. Each one ends before
 * the extension's own timeout, so the client gets the worker's answer (a
 * fallback, a 502, the sign-in's 503) rather than a timeout. Mutable for the
 * tests; tests/outbound-deadline.test.ts fails on a fetch() without a signal.
 */
export const FETCH_DEADLINES = {
  /** Per source: two sources stay under campus.ts's 10 s. */
  ghSourceMs: 4_000,
  /** Keycloak's key set; the extension waits 20 s for a sign-in. */
  jwksMs: 5_000,
  /** Cluster map, redirects included (map-load.ts falls back to its cache). */
  clusterSvgMs: 8_000,
  /** Subject PDF, up to 16 MB, redirects included (workerFetch waits 10 s). */
  subjectPdfMs: 8_000,
  /** One 42 API call, token included in its own (src/ft-api.ts). */
  ftApiMs: 4_000,
};

/**
 * fetch() that only ever reaches hosts `isAllowed` accepts. Redirects are
 * followed by hand (at most `maxRedirects`) and every Location is checked like
 * the first URL, so an allowed host that redirects elsewhere cannot turn the
 * worker into a proxy for any site. Returns null when a hop is refused or the
 * chain is too long. `deadlineMs` bounds the whole chain and the reading of
 * the returned body: past it, the pending call or read throws a TimeoutError.
 */
export async function fetchAllowed(
  url: URL,
  isAllowed: (u: URL) => boolean,
  deadlineMs: number,
  init: RequestInit = {},
  maxRedirects = 3,
): Promise<Response | null> {
  const signal = AbortSignal.timeout(deadlineMs);
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowed(current)) return null;
    const res = await fetch(current.href, { ...init, redirect: "manual", signal });
    const location = res.headers.get("Location");
    if (res.status < 300 || res.status >= 400 || !location) return res;
    try {
      current = new URL(location, current);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Whole body of `res`, or null as soon as it is larger than `maxBytes`
 * (announced by Content-Length or counted while streaming), so that a huge
 * upstream file, or a huge client body, is never buffered in full.
 */
export async function readBodyCapped(
  res: Response | Request,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export type JsonBody<T> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/**
 * JSON body of a client request, or the response to send instead: 413 past
 * `maxBytes` (the body is dropped as soon as it is over, never buffered
 * whole), 400 when it is not JSON. The cap is in bytes on the wire, which is
 * what the KV record and the D1 row end up holding. `tooLarge` is the 413's
 * text, or a function building the whole response.
 */
export async function readJsonBody<T = unknown>(
  request: Request,
  maxBytes: number,
  tooLarge: string | (() => Response),
): Promise<JsonBody<T>> {
  const bytes = await readBodyCapped(request, maxBytes);
  if (!bytes) {
    const response =
      typeof tooLarge === "string" ? errorRes("too_large", tooLarge, 413) : tooLarge();
    return { ok: false, response };
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as T };
  } catch {
    return { ok: false, response: errorRes("bad_request", "Invalid JSON body", 400) };
  }
}

export function getBearerToken(request: Request): string | null {
  return (
    request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
  );
}

/**
 * Session tokens of a legacy KV record (src/sessions.ts copies them into D1
 * once). Oldest first, like the record kept them.
 */
export const getTokens = (data: any): string[] =>
  Array.isArray(data?.sessionTokens)
    ? data.sessionTokens
    : typeof data?.sessionToken === "string"
      ? [data.sessionToken]
      : [];

/**
 * The one answer of every private route that refuses a caller: missing
 * header, unknown login, wrong, revoked or expired token alike. The login
 * parameter is sha256 of a public login, so a distinct "user not found" would
 * tell anyone which students use the extension (and the calendar, the
 * tracker...).
 */
export const unauthorizedRes = () =>
  errorRes("unauthorized", "Unauthorized", 401);

/** SHA-256 of `text` (UTF-8) as 64 lowercase hex characters. */
export async function sha256Hex(text: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashLogin(login: string): Promise<string> {
  return sha256Hex(login.toLowerCase().trim());
}
