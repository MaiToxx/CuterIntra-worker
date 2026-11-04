/**
 * Login without a 42 OAuth application.
 *
 * The Intra v3 front-end authenticates its own API calls with a Keycloak JWT
 * (realm "students-42" on auth.42.fr). The extension already sees that token
 * on every Intra page. This endpoint verifies the token's RS256 signature
 * against Keycloak's public keys (JWKS), checks issuer and expiry, and opens a
 * Cuter Intra session for the login carried by the token, exactly like the
 * OAuth callback does, minus the 42 API tokens (features that call the 42
 * API server-side stay unavailable on such sessions). The session lives in D1
 * (src/sessions.ts); the KV record is only written by a first sign-in.
 *
 *   POST /auth/intra   { "token": "Bearer eyJ..." }
 *   -> { "token": "<session token>", "login": "<intra login>" }
 */
import { Env, UserData } from "../types";
import { DAILY_KV_WRITES_SIGN_IN, spendKvWrite } from "../budget";
import { clientKey, rateLimited, tooManyRes } from "../rate-limit";
import { createSession } from "../sessions";
import {
  errorRes,
  FETCH_DEADLINES,
  hashLogin,
  jsonRes,
  KV_BUSY,
  methodNotAllowedRes,
  readJsonBody,
  retryKvBusy,
} from "../utils";

export const INTRA_ISSUER = "https://auth.42.fr/auth/realms/students-42";
const JWKS_URL = `${INTRA_ISSUER}/protocol/openid-connect/certs`;
const JWKS_CACHE_KEY = "INTRA_JWKS_CACHE";
const JWKS_TTL_S = 6 * 60 * 60;
/**
 * A token whose `kid` is missing from the cached key set triggers a refetch of
 * the JWKS (Keycloak rotates keys), but this endpoint is unauthenticated: an
 * attacker must not be able to make the worker hammer auth.42.fr and rewrite
 * KV on every request. Refetches are throttled per isolate, and a fetched key
 * set only reaches KV once a token verified with it (see handleIntraAuth).
 */
export const JWKS_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Largest sign-in body read. The route is unauthenticated, so the body must
 * never be buffered whole: a Keycloak access token is 1 to 3 KB, and 32 KB
 * leaves room for one carrying many roles or groups.
 */
export const MAX_AUTH_BODY_BYTES = 32 * 1024;

export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export interface VerifiedIntraToken {
  login: string;
  sub: string;
  exp: number;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  exp?: number;
  sub?: string;
  /** Client the token was issued to ("frontend-react" for the Intra v3). */
  azp?: unknown;
  preferred_username?: string;
  login?: string;
}

interface DecodedJwt {
  h: string;
  p: string;
  s: string;
  header: JwtHeader;
  payload: JwtPayload;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const HASH_FOR_ALG: Record<string, string> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
};

/**
 * Split and decode a compact JWT without verifying it. Returns null when the
 * token is not three base64url segments with JSON header and payload objects.
 */
export function decodeJwt(rawToken: string): DecodedJwt | null {
  const token = rawToken.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (!header || typeof header !== "object") return null;
    if (!payload || typeof payload !== "object") return null;
    return { h, p, s, header, payload };
  } catch {
    return null;
  }
}

/** Cheap claim checks that need no key material: algorithm, issuer, expiry. */
function checkClaims(decoded: DecodedJwt, now: number): boolean {
  const { header, payload } = decoded;
  if (!header.alg || !HASH_FOR_ALG[header.alg]) return false;
  if (payload.iss !== INTRA_ISSUER) return false;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return false;
  return true;
}

/**
 * Whether the client a token was issued to (`azp`) may sign in. `allowed`
 * is JWT_ALLOWED_AZP, comma-separated. Every client of the students-42 realm
 * gets tokens signed with the same key and carrying the same login, but the
 * extension only ever sends the Intra v3 front-end's (profile-v3, client
 * "frontend-react", read from its public bundle): pinning it means a token
 * leaked by, or issued to, any other client of the realm opens no session
 * here. Empty or missing turns the check off, so a 42 rename that refuses
 * every sign-in is undone by editing the variable, without new code.
 */
