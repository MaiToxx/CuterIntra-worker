import { Env } from "../types";
import { ftGet, type FtResult } from "../ft-api";
import { authenticate, recordLoader, type RecordSource } from "../sessions";
import { rateLimited, tooManyRes } from "../rate-limit";
import { errorRes, hashLogin, jsonRes, methodNotAllowedRes, unauthorizedRes } from "../utils";

/**
 * GET /api/v1/private/evaluations?login=<hash>&user=<login>&part=stats|upcoming|points
 *
 * Your own evaluations, read with the worker's 42 application (no user token):
 *
 * - part=stats → {"stats": {"byMonth": {"YYYY-MM": {total, failed,
 *   successPercentage}}, "global": {...}}, "outstanding": {"received": n,
 *   "given": n}}. The correction statistics the extension used to build from
 *   up to 40 v2 feedback pages (profile-stats-intra.ts), in the same shape,
 *   from /scale_teams/as_corrector (100 a page). An evaluation is failed below
 *   50 %, or by its flag when it has no mark. "outstanding" counts the
 *   Outstanding flags (id 9) you received and gave.
 * - part=upcoming → {"upcoming": [{"id", "beginAt", "endAt", "role":
 *   "corrector"|"corrected", "project": <name>|null}]}: your booked
 *   evaluations of the next 14 days, for the calendar feed's reminders. No
 *   other student's login is returned: the feed is stored on this worker.
 * - part=points → {"points": [{"at": <ISO>, "total": n}]}: your correction
 *   point balance after each change, oldest first, from
 *   /correction_point_historics (the last 1,000 changes at most), for the
 *   dashboard's graph. Reasons are left out: the graph only needs the curve.
 *
 * Your own data only, as for the logtime history: `user` must hash to the
 * session's login (42's terms, article 6; and the shared quota). Answers are
 * kept in isolate memory, stats and points an hour, upcoming ten minutes; nothing is
 * written to KV or D1.
 */

const STATS_CACHE_MS = 60 * 60_000;
const UPCOMING_CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;
/** as_corrector pages read at most (100 evaluations each). */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const UPCOMING_DAYS = 14;
const OUTSTANDING_FLAG_ID = 9;
const PROJECT_NAMES_MAX = 500;

type MonthStats = { total: number; failed: number; successPercentage: number | null };
export interface EvalStats {
  byMonth: Record<string, MonthStats>;
  global: MonthStats;
}
export interface StatsPart {
  stats: EvalStats;
  outstanding: { received: number; given: number };
}
export interface PointsEntry {
  at: string;
  total: number;
}
export interface UpcomingEvaluation {
  id: number;
  beginAt: string;
  endAt: string;
  role: "corrector" | "corrected";
  project: string | null;
}

const statsCache = new Map<string, { at: number; value: StatsPart }>();
const upcomingCache = new Map<string, { at: number; value: UpcomingEvaluation[] }>();
const pointsCache = new Map<string, { at: number; value: PointsEntry[] }>();
/** Project id → name: names do not change, and one costs a request. */
const projectNames = new Map<number, string>();

/** For the tests. */
export function resetEvaluationsCache(): void {
  statsCache.clear();
  upcomingCache.clear();
  pointsCache.clear();
  projectNames.clear();
}

function remember<T>(map: Map<string, { at: number; value: T }>, key: string, value: T): void {
  map.delete(key);
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value!);
  map.set(key, { at: Date.now(), value });
}

interface ScaleTeam {
  id?: unknown;
  begin_at?: unknown;
  final_mark?: unknown;
  flag?: { id?: unknown; positive?: unknown } | null;
  corrector?: unknown;
  scale?: { duration?: unknown } | null;
  team?: { project_id?: unknown } | null;
}

function asList(data: unknown): ScaleTeam[] {
  return Array.isArray(data) ? (data.filter((x) => x && typeof x === "object") as ScaleTeam[]) : [];
}

