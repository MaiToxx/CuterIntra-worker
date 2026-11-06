import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";
import { FakeKV, FakeRateLimit, makeEnv } from "./helpers/fake-env";
import { readFixture } from "./helpers/fixtures";
import { LIMITS, resetRateLimits } from "../src/rate-limit";

const LOGIN = "d".repeat(64);
const OTHER = "e".repeat(64);
const SESSION = "session-d";

function seeded(vars: Partial<Env> = {}) {
  return makeEnv({
    kv: new FakeKV({
      [LOGIN]: { sessionTokens: [SESSION], settings: { A: 1 } },
    }),
    vars,
  });
}

describe("catch-all error handler", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns an exception into a JSON 500 the extension can read", async () => {
    const { env, kv } = seeded();
    kv.putError = new Error("KV put() limit exceeded for the day.");
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SESSION}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ settings: { A: 2 } }),
      }),
      env,
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: "server_error",
      message: "KV put() limit exceeded for the day.",
    });
  });

  it("logs the method and path of the failed route, never the query string", async () => {
    const { env, kv } = seeded();
    kv.putError = new Error("KV put() limit exceeded for the day.");
    await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SESSION}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ settings: { A: 2 } }),
      }),
      env,
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain("POST /api/v1/private/settings");
    expect(line).toContain("KV put() limit exceeded");
    expect(line).not.toContain(LOGIN);
    expect(line).not.toContain("?");
  });

  it("never puts a stack trace or a configured secret in the body", async () => {
    const secret = "s3cr3t-announcement-value";
    const { env, kv } = seeded({ ANNOUNCEMENT_SECRET: secret });
    kv.get = async () => {
      throw new Error(`upstream said ${secret}`);
    };
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`),
      env,
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
    expect(text).not.toMatch(/\bat .*\.ts/);
  });

  it("keeps normal responses untouched", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("CORS preflight", () => {
  it("lets the browser cache the answer for a day", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://profile-v3.intra.42.fr",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://profile-v3.intra.42.fr",
    );
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });

  it("still refuses a foreign origin", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      env,
    );
    expect(res.status).toBe(403);
    // JSON like every error, but nothing that page may read
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await res.json()).toEqual({ error: "unauthorized", message: "Origin not allowed" });
  });
});

describe("calendar link stop through the router", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("preflights and routes DELETE calendar/token to a 204 with CORS", async () => {
    const { env } = seeded();
    const url = `https://w.test/api/v1/private/calendar/token?login=${LOGIN}`;
    const origin = "moz-extension://0e9f5b2c-0000-4000-8000-000000000000";
    const pre = await worker.fetch(
      new Request(url, {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "DELETE" },
      }),
      env,
    );
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");

    const res = await worker.fetch(
      new Request(url, {
        method: "DELETE",
        headers: { Origin: origin, Authorization: `Bearer ${SESSION}` },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("unauthenticated bodies", () => {
  it("are capped even without an Origin header, with a readable 413", async () => {
    // with a secret configured: without one the announcement POST is closed
    // (403) before its body is read
    const { env, kv } = seeded({ ANNOUNCEMENT_SECRET: "announce-secret-123" });
    const getSpy = vi.spyOn(kv, "get");
    const huge = JSON.stringify({ token: "x".repeat(1024 * 1024) });
    for (const path of ["/auth/intra", "/api/v1/public/announcement"]) {
      const res = await worker.fetch(
        new Request(`https://w.test${path}`, { method: "POST", body: huge }),
        env,
      );
      expect(res.status).toBe(413);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    expect(getSpy).not.toHaveBeenCalled();
    expect(kv.puts).toEqual([]);
  });
});

describe("login parameter", () => {
  it("only accepts a login hash, so internal KV keys stay out of reach", async () => {
    const { env, kv } = seeded();
    kv.data.set("INTRA_JWKS_CACHE", "[]");
    kv.data.set("CALENDAR_TOKEN_abcdefgh", LOGIN);
    const getSpy = vi.spyOn(kv, "get");
    for (const login of [
      "ANNOUNCEMENT",
      "CALENDAR_TOKEN_abcdefgh",
      "INTRA_JWKS_CACHE",
      LOGIN.toUpperCase(),
      "x".repeat(600),
    ]) {
      const res = await worker.fetch(
        new Request(
          `https://w.test/api/v1/public/visuals?login=${encodeURIComponent(login)}`,
        ),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe("private routes without a Bearer token", () => {
  it("answer 401 before any KV or D1 read, identical to a wrong token or an unknown login", async () => {
    const { env, kv, d1 } = seeded();
    const getSpy = vi.spyOn(kv, "get");
    const anonymous = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`),
      env,
    );
    expect(anonymous.status).toBe(401);
    expect(getSpy).not.toHaveBeenCalled();
    expect(d1.prepared).toEqual([]);

    const wrongToken = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${LOGIN}`, {
        headers: { Authorization: "Bearer forged" },
      }),
      env,
    );
    const unknownLogin = await worker.fetch(
      new Request(`https://w.test/api/v1/private/settings?login=${OTHER}`, {
        headers: { Authorization: "Bearer forged" },
      }),
      env,
    );
    const bodies = await Promise.all(
      [anonymous, wrongToken, unknownLogin].map(async (r) => ({
        status: r.status,
        body: await r.text(),
        headers: [...r.headers.entries()].sort(),
      })),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });
});

describe("batch public visuals", () => {
  it("answers every requested hash from one bulk read, unknown ones with the defaults", async () => {
    const { env, kv } = seeded();
    kv.data.set(
      OTHER,
      JSON.stringify({
        sessionTokens: ["s"],
        settings: { PROFILE_IMAGE_URL: "https://img.test/e.png" },
      }),
    );
    const getSpy = vi.spyOn(kv, "get");
    const unknown = "f".repeat(64);
    const res = await worker.fetch(
      new Request(
        `https://w.test/api/v1/public/visuals?logins=${LOGIN},${OTHER},${unknown},${OTHER}`,
      ),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0][0]).toEqual([LOGIN, OTHER, unknown]);
    const { visuals } = (await res.json()) as {
      visuals: Record<string, { avatar: string; avatarBg: string }>;
    };
    expect(Object.keys(visuals).sort()).toEqual([LOGIN, OTHER, unknown].sort());
    expect(visuals[OTHER].avatar).toBe("https://img.test/e.png");
    expect(visuals[LOGIN].avatar).toBe("");
    expect(visuals[unknown]).toEqual(visuals[LOGIN]);
    expect(visuals[unknown].avatarBg).toBe("transparent");
  });

  it("refuses more than 50 hashes or a value that is not a hash, without a KV read", async () => {
    const { env, kv } = seeded();
    const getSpy = vi.spyOn(kv, "get");
    const many = Array.from({ length: 51 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    ).join(",");
    for (const logins of [many, `${LOGIN},INTRA_JWKS_CACHE`, "", ",,"]) {
      const res = await worker.fetch(
        new Request(
          `https://w.test/api/v1/public/visuals?logins=${encodeURIComponent(logins)}`,
        ),
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(getSpy).not.toHaveBeenCalled();
    const fifty = Array.from({ length: 50 }, (_, i) =>
      i.toString(16).padStart(64, "0"),
    ).join(",");
    expect(
      (
        await worker.fetch(
          new Request(`https://w.test/api/v1/public/visuals?logins=${fifty}`),
          env,
        )
      ).status,
    ).toBe(200);
  });

  it("keeps the single-login form for older builds", async () => {
    const { env } = seeded();
    const res = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(((await res.json()) as { avatar: string }).avatar).toBe("");
  });
});

describe("batch public visuals: per-IP limit", () => {
  beforeEach(() => resetRateLimits());

  // 50 made-up hashes: what an attacker sends to spend 50 KV reads a call
  const random = Array.from({ length: 50 }, (_, i) =>
    (i + 1).toString(16).padStart(64, "0"),
  ).join(",");
  const batch = (env: Env, ip: string | null) =>
    worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?logins=${random}`, {
        headers: ip ? { "CF-Connecting-IP": ip } : {},
      }),
      env,
    );

  it("answers 429 past the limit from one address, before any KV read; other addresses go on", async () => {
    const { env, kv } = seeded();
    const getSpy = vi.spyOn(kv, "get");
    for (let i = 0; i < LIMITS.visuals.limit; i++) {
      expect((await batch(env, "203.0.113.7")).status).toBe(200);
    }
    const reads = getSpy.mock.calls.length;
    const refused = await batch(env, "203.0.113.7");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(refused.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(getSpy.mock.calls.length).toBe(reads);

    expect((await batch(env, "198.51.100.1")).status).toBe(200);
    // the single-login form (one read a call) is not limited
    const single = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`, {
        headers: { "CF-Connecting-IP": "203.0.113.7" },
      }),
      env,
    );
    expect(single.status).toBe(200);
  });

  it("keys an IPv6 client by its /64, so rotating addresses inside it does not help", async () => {
    const visuals = new FakeRateLimit();
    const { env } = seeded({ VISUALS_RL: visuals });
    await batch(env, "2a01:cb10:793:3f00::7");
    await batch(env, "2a01:cb10:793:3f00:1234:5678:9abc:def0");
    expect(visuals.calls).toEqual(["2a01:cb10:793:3f00::/64", "2a01:cb10:793:3f00::/64"]);
  });

  it("uses the VISUALS_RL binding when bound, keyed by address", async () => {
    const visuals = new FakeRateLimit();
    visuals.denyAll = true;
    const { env, kv } = seeded({ VISUALS_RL: visuals });
    const getSpy = vi.spyOn(kv, "get");
    expect((await batch(env, "203.0.113.7")).status).toBe(429);
    expect(visuals.calls).toEqual(["203.0.113.7"]);
    expect(getSpy).not.toHaveBeenCalled();
  });
});

/**
 * Routes of the upstream worker that need a 42 application, Discord or R2.
 * They are gone from this deployment: a 404 with no KV, D1 or network work,
 * whatever the credentials.
 */
describe("removed routes", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const auth = { Authorization: `Bearer ${SESSION}` };
  const cases: Array<[string, RequestInit]> = [
    ["/login?redirect_uri=https://profile-v3.intra.42.fr/", {}],
    ["/callback?code=x&state=https://profile-v3.intra.42.fr/", {}],
    ["/discord/auth?token=x&login=y", {}],
    ["/discord/callback?code=abc&state=made-up", {}],
    [`/api/v1/private/discord/link?login=${LOGIN}`, { method: "POST", headers: auth }],
    [`/api/v1/private/discord/test`, { method: "POST" }],
    ["/api/v1/public/images/0123abcd-0000-4000-8000-000000000000", {}],
    [`/api/v1/private/image-upload?login=${LOGIN}`, { method: "POST", headers: auth }],
    [`/api/v1/students?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/pisciners?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/piscines?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/future-students?login=${LOGIN}`, { headers: auth }],
    ["/api/v1/students/refresh", { method: "POST" }],
    ["/api/v1/future-students/refresh", { method: "POST" }],
    [`/api/v1/private/logtime/history?login=${LOGIN}&user=x`, { headers: auth }],
    [`/api/v1/private/friends/data?login=${LOGIN}&logins=a`, { headers: auth }],
    [`/api/v1/private/profile-stats?login=${LOGIN}&target=x`, { headers: auth }],
    [`/api/v1/private/evaluations?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/private/coalitions?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/private/outstanding?login=${LOGIN}`, { headers: auth }],
    [`/api/v1/private/proxy?login=${LOGIN}&path=/v2/me`, { headers: auth }],
    ["/api/v1/private/projects/refresh", { method: "POST", body: "{}" }],
    // never written by any worker, never called by any extension build: it
    // only cost a KV read per anonymous call
    ["/api/v1/cluster/svgs", {}],
  ];

  for (const [path, init] of cases) {
    it(`${init.method ?? "GET"} ${path.split("?")[0]} is gone`, async () => {
      const { env, kv, d1 } = seeded();
      kv.data.set("CLUSTER_SVG_URLS", JSON.stringify({ k0: "https://cdn.intra.42.fr/k0.svg" }));
      const getSpy = vi.spyOn(kv, "get");
      const puts = kv.puts.length;
      const res = await worker.fetch(new Request(`https://w.test${path}`, init), env);
      expect(res.status).toBe(404);
      expect(getSpy).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(kv.puts.length).toBe(puts);
      expect(kv.deletes).toEqual([]);
      expect(d1.prepared).toEqual([]);
    });
  }

  it("has no scheduled handler any more", () => {
    expect((worker as { scheduled?: unknown }).scheduled).toBeUndefined();
  });
});

describe("error bodies", () => {
  beforeEach(() => resetRateLimits());

  /**
   * Every error: JSON {error, message}, status unchanged from before codes
   * existed (the extension decides on the status, and newer builds on the
   * code, never on the English message).
   */
  it("carry a stable code and an English message, with the status each case always had", async () => {
    const { env } = seeded({ ANON_RL: Object.assign(new FakeRateLimit(), { denyAll: false }) });
    const auth = { Authorization: `Bearer ${SESSION}` };
    const cases: Array<[string, RequestInit, number, string]> = [
      ["/nowhere", {}, 404, "not_found"],
      ["/api/v1/private/settings", {}, 400, "bad_request"],
      ["/api/v1/private/settings?login=NOTAHASH", {}, 400, "bad_request"],
      [`/api/v1/private/settings?login=${LOGIN}`, {}, 401, "unauthorized"],
      [`/api/v1/private/settings?login=${LOGIN}`, { method: "PUT", headers: auth }, 405, "bad_request"],
      [`/api/v1/private/settings?login=${LOGIN}`, { method: "POST", headers: auth, body: "[]" }, 400, "bad_request"],
      [`/api/v1/private/settings?login=${LOGIN}`, { method: "POST", headers: auth, body: "not json" }, 400, "bad_request"],
      [`/api/v1/private/sessions?login=${LOGIN}`, { method: "DELETE", headers: auth }, 400, "bad_request"],
      [`/api/v1/private/images?login=${LOGIN}&slot=nope`, { method: "POST", headers: auth }, 400, "bad_request"],
      [`/api/v1/private/images?login=${LOGIN}&slot=avatar`, { method: "POST", headers: auth, body: "text" }, 415, "unsupported_image_type"],
      [`/api/v1/private/images?login=${LOGIN}&slot=avatar`, { method: "POST", headers: { ...auth, "Content-Length": String(3 * 1024 * 1024) }, body: readFixture("gps.png") }, 413, "image_too_large"],
      [`/api/v1/private/calendar/token?login=${LOGIN}`, { method: "POST", headers: auth, body: JSON.stringify({ token: "x" }) }, 400, "bad_request"],
      [`/api/v1/private/calendar/update?login=${LOGIN}`, { method: "POST", headers: auth, body: JSON.stringify({ ics: "x".repeat(300 * 1024) }) }, 413, "too_large"],
      [`/api/v1/private/subjects/report?login=${LOGIN}`, { method: "GET", headers: auth }, 405, "bad_request"],
      [`/api/v1/private/export?login=${LOGIN}`, { method: "DELETE", headers: auth }, 405, "bad_request"],
      [`/img/${LOGIN}/avatar`, {}, 404, "not_found"],
      [`/img/${LOGIN}/avatar`, { method: "POST" }, 405, "bad_request"],
      ["/calendar/unknown-token-1234.ics", {}, 404, "not_found"],
      ["/api/v1/public/visuals?logins=nothash", {}, 400, "bad_request"],
      ["/api/v1/public/stats", { method: "POST" }, 405, "bad_request"],
      ["/api/v1/public/announcement", { method: "PUT" }, 405, "bad_request"],
      ["/api/v1/public/announcement", { method: "POST", body: JSON.stringify({ secret: "x", message: "m" }) }, 403, "unauthorized"],
      ["/api/v1/cluster/svg", {}, 400, "bad_request"],
      ["/api/v1/cluster/svg?url=https://evil.example/a.svg", {}, 400, "bad_request"],
      ["/gh/..%2Fsecret", {}, 400, "bad_request"],
      ["/auth/intra", { method: "GET" }, 405, "bad_request"],
      ["/auth/intra", { method: "POST", body: JSON.stringify({}) }, 400, "bad_request"],
      ["/auth/intra", { method: "POST", body: JSON.stringify({ token: "x".repeat(40) }) }, 401, "unauthorized"],
      ["/auth/intra", { method: "POST", body: "x".repeat(40 * 1024) }, 413, "too_large"],
    ];
    for (const [path, init, status, code] of cases) {
      const res = await worker.fetch(new Request(`https://w.test${path}`, init), env);
      expect({ path, status: res.status }).toEqual({ path, status });
      expect(res.headers.get("Content-Type"), path).toBe("application/json");
      expect(res.headers.get("Access-Control-Allow-Origin"), path).toBe("*");
      const body = (await res.json()) as { error: unknown; message: unknown };
      expect(body.error, path).toBe(code);
      expect(typeof body.message, path).toBe("string");
    }
  });

  it("keep the rate limit's 429 and the upstream status of the GitHub proxy", async () => {
    const visuals = new FakeRateLimit();
    visuals.denyAll = true;
    const { env } = seeded({ VISUALS_RL: visuals });
    const limited = await worker.fetch(
      new Request(`https://w.test/api/v1/public/visuals?logins=${LOGIN}`, {
        headers: { "CF-Connecting-IP": "203.0.113.9" },
      }),
      env,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    try {
      const missing = await worker.fetch(new Request("https://w.test/gh/campuses/none.json"), env);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: "not_found", message: "Failed to fetch upstream" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
