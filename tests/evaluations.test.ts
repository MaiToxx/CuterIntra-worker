import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { resetFtApi } from "../src/ft-api";
import { computeStats, resetEvaluationsCache } from "../src/handlers/evaluations";
import { resetRateLimits } from "../src/rate-limit";
// tokenHash is plain SHA-256 hex, the same as a login hash
import { addSession, makeEnv, tokenHash } from "./helpers/fake-env";

const USER = "alepayen";
const LOGIN = tokenHash(USER);
const SESSION = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP = { FT_CLIENT_ID: "u-s4t2ud-" + "a".repeat(64), FT_CLIENT_SECRET: "s-s4t2ud-" + "b".repeat(64) };
const auth = { Authorization: `Bearer ${SESSION}` };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "x-hourly-ratelimit-remaining": "1100" },
  });
const tokenRes = () => json({ access_token: "app-token", expires_in: 7200 });

function signedIn(vars = APP) {
  const made = makeEnv({ vars });
  addSession(made.d1, LOGIN, SESSION);
  return made;
}

const evaluations = (env: unknown, part: string, user = USER) =>
  worker.fetch(
    new Request(`https://w.test/api/v1/private/evaluations?login=${LOGIN}&user=${user}&part=${part}`, {
      headers: auth,
    }),
    env as never,
  );

const team = (begin_at: string, final_mark: number | null, flag: { id: number; positive: boolean } | null) => ({
  id: Math.floor(Math.random() * 1e6),
  begin_at,
  final_mark,
  flag,
  corrector: { login: USER },
  scale: { duration: 900 },
  team: { project_id: 1264 },
});
const OK = { id: 1, positive: true };
const OUTSTANDING = { id: 9, positive: true };
const EMPTY = { id: 2, positive: false };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetFtApi();
  resetEvaluationsCache();
  resetRateLimits();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("computeStats", () => {
  it("counts by month, fails below 50 %, by flag without a mark, skips unfilled", () => {
    const stats = computeStats([
      team("2026-09-02T10:00:00.000Z", 100, OK),
      team("2026-09-03T10:00:00.000Z", 20, EMPTY),
      team("2026-10-01T10:00:00.000Z", null, EMPTY),
      team("2026-10-02T10:00:00.000Z", null, null),
    ]);
    expect(stats.byMonth).toEqual({
      "2026-09": { total: 2, failed: 1, successPercentage: 50 },
      "2026-10": { total: 1, failed: 1, successPercentage: 0 },
    });
    expect(stats.global).toEqual({ total: 3, failed: 2, successPercentage: 33.3 });
  });
});

describe("GET /api/v1/private/evaluations", () => {
  it("does not exist without the 42 application, before any read", async () => {
    const { env, d1 } = signedIn({} as typeof APP);
    const res = await evaluations(env, "stats");
    expect(res.status).toBe(404);
    expect(d1.prepared).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is announced by /features", async () => {
    const { env } = signedIn();
    const res = await worker.fetch(new Request("https://w.test/api/v1/public/features"), env as never);
    expect(await res.json()).toEqual({ features: { logtimeHistory: true, evaluations: true, correctionPoints: true, coalitions: true } });
  });

  it("answers stats and outstanding counts from as_corrector and as_corrected", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(
        json([team("2026-09-02T10:00:00.000Z", 100, OUTSTANDING), team("2026-09-03T10:00:00.000Z", 40, EMPTY)]),
      )
      .mockResolvedValueOnce(json([team("2026-08-01T10:00:00.000Z", 125, OUTSTANDING)]));
    const { env } = signedIn();
    const res = await evaluations(env, "stats");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stats: {
        byMonth: { "2026-09": { total: 2, failed: 1, successPercentage: 50 } },
        global: { total: 2, failed: 1, successPercentage: 50 },
      },
      outstanding: { received: 1, given: 1 },
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://api.intra.42.fr/v2/users/${USER}/scale_teams/as_corrector?page[size]=100&page[number]=1`,
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      `https://api.intra.42.fr/v2/users/${USER}/scale_teams/as_corrected?filter[flag_id]=9&page[size]=100`,
    );

    // An hour in memory: no new call.
    await evaluations(env, "stats");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("answers upcoming evaluations with the role and the project name, no other login", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(
        json([
          { ...team("2026-11-06T14:00:00.000Z", null, null), id: 2, corrector: "invisible" },
          { ...team("2026-11-05T09:00:00.000Z", null, null), id: 1, correcteds: [{ login: "bob" }] },
        ]),
      )
      .mockResolvedValueOnce(json({ id: 1264, name: "C Piscine C 08" }));
    const { env } = signedIn();
    const res = await evaluations(env, "upcoming");
    const body = (await res.json()) as { upcoming: unknown[] };
    expect(body.upcoming).toEqual([
      {
        id: 1,
        beginAt: "2026-11-05T09:00:00.000Z",
        endAt: "2026-11-05T09:15:00.000Z",
        role: "corrector",
        project: "C Piscine C 08",
      },
      {
        id: 2,
        beginAt: "2026-11-06T14:00:00.000Z",
        endAt: "2026-11-06T14:15:00.000Z",
        role: "corrected",
        project: "C Piscine C 08",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("bob");
    expect(String(fetchMock.mock.calls[1][0])).toMatch(
      /\/v2\/users\/alepayen\/scale_teams\?range\[begin_at\]=[^,]+,[^&]+&page\[size\]=100$/,
    );
    // The project name is asked once.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("answers the correction point balance oldest first, without the reasons", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 - i,
      reason: "Earning after defense",
      sum: 1,
      total: 200 - i,
      created_at: new Date(Date.UTC(2026, 9, 1) - i * 3_600_000).toISOString(),
    }));
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(page1))
      .mockResolvedValueOnce(
        json([
          { id: 1, reason: "Defense plannification", sum: -1, total: 3, created_at: "2026-09-01T10:00:00.000Z" },
          { id: 2, total: "bad", created_at: "2026-09-01T09:00:00.000Z" },
        ]),
      );
    const { env } = signedIn();
    const res = await evaluations(env, "points");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { points: { at: string; total: number }[] };
    expect(body.points).toHaveLength(101);
    expect(body.points[0]).toEqual({ at: "2026-09-01T10:00:00.000Z", total: 3 });
    expect(body.points[100]).toEqual({ at: "2026-10-01T00:00:00.000Z", total: 200 });
    expect(JSON.stringify(body)).not.toContain("reason");
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://api.intra.42.fr/v2/users/${USER}/correction_point_historics?sort=-created_at&page[size]=100&page[number]=1`,
    );
    await evaluations(env, "points");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses another student's evaluations, without calling 42", async () => {
    const { env } = signedIn();
    const res = await evaluations(env, "stats", "someoneelse");
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown part and a missing session", async () => {
    const { env } = signedIn();
    expect((await evaluations(env, "all")).status).toBe(400);
    const anon = await worker.fetch(
      new Request(`https://w.test/api/v1/private/evaluations?login=${LOGIN}&user=${USER}&part=stats`),
      env as never,
    );
    expect(anon.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 429 while the quota is spent and caches nothing", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "60" } }));
    const { env } = signedIn();
    const res = await evaluations(env, "upcoming");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("600");
  });
});