/** Same rule and rounding as the extension's computeEvalStats(). */
export function computeStats(teams: ScaleTeam[]): EvalStats {
  const byMonth: Record<string, MonthStats> = {};
  const global: MonthStats = { total: 0, failed: 0, successPercentage: null };
  for (const t of teams) {
    if (typeof t.begin_at !== "string" || !/^\d{4}-\d{2}/.test(t.begin_at)) continue;
    const mark = typeof t.final_mark === "number" ? t.final_mark : null;
    // Not filled in yet: neither a pass nor a fail.
    if (mark === null && !t.flag) continue;
    const failed = mark !== null ? mark < 50 : t.flag?.positive !== true;
    const month = t.begin_at.slice(0, 7);
    const m = (byMonth[month] ??= { total: 0, failed: 0, successPercentage: null });
    m.total += 1;
    global.total += 1;
    if (failed) {
      m.failed += 1;
      global.failed += 1;
    }
  }
  const pct = (s: MonthStats) =>
    s.total > 0 ? Math.round(((s.total - s.failed) / s.total) * 1000) / 10 : null;
  for (const m of Object.values(byMonth)) m.successPercentage = pct(m);
  global.successPercentage = pct(global);
  return { byMonth, global };
}

function isOutstanding(t: ScaleTeam): boolean {
  return t.flag?.id === OUTSTANDING_FLAG_ID;
}

function failure(res: Extract<FtResult, { ok: false }>): Response {
  if (res.reason === "quota") {
    return errorRes("rate_limited", "The 42 API quota is spent, try again later", 429, {
      "Retry-After": "600",
    });
  }
  if (res.reason === "not_found") return errorRes("not_found", "Unknown login on 42", 404);
  return errorRes("server_error", "The 42 API did not answer", 502);
}

async function readStats(env: Env, user: string): Promise<StatsPart | Response> {
  const base = `/v2/users/${encodeURIComponent(user)}/scale_teams`;
  const given: ScaleTeam[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ftGet(env, `${base}/as_corrector?page[size]=${PAGE_SIZE}&page[number]=${page}`);
    if (!res.ok) return failure(res);
    const batch = asList(res.data);
    given.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    // Past the cap the totals would be too low and still look real.
    if (page === MAX_PAGES) return errorRes("server_error", "Too many evaluations to count", 502);
  }
  const received = await ftGet(
    env,
    `${base}/as_corrected?filter[flag_id]=${OUTSTANDING_FLAG_ID}&page[size]=${PAGE_SIZE}`,
  );
  if (!received.ok) return failure(received);
  return {
    stats: computeStats(given),
    outstanding: {
      received: asList(received.data).filter(isOutstanding).length,
      given: given.filter(isOutstanding).length,
    },
  };
}

/**
 * Your balance after each change, oldest first. Newest pages first, so a long
 * history keeps its recent end: the graph needs that part most.
 */
async function readPoints(env: Env, user: string): Promise<PointsEntry[] | Response> {
  const out: PointsEntry[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ftGet(
      env,
      `/v2/users/${encodeURIComponent(user)}/correction_point_historics?sort=-created_at&page[size]=${PAGE_SIZE}&page[number]=${page}`,
    );
    if (!res.ok) return failure(res);
    const batch = Array.isArray(res.data) ? res.data : [];
    for (const h of batch as { created_at?: unknown; total?: unknown }[]) {
      if (!h || typeof h.created_at !== "string" || typeof h.total !== "number") continue;
      const at = Date.parse(h.created_at);
      if (!Number.isFinite(at)) continue;
      out.push({ at: new Date(at).toISOString(), total: h.total });
    }
    if (batch.length < PAGE_SIZE) break;
  }
  return out.reverse();
}

