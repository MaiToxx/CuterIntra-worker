import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { resetRateLimits } from "../src/rate-limit";
import type { Env } from "../src/types";
import { FakeKV, FakeRateLimit, addSession, makeEnv, tokenHash } from "./helpers/fake-env";
import { readFixture } from "./helpers/fixtures";

const LOGIN = "0".repeat(63) + "a";
const OTHER = "0".repeat(63) + "b";
const SESSION = "session-export-current";
const OLD = "session-export-older";
const CAL = "11111111-1111-4111-8111-111111111111";
const OTHER_CAL = "22222222-2222-4222-8222-222222222222";
const NOW = 1_800_000_000_000;

function setup(vars: Partial<Env> = {}) {
  const made = makeEnv({
    kv: new FakeKV({
      [LOGIN]: {
        settings: {
          THEME: "dark",
          FRIENDS_LIST: ["alice"],
          PROFILE_IMAGE_URL: "https://img.test/me.png",
          CALENDAR_SYNC_TOKEN: CAL,
          CLOUD_TOKEN: "an-old-build-synced-this",
        },
        settingsRev: 1234,
      },
      [OTHER]: { settings: { THEME: "other-secret", PROFILE_IMAGE_URL: "https://img.test/them.png" } },
    }),
    vars,
  });
  const { d1, kv } = made;
  addSession(d1, LOGIN, OLD, NOW - 86_400_000);
  addSession(d1, LOGIN, SESSION, NOW - 1000);
  addSession(d1, OTHER, "session-of-other", NOW - 5000);
  d1.raw.exec(`
    INSERT INTO users (hash, created_at) VALUES ('${LOGIN}', 1700000000), ('${OTHER}', 1600000000);
    INSERT INTO calendar_tokens (token, login_hash) VALUES ('${CAL}', '${LOGIN}'), ('${OTHER_CAL}', '${OTHER}');
    INSERT INTO calendar_ics (login_hash, ics_body) VALUES ('${LOGIN}', 'BEGIN:VCALENDAR'), ('${OTHER}', 'BEGIN:VCALENDAR other');
  `);
  kv.data.set(`img:${LOGIN}:avatar`, readFixture("gps.png").buffer as ArrayBuffer);
  kv.meta.set(`img:${LOGIN}:avatar`, { type: "image/png", v: 1 });
  kv.data.set(`img:${OTHER}:banner`, readFixture("gps.png").buffer as ArrayBuffer);
  return made;
}

const exportOf = (env: Env, token: string | null = SESSION, init: RequestInit = {}, login = LOGIN) =>
  worker.fetch(
    new Request(`https://w.test/api/v1/private/export?login=${login}`, {
      ...init,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    env,
  );

beforeEach(() => {
  resetRateLimits();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/v1/private/export", () => {
  it("answers everything kept about the caller, as a download", async () => {
    const { env } = setup();
    const res = await exportOf(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="cuter-intra-cloud-data.json"',
    );
    const body = (await res.json()) as Record<string, any>;
    const publicBody = await (
      await worker.fetch(new Request(`https://w.test/api/v1/public/visuals?login=${LOGIN}`), env)
    ).json();
    expect(body).toEqual({
      exportedAt: NOW,
      loginHash: LOGIN,
      settings: {
        THEME: "dark",
        FRIENDS_LIST: ["alice"],
        PROFILE_IMAGE_URL: "https://img.test/me.png",
        CALENDAR_SYNC_TOKEN: "[redacted]",
        CLOUD_TOKEN: "[redacted]",
      },
      rev: 1234,
      sessions: [
        { id: tokenHash(SESSION).slice(0, 8), createdAt: NOW - 1000 },
        { id: tokenHash(OLD).slice(0, 8), createdAt: NOW - 86_400_000 },
      ],
      firstSignIn: 1_700_000_000_000,
      calendar: { live: true, feedStored: true },
      images: ["avatar"],
      publicVisuals: publicBody,
    });
  });

  it("never holds a token, a full token hash, or another login's data", async () => {
    const { env } = setup();
    const text = await (await exportOf(env)).text();
    for (const secret of [
      SESSION,
      OLD,
      tokenHash(SESSION),
      tokenHash(OLD),
      CAL,
      "an-old-build-synced-this",
      OTHER,
      "other-secret",
      "them.png",
      OTHER_CAL,
      tokenHash("session-of-other").slice(0, 8),
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("works for a login with nothing but a session, legacy record included", async () => {
    const lone = "c".repeat(64);
    const { env } = makeEnv({ kv: new FakeKV({ [lone]: { sessionTokens: ["legacy-tok"] } }) });
    const body = (await (await exportOf(env, "legacy-tok", {}, lone)).json()) as Record<string, any>;
    expect(body).toMatchObject({
      loginHash: lone,
      settings: {},
      rev: 0,
      firstSignIn: null,
      calendar: { live: false, feedStored: false },
      images: [],
    });
    expect(body.sessions).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("legacy-tok");
  });

  it("writes nothing", async () => {
    const { env, kv, d1 } = setup();
    const before = d1.rows("SELECT COUNT(*) AS n FROM sessions")[0];
    d1.prepared.length = 0;
    expect((await exportOf(env)).status).toBe(200);
    expect(kv.puts).toEqual([]);
    expect(kv.deletes).toEqual([]);
    // the calendar table check may run its CREATE ... IF NOT EXISTS once
    expect(d1.prepared.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toEqual([]);
    expect(d1.rows("SELECT COUNT(*) AS n FROM sessions")[0]).toEqual(before);
  });

  it("answers the one 401 of the private routes, before any read without a token", async () => {
    const { env, kv, d1 } = setup();
    const getSpy = vi.spyOn(kv, "get");
    d1.prepared.length = 0;
    const anonymous = await exportOf(env, null);
    expect(anonymous.status).toBe(401);
    expect(getSpy).not.toHaveBeenCalled();
    expect(d1.prepared).toEqual([]);
    const forged = await exportOf(env, "forged");
    const theirs = await exportOf(env, "session-of-other");
    const snap = async (r: Response) => ({ status: r.status, body: await r.text() });
    const a = await snap(anonymous);
    expect(a.body).toBe(JSON.stringify({ error: "unauthorized", message: "Unauthorized" }));
    expect(await snap(forged)).toEqual(a);
    expect(await snap(theirs)).toEqual(a);
  });

  it("is rate limited in the write bucket, and GET only", async () => {
    const rl = new FakeRateLimit();
    rl.denyAll = true;
    const { env } = setup({ WRITE_RL: rl });
    const res = await exportOf(env);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    expect(rl.calls).toEqual([LOGIN]);
    const post = await exportOf(setup().env, SESSION, { method: "POST" });
    expect(post.status).toBe(405);
  });
});
