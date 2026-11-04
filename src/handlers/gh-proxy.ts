import { corsHeaders, errorRes, FETCH_DEADLINES } from "../utils";

const SOURCES = [
  "https://raw.githubusercontent.com/MaiToxx/CuterIntra/main",
  "https://cdn.jsdelivr.net/gh/MaiToxx/CuterIntra@main",
];

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/**
 * Validators passed on to the source, so that a browser revalidating a file
 * it holds (its hour is over) gets a 304 without the body when nothing
 * changed. Ported from upstream (nicopasla/better-intra-worker 8d5e651).
 */
const VALIDATORS = ["if-none-match", "if-modified-since"] as const;
const CACHE_CONTROL = "public, max-age=3600";

/** The source's validators, for the client's next revalidation. */
function withValidators(headers: Headers, from: Response): Headers {
  const etag = from.headers.get("etag");
  const lastModified = from.headers.get("last-modified");
  if (etag) headers.set("ETag", etag);
  if (lastModified) headers.set("Last-Modified", lastModified);
  return headers;
}

function guessContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8";
}

export function isBadPath(rawPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return true;
  }
  return decoded.includes("..");
}

export async function handleGhProxy(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/gh\//, "");
  if (!path) return errorRes("bad_request", "Missing path", 400);
  if (isBadPath(path)) return errorRes("bad_request", "Bad path", 400);

  const conditional = new Headers();
  for (const name of VALIDATORS) {
    const value = request.headers.get(name);
    if (value) conditional.set(name, value);
  }

  // 502 only when no source gave an HTTP answer at all (both threw or timed
  // out); otherwise the last upstream status.
  let lastStatus = 502;
  for (const base of SOURCES) {
    // A source that throws (connection reset from Cloudflare's egress) or
    // stalls moves on to the next one, like an error status does: the throw
    // used to escape as a 500 and a stall to hold the request until the
    // extension gave up, jsDelivr never tried. The body is read inside the
    // try, under the same deadline: a stall mid-body moves on too.
    try {
      const res = await fetch(`${base}/${path}`, {
        headers: conditional,
        signal: AbortSignal.timeout(FETCH_DEADLINES.ghSourceMs),
      });
      if (res.status === 304) {
        return new Response(null, {
          status: 304,
          headers: withValidators(
            new Headers({ ...corsHeaders, "Cache-Control": CACHE_CONTROL }),
            res,
          ),
        });
      }
      if (res.ok) {
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: withValidators(
            new Headers({
              ...corsHeaders,
              "Content-Type":
                res.headers.get("content-type") || guessContentType(path),
              "Cache-Control": CACHE_CONTROL,
            }),
            res,
          ),
        });
      }
      lastStatus = res.status;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      console.warn(`[gh-proxy] ${new URL(base).host} failed: ${e instanceof Error ? e.name : String(e)}`);
    }
  }

  // The upstream status stays (the extension's stale-data fallbacks look at
  // it, and campus.ts caches a campus without a data file on a 404 only); a
  // missing file is the one case with its own code.
  return errorRes(
    lastStatus === 404 ? "not_found" : "server_error",
    "Failed to fetch upstream",
    lastStatus,
  );
}
