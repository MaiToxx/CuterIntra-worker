import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { resetFtApi } from "../src/ft-api";
import { parseBlocs, resetCoalitionsCache, safeImageUrl } from "../src/handlers/coalitions";
import { resetRateLimits } from "../src/rate-limit";
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
const coalitions = (env: unknown, user = USER) =>
  worker.fetch(
    new Request(`https://w.test/api/v1/private/coalitions?login=${LOGIN}&user=${user}`, { headers: auth }),
    env as never,
  );

const BLOCS = [
  {
    id: 136,
    cursus_id: 9,
    coalitions: [
      { id: 613, name: "Autobot", score: 9257, color: "#015aed", image_url: "https://cdn.intra.42.fr/coalition/image/613/2.svg", user_id: 89553 },
      { id: 612, name: "Decepticons", score: 10954, color: "#E70200", image_url: "https://evil.example/x.svg", user_id: 95895 },
    ],
  },
  {
    id: 66,
    cursus_id: 21,
    coalitions: [{ id: 334, name: "Technicians", score: 7756137, color: "red", image_url: null }],
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetFtApi();
  resetCoalitionsCache();
  resetRateLimits();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("parseBlocs and safeImageUrl", () => {
  it("keeps Intra's CDN only, valid colours only, highest score first, no leader", () => {
    const [piscine, core] = parseBlocs(BLOCS);
    expect(piscine.coalitions.map((c) => c.name)).toEqual(["Decepticons", "Autobot"]);
    expect(piscine.coalitions[0].imageUrl).toBeNull();
    expect(piscine.coalitions[1]).toEqual({
      id: 613,
      name: "Autobot",
      score: 9257,
      color: "#015AED",
      imageUrl: "https://cdn.intra.42.fr/coalition/image/613/2.svg",
    });
    expect(core.coalitions[0].color).toBeNull();
    expect(safeImageUrl("http://cdn.intra.42.fr/a.svg")).toBeNull();
  });
});

describe("GET /api/v1/private/coalitions", () => {
  it("does not exist without the 42 application", async () => {
    const { env, d1 } = signedIn({} as typeof APP);
    expect((await coalitions(env)).status).toBe(404);
    expect(d1.prepared).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the blocs of your coalitions, yours marked", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json([{ campus_id: 1, is_primary: false }, { campus_id: 48, is_primary: true }]))
      .mockResolvedValueOnce(json([{ id: 612, name: "Decepticons" }]))
      .mockResolvedValueOnce(json(BLOCS));
    const { env } = signedIn();
    const res = await coalitions(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { blocs: { id: number; coalitions: { name: string; mine: boolean }[] }[] };
    expect(body.blocs.map((b) => b.id)).toEqual([136]);
    expect(body.blocs[0].coalitions.map((c) => [c.name, c.mine])).toEqual([
      ["Decepticons", true],
      ["Autobot", false],
    ]);
    expect(JSON.stringify(body)).not.toContain("user_id");
    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.intra.42.fr/v2/users/${USER}/campus_users`);
    expect(fetchMock.mock.calls[3][0]).toBe("https://api.intra.42.fr/v2/blocs?filter[campus_id]=48&page[size]=100");

    // Both kept in memory: no new call.
    await coalitions(env);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("answers no bloc without a coalition, without reading the blocs", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json([{ campus_id: 48, is_primary: true }]))
      .mockResolvedValueOnce(json([]));
    const { env } = signedIn();
    expect(await (await coalitions(env)).json()).toEqual({ blocs: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses another student, and a missing session, without calling 42", async () => {
    const { env } = signedIn();
    expect((await coalitions(env, "someoneelse")).status).toBe(403);
    const anon = await worker.fetch(
      new Request(`https://w.test/api/v1/private/coalitions?login=${LOGIN}&user=${USER}`),
      env as never,
    );
    expect(anon.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 429 while the quota is spent", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "60" } }));
    const { env } = signedIn();
    expect((await coalitions(env)).status).toBe(429);
  });
});
