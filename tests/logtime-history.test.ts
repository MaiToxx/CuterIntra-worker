import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { resetFtApi } from "../src/ft-api";
import { resetLogtimeHistoryCache } from "../src/handlers/logtime-history";
import { resetRateLimits } from "../src/rate-limit";
// tokenHash is plain SHA-256 hex, the same as a login hash
import { addSession, makeEnv, tokenHash } from "./helpers/fake-env";

const USER = "alepayen";
const LOGIN = tokenHash(USER);
const SESSION = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "s-s4t2ud-" + "b".repeat(64);
const APP = { FT_CLIENT_ID: "u-s4t2ud-" + "a".repeat(64), FT_CLIENT_SECRET: SECRET };
const auth = { Authorization: `Bearer ${SESSION}` };

const tokenRes = (extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ access_token: "app-token", expires_in: 7200, ...extra }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const statsRes = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "x-hourly-ratelimit-remaining": "1100", ...headers },
  });

function signedIn(vars = APP) {
  const made = makeEnv({ vars });
  addSession(made.d1, LOGIN, SESSION);
  return made;
}

const history = (env: unknown, user = USER, init: RequestInit = { headers: auth }) =>
  worker.fetch(
    new Request(`https://w.test/api/v1/private/logtime/history?login=${LOGIN}&user=${user}`, init),
    env as never,
  );

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetFtApi();
  resetLogtimeHistoryCache();
  resetRateLimits();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /api/v1/private/logtime/history", () => {
  it("does not exist without the 42 application, before any read", async () => {
    const { env, d1 } = signedIn({} as typeof APP);
    const res = await history(env);
    expect(res.status).toBe(404);
    expect(d1.prepared).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers your whole history in seconds per day, from one locations_stats call", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(
        statsRes({ "2026-09-07": "03:12:00.500000", "2026-10-01": "00:00:00", "2026-10-02": "12:00:05", error: "x" }),
      );
    const { env } = signedIn();
    const res = await history(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: { "2026-09-07": 11520, "2026-10-02": 43205 } });

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://api.intra.42.fr/oauth/token");
    expect(String(tokenInit.body)).toContain("grant_type=client_credentials");
    expect(tokenInit.redirect).toBe("manual");
    const [statsUrl, statsInit] = fetchMock.mock.calls[1];
    expect(statsUrl).toBe(`https://api.intra.42.fr/v2/users/${USER}/locations_stats`);
    expect(statsInit.headers.Authorization).toBe("Bearer app-token");
    expect(statsInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("serves a second call from memory and reuses the token", async () => {
    fetchMock.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(statsRes({ "2026-10-02": "01:00:00" }));
    const { env } = signedIn();
    await history(env);
    const again = await history(env);
    expect(await again.json()).toEqual({ days: { "2026-10-02": 3600 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses another student's history, without calling 42", async () => {
    const { env } = signedIn();
    const res = await history(env, "someoneelse");
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs a valid session", async () => {
    const { env } = signedIn();
    const res = await history(env, USER, { headers: { Authorization: "Bearer 22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops calling 42 once the quota is spent", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "120" } }));
    const { env } = signedIn();
    const first = await history(env);
    expect(first.status).toBe(429);
    expect(((await first.json()) as { error: string }).error).toBe("rate_limited");
    const second = await history(env);
    expect(second.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers 502 when 42 refuses the application, without echoing the secret", async () => {
    fetchMock.mockResolvedValue(new Response(`{"error":"invalid_client","secret":"${SECRET}"}`, { status: 401 }));
    const { env } = signedIn();
    const res = await history(env);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("warns in the logs when the application secret expires within a week", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const soon = Math.floor(Date.now() / 1000) + 3 * 86400;
    fetchMock.mockResolvedValueOnce(tokenRes({ secret_valid_until: soon })).mockResolvedValueOnce(statsRes({}));
    const { env } = signedIn();
    await history(env);
    expect(warn.mock.calls.some(([line]) => String(line).includes("wrangler secret put FT_CLIENT_SECRET"))).toBe(true);
    warn.mockRestore();
  });
});

describe("GET /api/v1/public/features", () => {
  it("says whether the logtime history is available", async () => {
    const off = await worker.fetch(new Request("https://w.test/api/v1/public/features"), makeEnv().env);
    expect(await off.json()).toEqual({ features: { logtimeHistory: false, evaluations: false } });
    const on = await worker.fetch(new Request("https://w.test/api/v1/public/features"), makeEnv({ vars: APP }).env);
    expect(await on.json()).toEqual({ features: { logtimeHistory: true, evaluations: true } });
    expect(on.headers.get("Cache-Control")).toBe("public, max-age=300");
  });
});
