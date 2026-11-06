import { Env } from "../types";
import { errorRes, FETCH_DEADLINES, fetchAllowed, readBodyCapped } from "../utils";

/** Far above a real cluster map (a few hundred KB at most). */
const SVG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The only caller is the extension's cluster map (map-dialog/map-load.ts). It
 * passes the `data-image` of meta.intra.42.fr's cluster page, resolved against
 * https://meta.intra.42.fr/ (map-dialog/cache.ts parseClusterPanes), so a
 * legitimate map always sits on an Intra host. Anything else would make this
 * public, unauthenticated route an open proxy on the worker's domain.
 */
export function isAllowedClusterSvgUrl(u: URL): boolean {
  if (u.protocol !== "https:") return false;
  if (u.username || u.password || u.port) return false;
  return u.hostname === "intra.42.fr" || u.hostname.endsWith(".intra.42.fr");
}

/**
 * An Intra host can still answer with something else (the sign-in page for a
 * URL that needs a session): only an SVG is ever re-served.
 */
function looksLikeSvg(contentType: string | null, text: string): boolean {
  if (/svg/i.test(contentType ?? "")) return true;
  const head = text.slice(0, 4096).replace(/^﻿/, "");
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i.test(
    head,
  );
}

export async function handleClusterSvg(
  request: Request,
  _env: Env,
  origin: string | null,
): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return errorRes("bad_request", "Missing url", 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return errorRes("bad_request", "Invalid url", 400);
  }
  if (!isAllowedClusterSvgUrl(target)) return errorRes("bad_request", "Host not allowed", 400);

  // 502s: the Intra host answered something unusable, or nothing in time,
  // nothing the client can fix, hence the generic code. A throw (reset,
  // deadline, during the body too) is one of them rather than a 500: the
  // cluster map falls back to its cached copy either way.
  let bytes: Uint8Array | null;
  let contentType: string | null;
  try {
    const svgRes = await fetchAllowed(target, isAllowedClusterSvgUrl, FETCH_DEADLINES.clusterSvgMs);
    if (!svgRes) return errorRes("server_error", "Redirect not allowed", 502);
    if (!svgRes.ok) {
      await svgRes.body?.cancel().catch(() => {});
      return errorRes("server_error", "Fetch failed", 502);
    }
    contentType = svgRes.headers.get("Content-Type");
    bytes = await readBodyCapped(svgRes, SVG_MAX_BYTES);
  } catch (e) {
    console.warn(`[clusters] map fetch failed: ${e instanceof Error ? e.name : String(e)}`);
    return errorRes("server_error", "Fetch failed", 502);
  }
  if (!bytes) return errorRes("server_error", "SVG too large", 502);
  const text = new TextDecoder().decode(bytes);
  if (!looksLikeSvg(contentType, text)) {
    return errorRes("server_error", "Not an SVG", 502);
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Access-Control-Allow-Origin": origin || "*",
      // The allowed origin is the caller's: a shared cache must not hand one
      // extension's copy to another origin, whose CORS check would fail.
      Vary: "Origin",
      "Cache-Control": "public, max-age=604800",
      // The extension reads the body with fetch(), where these headers change
      // nothing. They matter when the URL is opened as a page: an SVG
      // document can carry <script>, and this is the worker's own origin.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