async function projectName(env: Env, id: number): Promise<string | null> {
  const known = projectNames.get(id);
  if (known !== undefined) return known;
  const res = await ftGet(env, `/v2/projects/${id}`);
  if (!res.ok) return null;
  const name = (res.data as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || !name) return null;
  if (projectNames.size >= PROJECT_NAMES_MAX) projectNames.clear();
  projectNames.set(id, name.slice(0, 120));
  return projectNames.get(id)!;
}

function correctorLogin(corrector: unknown): string | null {
  if (corrector && typeof corrector === "object") {
    const login = (corrector as { login?: unknown }).login;
    return typeof login === "string" ? login.toLowerCase() : null;
  }
  return null;
}

async function readUpcoming(env: Env, user: string): Promise<UpcomingEvaluation[] | Response> {
  const now = new Date();
  const until = new Date(now.getTime() + UPCOMING_DAYS * 86_400_000);
  const res = await ftGet(
    env,
    `/v2/users/${encodeURIComponent(user)}/scale_teams?range[begin_at]=${now.toISOString()},${until.toISOString()}&page[size]=${PAGE_SIZE}`,
  );
  if (!res.ok) return failure(res);
  const out: UpcomingEvaluation[] = [];
  for (const t of asList(res.data)) {
    if (typeof t.id !== "number" || typeof t.begin_at !== "string") continue;
    const begin = Date.parse(t.begin_at);
    if (!Number.isFinite(begin)) continue;
    const duration = Number(t.scale?.duration);
    const end = begin + (duration > 0 ? duration : 900) * 1000;
    const projectId = Number(t.team?.project_id);
    out.push({
      id: t.id,
      beginAt: new Date(begin).toISOString(),
      endAt: new Date(end).toISOString(),
      // Before 42 reveals the corrector, `corrector` is not an object with
      // your login: you are the one being evaluated.
      role: correctorLogin(t.corrector) === user ? "corrector" : "corrected",
      project: projectId > 0 ? await projectName(env, projectId) : null,
    });
  }
  out.sort((a, b) => a.beginAt.localeCompare(b.beginAt));
  return out;
}

export async function handleEvaluations(
  request: Request,
  env: Env,
  loginParam: string,
  source: RecordSource,
): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowedRes();
  const session = await authenticate(request, env, loginParam, recordLoader(source));
  if (!session) return unauthorizedRes();

  const params = new URL(request.url).searchParams;
  const user = (params.get("user") ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(user)) {
    return errorRes("bad_request", "Invalid user", 400);
  }
  const part = params.get("part");
  if (part !== "stats" && part !== "upcoming" && part !== "points") {
    return errorRes("bad_request", "part must be stats, upcoming or points", 400);
  }
  if ((await hashLogin(user)) !== loginParam) {
    return errorRes("unauthorized", "Only your own evaluations are available", 403);
  }

  if (part === "stats") {
    const hit = statsCache.get(loginParam);
    if (hit && Date.now() - hit.at < STATS_CACHE_MS) return jsonRes(hit.value);
    if (await rateLimited(env, "write", loginParam)) return tooManyRes();
    const value = await readStats(env, user);
    if (value instanceof Response) return value;
    remember(statsCache, loginParam, value);
    return jsonRes(value);
  }

  if (part === "points") {
    const hit = pointsCache.get(loginParam);
    if (hit && Date.now() - hit.at < STATS_CACHE_MS) return jsonRes({ points: hit.value });
    if (await rateLimited(env, "write", loginParam)) return tooManyRes();
    const value = await readPoints(env, user);
    if (value instanceof Response) return value;
    remember(pointsCache, loginParam, value);
    return jsonRes({ points: value });
  }

  const hit = upcomingCache.get(loginParam);
  if (hit && Date.now() - hit.at < UPCOMING_CACHE_MS) return jsonRes({ upcoming: hit.value });
  if (await rateLimited(env, "write", loginParam)) return tooManyRes();
  const value = await readUpcoming(env, user);
  if (value instanceof Response) return value;
  remember(upcomingCache, loginParam, value);
  return jsonRes({ upcoming: value });
}
