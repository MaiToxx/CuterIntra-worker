export interface Env {
  BETTER_INTRA_KV: KVNamespace;
  better_intra_d1: D1Database;
  /**
   * Workers rate limit bindings (wrangler.json "ratelimits"). Optional: a
   * deployment or a test without them falls back to the in-isolate buckets of
   * src/rate-limit.ts.
   */
  WRITE_RL?: RateLimit;
  ANON_RL?: RateLimit;
  VISUALS_RL?: RateLimit;
  ADMIN_RL?: RateLimit;
  ANNOUNCEMENT_SECRET?: string;
  /**
   * Comma-separated clients (`azp`) whose Intra tokens may sign in
   * (wrangler.json "vars"). Empty or missing: no client check, so a wrong
   * value is undone by editing the variable (see src/handlers/intra-auth.ts).
   */
  JWT_ALLOWED_AZP?: string;
  /**
   * The deployment's 42 API application (src/ft-api.ts), both set with
   * `npx wrangler secret put`. Missing: the routes that need the 42 API answer
   * 404. The secret changes about every 30 days on 42's side.
   */
  FT_CLIENT_ID?: string;
  FT_CLIENT_SECRET?: string;
}

export type UserData = {
  /**
   * Legacy: the session tokens, in clear, from before sessions moved to D1.
   * Read once per login to copy them there (src/sessions.ts), never written
   * again, and dropped by the record's next write.
   */
  sessionTokens?: string[];
  sessionToken?: string; // legacy of the legacy: one token
  settings?: Record<string, unknown>;
  /**
   * Revision of `settings`: max(Date.now(), previous + 1) at each write, so it
   * only grows. Absent (read as 0) on records not pushed since it exists. A
   * push that names the revision it started from is refused when the stored
   * one is newer (src/handlers/settings.ts).
   */
  settingsRev?: number;
};
