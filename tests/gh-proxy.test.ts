import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleGhProxy, isBadPath } from "../src/handlers/gh-proxy";
import { FETCH_DEADLINES } from "../src/utils";
import { hangingFetch, stalledBody } from "./helpers/fake-env";

function jsonResponse(
  body: string,
  status = 200,
  contentType = "application/json",
): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

describe("handleGhProxy", () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("raw.githubusercontent.com")) {
        return jsonResponse("raw");
      }
      return jsonResponse("cdn");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves from the raw GitHub source first", async () => {
    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("raw");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(calls[0]).toContain("raw.githubusercontent.com");
    expect(calls).toHaveLength(1);
  });

  it("falls back to jsDelivr when raw returns an error", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("raw.githubusercontent.com")) {
        return jsonResponse("raw unavailable", 500);
      }
      return jsonResponse("cdn");
    }) as unknown as typeof fetch;

    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cdn");
    expect(calls).toHaveLength(2);
  });

  it("returns 502 when all sources fail", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      return jsonResponse("unavailable", 500);
    }) as unknown as typeof fetch;

    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.status).toBe(500);
    expect(await res.text()).toContain("Failed to fetch upstream");
    expect(calls).toHaveLength(2);
  });

  it("returns 400 for a missing path", async () => {
    const request = new Request("https://api.betterintra.com/gh/");
    const res = await handleGhProxy(request);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Missing path");
    expect(calls).toHaveLength(0);
  });

  it("rejects path traversal", () => {
    expect(isBadPath("../secrets")).toBe(true);
    expect(isBadPath("%2e%2e/secrets")).toBe(true);
    expect(isBadPath("%zz")).toBe(true);
    expect(isBadPath("campuses/campuses.json")).toBe(false);
  });

  it("guesses content type when upstream omits it", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(new TextEncoder().encode("{}"), { status: 200 }),
    ) as unknown as typeof fetch;

    const request = new Request(
      "https://api.betterintra.com/gh/campuses/campuses.json",
    );
    const res = await handleGhProxy(request);

    expect(res.headers.get("content-type")).toBe("application/json");
  });
});

describe("handleGhProxy when a source throws or stalls", () => {
  const DEADLINE = FETCH_DEADLINES.ghSourceMs;
  const request = () => new Request("https://api.betterintra.com/gh/campuses/campuses.json");
  let calls: string[];
  let signals: (AbortSignal | undefined)[];
  let warn: ReturnType<typeof vi.spyOn>;

  /** raw.githubusercontent answers with `raw`, jsDelivr with `cdn`. */
  function sources(
    raw: (url: string, init?: RequestInit) => Promise<Response>,
    cdn: (url: string, init?: RequestInit) => Promise<Response> = async () => jsonResponse("cdn"),
  ) {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      signals.push(init?.signal ?? undefined);
      return url.includes("raw.githubusercontent.com") ? raw(url, init) : cdn(url, init);
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
    signals = [];
    FETCH_DEADLINES.ghSourceMs = 20;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    FETCH_DEADLINES.ghSourceMs = DEADLINE;
    vi.restoreAllMocks();
  });

  it("serves jsDelivr when raw.githubusercontent throws, instead of a 500", async () => {
    sources(async () => {
      throw new TypeError("Network connection lost.");
    });
    const res = await handleGhProxy(request());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cdn");
    expect(calls).toHaveLength(2);
    expect(String(warn.mock.calls[0][0])).toContain("raw.githubusercontent.com failed: TypeError");
  });

  it("serves jsDelivr when raw.githubusercontent never answers", async () => {
    sources(hangingFetch());
    const res = await handleGhProxy(request());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cdn");
    expect(String(warn.mock.calls[0][0])).toContain("TimeoutError");
  });

  it("serves jsDelivr when raw.githubusercontent stalls in the middle of the body", async () => {
    sources(async (_url, init) => stalledBody(init, '{"campuses": ['));
    const res = await handleGhProxy(request());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("cdn");
  });

  it("puts a deadline on every source", async () => {
    sources(async () => jsonResponse("gone", 503));
    await handleGhProxy(request());
    expect(signals).toHaveLength(2);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps a 404 when the other source throws: campus.ts caches a missing campus on 404 only", async () => {
    sources(
      async () => jsonResponse("404: Not Found", 404, "text/plain"),
      async () => {
        throw new TypeError("fetch failed");
      },
    );
    const res = await handleGhProxy(request());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Failed to fetch upstream" });
  });

  it("answers 502 when no source answered at all", async () => {
    sources(hangingFetch(), async () => {
      throw new TypeError("fetch failed");
    });
    const res = await handleGhProxy(request());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "server_error", message: "Failed to fetch upstream" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("handleGhProxy revalidation (ETag)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the source's validators to the client", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("raw", {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: 'W/"abc"', "Last-Modified": "Tue, 03 Nov 2026 10:00:00 GMT" },
      }),
    ) as unknown as typeof fetch;
    const res = await handleGhProxy(new Request("https://w.test/gh/campuses/campuses.json"));
    expect(res.headers.get("etag")).toBe('W/"abc"');
    expect(res.headers.get("last-modified")).toBe("Tue, 03 Nov 2026 10:00:00 GMT");
  });

  it("forwards the client's validators and answers the source's 304 without a body", async () => {
    const seen: Headers[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(null, { status: 304, headers: { ETag: 'W/"abc"' } });
    }) as unknown as typeof fetch;
    const res = await handleGhProxy(
      new Request("https://w.test/gh/campuses/campuses.json", {
        headers: { "If-None-Match": 'W/"abc"', Cookie: "x=y" },
      }),
    );
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe('W/"abc"');
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("access-control-allow-origin")).not.toBeNull();
    expect(seen[0].get("if-none-match")).toBe('W/"abc"');
    // Only the validators go upstream.
    expect(seen[0].get("cookie")).toBeNull();
    expect(seen).toHaveLength(1);
  });
});
