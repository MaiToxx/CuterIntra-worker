import { Env } from "../types";
import { ftGet, type FtResult } from "../ft-api";
import { authenticate, recordLoader, type RecordSource } from "../sessions";
import { rateLimited, tooManyRes } from "../rate-limit";
import { errorRes, hashLogin, jsonRes, methodNotAllowedRes, unauthorizedRes } from "../utils";

/**
 * GET /api/v1/private/coalitions?login=<hash>&user=<login>
 *
 * The standings of your coalitions, read with the worker's 42 application:
 * {"blocs": [{"id", "cursusId", "coalitions": [{"id", "name", "score",
 * "color", "imageUrl", "mine"}]}]}, one bloc per coalition you belong to (the
 * Piscine and the common core have their own), coalitions by score, highest
 * first. No student is named: a coalition's leader is left out.
 *
 * Your own login only, as for the evaluations (42's terms, article 6; and the
 * shared quota). Cost: your campus and coalitions (2 requests, kept 6 hours
 * per login), then the campus blocs (1 request, kept 15 minutes per campus
 * and shared by every student there). Isolate memory only.
 */

const MEMBERSHIP_CACHE_MS = 6 * 60 * 60_000;
const BLOCS_CACHE_MS = 15 * 60_000;
const CACHE_MAX = 200;

export interface Coalition {
  id: number;
  name: string;
  score: number;
  color: string | null;
  imageUrl: string | null;
  mine: boolean;
}
export interface Bloc {
  id: number;
  cursusId: number | null;
  coalitions: Coalition[];
}
type Membership = { campusId: number; coalitionIds: number[] };
type RawBloc = { id: number; cursusId: number | null; coalitions: Omit<Coalition, "mine">[] };

const memberships = new Map<string, { at: number; value: Membership }>();
const blocsByCampus = new Map<number, { at: number; value: RawBloc[] }>();

/** For the tests. */
export function resetCoalitionsCache(): void {
  memberships.clear();
  blocsByCampus.clear();
}

function remember<K, T>(map: Map<K, { at: number; value: T }>, key: K, value: T): void {
  map.delete(key);
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value!);
  map.set(key, { at: Date.now(), value });
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

const objects = (data: unknown): Record<string, unknown>[] =>
  Array.isArray(data) ? data.filter((x) => x && typeof x === "object") : [];

/** Only Intra's own CDN, over https: the extension draws it as an image. */
export function safeImageUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 300) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "cdn.intra.42.fr" ? u.href : null;
  } catch {
    return null;
  }
}

export function parseBlocs(data: unknown): RawBloc[] {
  const out: RawBloc[] = [];
  for (const b of objects(data)) {
    if (typeof b.id !== "number") continue;
    const coalitions: Omit<Coalition, "mine">[] = [];
    for (const c of objects(b.coalitions)) {
      if (typeof c.id !== "number" || typeof c.name !== "string") continue;
      coalitions.push({
        id: c.id,
        name: c.name.slice(0, 60),
        score: typeof c.score === "number" && Number.isFinite(c.score) ? c.score : 0,
        color:
          typeof c.color === "string" && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color.toUpperCase() : null,
        imageUrl: safeImageUrl(c.image_url),
      });
    }
    coalitions.sort((a, b) => b.score - a.score);
    out.push({ id: b.id, cursusId: typeof b.cursus_id === "number" ? b.cursus_id : null, coalitions });
  }
  return out;
}

async function readMembership(env: Env, user: string): Promise<Membership | Response> {
  const base = `/v2/users/${encodeURIComponent(user)}`;
  const campus = await ftGet(env, `${base}/campus_users`);
  if (!campus.ok) return failure(campus);
  const links = objects(campus.data);
  const primary = links.find((c) => c.is_primary === true) ?? links[0];
  const campusId = Number(primary?.campus_id);
  const coalitions = await ftGet(env, `${base}/coalitions`);
  if (!coalitions.ok) return failure(coalitions);
  return {
    campusId: Number.isInteger(campusId) && campusId > 0 ? campusId : 0,
    coalitionIds: objects(coalitions.data)
      .map((c) => c.id)
      .filter((id): id is number => typeof id === "number"),
  };
}

export async function handleCoalitions(
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
    return errorRes("unauthorized", "Only your own coalitions are available", 403);
  }

  const now = Date.now();
  let membership = memberships.get(loginParam);
  const membershipFresh = membership && now - membership.at < MEMBERSHIP_CACHE_MS;
  const blocsHit = membershipFresh ? blocsByCampus.get(membership!.value.campusId) : undefined;
  const blocsFresh = blocsHit && now - blocsHit.at < BLOCS_CACHE_MS;
  // Only a request that calls 42 spends the write budget.
  if ((!membershipFresh || !blocsFresh) && (await rateLimited(env, "write", loginParam))) {
    return tooManyRes();
  }

  if (!membershipFresh) {
    const value = await readMembership(env, user);
    if (value instanceof Response) return value;
    remember(memberships, loginParam, value);
    membership = memberships.get(loginParam)!;
  }
  const { campusId, coalitionIds } = membership!.value;
  if (!campusId || coalitionIds.length === 0) return jsonRes({ blocs: [] });

  let blocs = blocsByCampus.get(campusId);
  if (!blocs || Date.now() - blocs.at >= BLOCS_CACHE_MS) {
    const res = await ftGet(env, `/v2/blocs?filter[campus_id]=${campusId}&page[size]=100`);
    if (!res.ok) return failure(res);
    remember(blocsByCampus, campusId, parseBlocs(res.data));
    blocs = blocsByCampus.get(campusId)!;
  }

  const mine = new Set(coalitionIds);
  return jsonRes({
    blocs: blocs.value
      .filter((b) => b.coalitions.some((c) => mine.has(c.id)))
      .map((b) => ({ ...b, coalitions: b.coalitions.map((c) => ({ ...c, mine: mine.has(c.id) })) })),
  });
}
