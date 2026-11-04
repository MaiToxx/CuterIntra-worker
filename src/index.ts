import { handleIntraAuth } from "./handlers/intra-auth";
import {
  handlePrivateSettings,
  handlePublicVisuals,
  handlePublicVisualsBatch,
} from "./handlers/settings";
import { handleGhProxy } from "./handlers/gh-proxy";
import { handleSubjectsReport, handleSubjectsState } from "./handlers/subjects";
import {
  handleCalendarToken,
  handleCalendarUpdate,
  handleCalendarIcs,
} from "./handlers/calendar";
import { handleClusterSvg } from "./handlers/clusters";
import { handleImageServe, handleImageUpload } from "./handlers/images";
import { handleAnnouncement } from "./handlers/announcement";
import { handleStats } from "./handlers/stats";
import { handleSessions } from "./handlers/sessions";
import { handleExport } from "./handlers/export";
import { handleLogtimeHistory } from "./handlers/logtime-history";
import { handleEvaluations } from "./handlers/evaluations";
import { ftConfigured } from "./ft-api";
import { publicRecord } from "./public-visuals";
import { kvRecord } from "./sessions";
import { Env } from "./types";
import {
  errorRes,
  getBearerToken,
  jsonRes,
  isLoginHash,
  isOriginAllowed,
  methodNotAllowedRes,
  notFoundRes,
  serverErrorRes,
  unauthorizedRes,
} from "./utils";

/**
 * This worker serves the Intra-login build of the extension: sign-in with the
 * Intra session, no 42 OAuth login, no Discord, no R2. Upstream's routes that
 * needed those (OAuth login, evaluation reminders and their crons, Discord,
 * the students directory, the 42 API proxy...) are gone rather than answering
 * errors. The deployment's own 42 application, when configured (src/ft-api.ts),
 * serves read-only additions such as your logtime history; without it they
 * answer 404 as before.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (e) {
      return serverErrorRes(e, env, request);
    }
  },
};

/**
 * Routes that name a user through `login=<hash>`. The private ones check the
 * session in D1 (src/sessions.ts) and read the KV record only when they need
 * it.
 */
const USER_ROUTES = new Set([
  "/api/v1/public/visuals",
  "/api/v1/private/settings",
  "/api/v1/private/sessions",
  "/api/v1/private/subjects/report",
  "/api/v1/private/subjects/state",
  "/api/v1/private/calendar/token",
  "/api/v1/private/calendar/update",
  "/api/v1/private/images",
  "/api/v1/private/export",
  "/api/v1/private/logtime/history",
  "/api/v1/private/evaluations",
]);

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");

  if (origin && !isOriginAllowed(origin)) {
    // JSON like every error, but without the CORS headers: that page must
    // not read anything from here.
    return new Response(
      JSON.stringify({ error: "unauthorized", message: "Origin not allowed" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  if (request.method === "OPTIONS") {
    const acao = origin || "*";
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": acao,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        // Every authenticated call is preflighted (Authorization header) and
        // the browser default keeps the answer 5 s: without this, each worker
        // call is two invocations. Chrome caps the cache at 7,200 s, Firefox
        // honours a day.
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      },
    });
  }

  // Login with the Intra v3 session token (no 42 OAuth application needed)
  if (url.pathname === "/auth/intra") {
    return handleIntraAuth(request, env);
  }

  if (url.pathname.startsWith("/gh/")) {
    return handleGhProxy(request);
  }

  if (url.pathname === "/api/v1/cluster/svg") {
    return handleClusterSvg(request, env, origin);
  }

  const imgMatch = url.pathname.match(/^\/img\/([a-f0-9]{64})\/([a-z]+)$/);
  if (imgMatch) {
    if (request.method !== "GET") return methodNotAllowedRes();
    return handleImageServe(
      env,
      imgMatch[1],
      imgMatch[2],
      url.searchParams.get("v"),
      url.origin,
    );
  }

  const calMatch = url.pathname.match(/^\/calendar\/([^\/]+)\.ics$/);
  if (calMatch) {
    return handleCalendarIcs(calMatch[1], env);
  }

  if (url.pathname === "/api/v1/public/announcement") {
    return handleAnnouncement(request, env);
  }

  if (url.pathname === "/api/v1/public/stats") {
    return handleStats(request, env);
  }

  // What this deployment can do beyond the routes every build relies on, so
  // the extension only offers a feature that will answer.
  if (url.pathname === "/api/v1/public/features") {
    if (request.method !== "GET") return methodNotAllowedRes();
    return jsonRes({ features: { logtimeHistory: ftConfigured(env), evaluations: ftConfigured(env) } }, 200, {
      "Cache-Control": "public, max-age=300",
    });
  }

  // Without the 42 application the route does not exist, before any read.
  if (
    (url.pathname === "/api/v1/private/logtime/history" ||
      url.pathname === "/api/v1/private/evaluations") &&
    !ftConfigured(env)
  ) {
    return notFoundRes();
  }

  const loginsParam = url.searchParams.get("logins");
  if (url.pathname === "/api/v1/public/visuals" && loginsParam !== null) {
    return handlePublicVisualsBatch(request, env, loginsParam);
  }

  // Unknown paths are 404 whatever the query: the login checks below are for
  // the user routes only.
  if (!USER_ROUTES.has(url.pathname)) return notFoundRes();

  const loginParam = url.searchParams.get("login");
  if (!loginParam) {
    return errorRes("bad_request", "Username hash required", 400);
  }
  if (!isLoginHash(loginParam)) {
    return errorRes("bad_request", "Invalid username hash", 400);
  }

  // Every private route needs a Bearer token: refusing here, before any KV
  // or D1 read, means an anonymous scanner spends nothing out of the daily
  // budgets. Same 401 as a wrong token or an unknown login.
  if (url.pathname.startsWith("/api/v1/private/") && !getBearerToken(request)) {
    return unauthorizedRes();
  }

  // Read on first use, at most once: the routes that only need the session
  // never read it once the login is migrated.
  const record = kvRecord(env, loginParam);

  if (url.pathname === "/api/v1/public/visuals") {
    // The public_visuals row in D1, else the KV record: see src/public-visuals.ts
    return handlePublicVisuals(request, () => publicRecord(env, loginParam, record));
  }

  if (url.pathname === "/api/v1/private/settings") {
    return handlePrivateSettings(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/sessions") {
    return handleSessions(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/subjects/report") {
    return handleSubjectsReport(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/subjects/state") {
    return handleSubjectsState(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/images") {
    // POST uploads, DELETE removes a slot
    return handleImageUpload(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/calendar/token") {
    return handleCalendarToken(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/export") {
    return handleExport(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/logtime/history") {
    return handleLogtimeHistory(request, env, loginParam, record);
  }

  if (url.pathname === "/api/v1/private/evaluations") {
    return handleEvaluations(request, env, loginParam, record);
  }

  // USER_ROUTES leaves only /api/v1/private/calendar/update here
  return handleCalendarUpdate(request, env, loginParam, record);
}
