import { Env } from "../types";
import { ftGet } from "../ft-api";
import { authenticate, recordLoader, type RecordSource } from "../sessions";
import { rateLimited, tooManyRes } from "../rate-limit";
import { errorRes, hashLogin, jsonRes, methodNotAllowedRes, unauthorizedRes } from "../utils";

/**
 * GET /api/v1/private/logtime/history?login=<hash>&user=<login>[&before=<day>]
 * → {"days": {"YYYY-MM-DD": <seconds>, ...}}
 *
 * "Load older months" on your own profile: the Intra page only fetches a few
 * months of logtime, and 42's locations_stats answers the whole history in one
 * call. The shape is the one the extension's history loader always read
 * (logtime.ts fetchHistoricalLogtime). `before` is accepted and ignored: the
 * extension merges the page's own (fresher) days over these.
 *
 * Your own history only: `user` must hash to the session's login. Another
 * student's would be data about someone who never asked for it, kept on this
 * worker (42's terms, article 6), and it would spend the shared quota on every
 * profile visited.
 *
 * The answer is kept in isolate memory for an hour, so a student who reloads
 * their profile spends 42's quota once; nothing is written to KV or D1.
 */

const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { at: number; days: Record<string, number> }>();

/** For the tests. */
export function resetLogtimeHistoryCache(): void {
  cache.clear();
}

/** "HH:MM:SS(.ffffff)" → whole seconds, or null for anything else. */
function seconds(value: unknown): number | null {
  const m = /^(\d{1,3}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function toDays(data: unknown): Record<string, number> {
  const days: Record<string, number> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) return days;
  for (const [day, value] of Object.entries(data)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const s = seconds(value);
    if (s !== null && s > 0) days[day] = s;
  }
  return days;
}

export async function handleLogtimeHistory(
  request: Request,
  env: Env,
  loginParam: string,
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowedRes();
  const session = await authenticate(request, env, loginParam, recordLoader(source));
  if (!session) return unauthorizedRes();

  const user = (new URL(request.url).searchParams.get("user") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(user)) {
    return errorRes("bad_request", "Invalid user", 400);
  }
  if ((await hashLogin(user)) !== loginParam) {
    return errorRes("unauthorized", "Only your own logtime history is available", 403);
  }

  const hit = cache.get(loginParam);
  if (hit && Date.now() - hit.at < CACHE_MS) return jsonRes({ days: hit.days });

  if (await rateLimited(env, "write", loginParam)) return tooManyRes();
  const res = await ftGet(env, `/v2/users/${encodeURIComponent(user)}/locations_stats`);
  if (!res.ok) {
    if (res.reason === "quota") {
      return errorRes("rate_limited", "The 42 API quota is spent, try again later", 429, {
        "Retry-After": "600",
      });
    }
    if (res.reason === "not_found") return errorRes("not_found", "Unknown login on 42", 404);
    return errorRes("server_error", "The 42 API did not answer", 502);
  }

  const days = toDays(res.data);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(loginParam, { at: Date.now(), days });
  return jsonRes({ days });
}