export function azpAllowed(azp: unknown, allowed: string | undefined): boolean {
  const clients = (allowed ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (clients.length === 0) return true;
  return typeof azp === "string" && clients.includes(azp);
}

/**
 * Verify a Keycloak access token with the given key set. Returns the identity
 * or null when anything (format, algorithm, key, signature, issuer, expiry,
 * missing login) is off. Never throws on malformed input.
 */
export async function verifyIntraJwt(
  rawToken: string,
  jwks: Jwk[],
  now: number = Date.now(),
): Promise<VerifiedIntraToken | null> {
  const decoded = decodeJwt(rawToken);
  if (!decoded) return null;
  // issuer and expiry are checked before any key work: an expired or foreign
  // token never costs a key import or a signature check
  if (!checkClaims(decoded, now)) return null;
  const { h, p, s, header, payload } = decoded;
  const hash = HASH_FOR_ALG[header.alg as string];

  const key = jwks.find(
    (k) =>
      k.kty === "RSA" &&
      (k.use === undefined || k.use === "sig") &&
      (header.kid === undefined || k.kid === header.kid) &&
      k.n &&
      k.e,
  );
  if (!key) return null;

  let ok: boolean;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e, alg: header.alg, ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
    // b64urlDecode throws on a non-base64 signature segment: that is a bad
    // token (401), not a server error
    const signature = b64urlDecode(s);
    ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signature,
      new TextEncoder().encode(`${h}.${p}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  const login = (payload.preferred_username || payload.login || "").trim();
  if (!/^[a-z0-9_.-]{2,64}$/i.test(login)) return null;

  return { login, sub: String(payload.sub || ""), exp: payload.exp as number };
}

/**
 * Under a deadline, body included: a stalled auth.42.fr used to hold the
 * sign-in until the extension's 20 s timeout, which it reads as "could not
 * reach the Cuter Intra server, check the site permission". A throw here is
 * the 503 every build reads as "42's key server did not answer".
 */
async function fetchJwks(): Promise<Jwk[]> {
  const res = await fetch(JWKS_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_DEADLINES.jwksMs),
  });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(data.keys)) throw new Error("JWKS: no keys");
  return data.keys;
}

/** Wall-clock time of the last JWKS fetch made by this isolate (0 = never). */
let lastJwksFetchAt = 0;

/**
 * Key set this isolate last fetched from Keycloak. A forged token can make the
 * worker fetch the JWKS but never store it (KV writes are capped at 1,000 a
 * day for the whole namespace), so the fetched set is kept here, where the
 * next token, forged or not, finds it without another request.
 */
let fetchedJwks: { keys: Jwk[]; at: number } | null = null;

/** Test hook: forget the last fetch so a refresh is allowed again. */
export function resetJwksRefreshThrottle(): void {
  lastJwksFetchAt = 0;
  fetchedJwks = null;
}

interface KeySets {
  /** Keys to verify the token with. */
  keys: Jwk[];
  /** What KV holds, to tell whether `keys` is worth storing. */
  stored: Jwk[] | null;
}

/**
 * Key set to verify a token with: the KV copy, else this isolate's last fetch,
 * whichever knows the token's `kid`. When neither does (a rotated key, an empty
 * cache) the JWKS is refetched, at most once per JWKS_REFRESH_MIN_INTERVAL_MS
 * per isolate; inside that window the token is verified against what is known
 * (and fails). Throws when a needed fetch fails, or failed and nothing is known.
 */
async function getJwksForToken(env: Env, kid: string | undefined, now: number): Promise<KeySets> {
  const raw = await env.BETTER_INTRA_KV.get(JWKS_CACHE_KEY, { type: "json" });
  const stored = Array.isArray(raw) && raw.length > 0 ? (raw as Jwk[]) : null;
  if (fetchedJwks && now - fetchedJwks.at > JWKS_TTL_S * 1000) fetchedJwks = null;
  const memory = fetchedJwks?.keys ?? null;

  const knows = (set: Jwk[] | null): set is Jwk[] =>
    !!set && (kid === undefined ? set.length > 0 : set.some((k) => k.kid === kid));
  if (knows(stored)) return { keys: stored, stored };
  if (knows(memory)) return { keys: memory, stored };
  if (now - lastJwksFetchAt < JWKS_REFRESH_MIN_INTERVAL_MS) {
    const known = stored ?? memory;
    // No key at all means the last fetch failed: say so rather than "invalid"
    if (!known) throw new Error("JWKS unavailable, last fetch failed");
    return { keys: known, stored };
  }

  lastJwksFetchAt = now;
  const keys = await fetchJwks();
  fetchedJwks = { keys, at: now };
  return { keys, stored };
}

/**
 * Store the key set a token was just verified with, when KV does not already
 * hold it. Best effort: a failed cache write must not fail the sign-in.
 */
async function storeJwks(env: Env, sets: KeySets): Promise<void> {
  if (sets.stored && JSON.stringify(sets.stored) === JSON.stringify(sets.keys)) return;
  try {
    await env.BETTER_INTRA_KV.put(JWKS_CACHE_KEY, JSON.stringify(sets.keys), {
      expirationTtl: JWKS_TTL_S,
    });
  } catch (e) {
    console.warn(`[intra-auth] JWKS cache write failed: ${e}`);
  }
}

/** One answer for every token that does not open a session. */
const invalidTokenRes = () =>
  errorRes("unauthorized", "Invalid or expired Intra token", 401);

export async function handleIntraAuth(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowedRes();

  // Capped before anything else: request.json() buffered and parsed a body
  // of any size ahead of the per-IP limiter below.
  const body = await readJsonBody<{ token?: unknown } | null>(
    request,
    MAX_AUTH_BODY_BYTES,
    "Body too large",
  );
  if (!body.ok) return body.response;
  const token = body.value?.token;
  if (typeof token !== "string" || token.length < 20) {
    return errorRes("bad_request", "Missing token", 400);
  }

  const now = Date.now();
  // Reject garbage, expired and foreign tokens before touching KV or the JWKS
  // endpoint: this route is unauthenticated.
  const decoded = decodeJwt(token);
  if (!decoded || !checkClaims(decoded, now)) {
    return invalidTokenRes();
  }
  // Per IP, before any JWKS work: well-formed garbage must not turn into a
  // stream of key lookups (see src/rate-limit.ts for the limits).
  if (await rateLimited(env, "anon", clientKey(request.headers.get("CF-Connecting-IP")))) {
    return tooManyRes();
  }

  let sets: KeySets;
  try {
    sets = await getJwksForToken(env, decoded.header.kid, now);
  } catch (e) {
    console.warn(`[intra-auth] JWKS fetch failed: ${e}`);
    // 503 is what every extension build reads as "42's key server did not
    // answer"; the code is the generic one, nothing the client can act on.
    return errorRes("server_error", "Intra key server unreachable, retry in a minute", 503);
  }
  const verified = await verifyIntraJwt(token, sets.keys, now);
  // Nothing is written before this point: a forged or invalid token never
  // costs a KV write.
  if (!verified) return invalidTokenRes();
  // Checked on a verified token, so that the log line below only ever names
  // a client 42 really issued a token to (a rename shows up in Workers Logs),
  // never whatever a forger wrote. The id alone: never the token or login.
  if (!azpAllowed(decoded.payload.azp, env.JWT_ALLOWED_AZP)) {
    const client = JSON.stringify(String(decoded.payload.azp ?? "none").slice(0, 64));
    console.warn(`[intra-auth] token refused: client ${client} is not in JWT_ALLOWED_AZP`);
    return invalidTokenRes();
  }

  const rawLogin = verified.login;
  const hashedLogin = await hashLogin(rawLogin);
  // Per login, once the token is known to be theirs: a student replaying
  // their own valid token in a loop would otherwise spend D1 writes per call,
  // and a first sign-in a KV write, out of the budgets shared by every user.
  if (await rateLimited(env, "write", hashedLogin)) return tooManyRes();
  await storeJwks(env, sets);

  // Read for two things: a login still listed in KV has its tokens copied
  // to D1 with the new session (so the other browsers stay signed in), and a
  // first sign-in creates the record. Nothing else in it changes: a sign-in
  // no longer rewrites the settings from a read that may be stale.
  const existing: UserData | null = await env.BETTER_INTRA_KV.get(hashedLogin, {
    type: "json",
  });
  // D1 first: if it fails, no KV write was spent on a sign-in that answers
  // 500. A token whose record then fails to be created is never handed out.
  const session = await createSession(env, hashedLogin, existing);
  // Only with the login's first live session (a first sign-in, or one after
  // a wipe). A location caches a miss too: next to a live session, "no
  // record" is more likely a stale copy from before the first sign-in than a
  // missing record, and writing {settings: {}} would erase the backup. A
  // record that is really missing costs nothing: the settings read answers
  // {} and the next push creates it.
  if (!existing && session.first) await createRecord(env, hashedLogin);

  // The users row only feeds the community counter (/api/v1/public/stats).
  // The session is stored by now: a D1 error here must not turn a verified
  // sign-in into a 500, which the extension shows as a failed login while
  // the new session sits orphaned. No country is kept: nothing the
  // extension does needs one. Only the first sign-in writes a row.
  try {
    await env.better_intra_d1
      .prepare("INSERT OR IGNORE INTO users (hash) VALUES (?)")
      .bind(hashedLogin)
      .run();
  } catch (e) {
    console.warn(`[intra-auth] users row insert failed: ${e}`);
  }

  return jsonRes({ token: session.token, login: rawLogin });
}

/**
 * The empty record of a first sign-in. Optional since sessions moved to D1
 * (the session and its marker are stored by now, and a missing record reads
 * as empty settings until the first push creates it), so the sign-in never
 * fails for it: past the day's write budget, or with KV refusing the key
 * twice, the record is left for the first push, and the student is signed in
 * anyway. A 503 here would read as "42's key server did not answer" in every
 * extension build, and the student could do nothing at all.
 */
async function createRecord(env: Env, hashedLogin: string): Promise<void> {
  if (!(await spendKvWrite(env, hashedLogin, { globalCap: DAILY_KV_WRITES_SIGN_IN }))) {
    console.warn("[intra-auth] daily write budget reached: first record left to the first push");
    return;
  }
  const done = await retryKvBusy(async (again) => {
    // Refused for the per-key limit: something wrote this key within the
    // second, most likely the student's first push. Never overwrite it.
    if (again && (await env.BETTER_INTRA_KV.get(hashedLogin))) return;
    await env.BETTER_INTRA_KV.put(hashedLogin, JSON.stringify({ settings: {} }));
  });
  if (done === KV_BUSY) {
    console.warn("[intra-auth] KV busy: first record left to the first push");
  }
}
