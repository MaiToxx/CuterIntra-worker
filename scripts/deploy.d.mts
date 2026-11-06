/** Types of scripts/deploy.mjs, for the tests. */
export declare const DATABASE: string;
export declare const APPLIED_MIGRATIONS_QUERY: string;
export declare const MAX_MESSAGE_LENGTH: number;
export declare const LIVE_READ_ATTEMPTS: number;

export type Tool = "git" | "vitest" | "tsc" | "wrangler";
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}
export type Run = (tool: Tool, args: string[], options: { capture: boolean }) => RunResult;

export declare function parseAppliedMigrations(stdout: string, status: number): string[];
export declare function pendingMigrations(local: string[], applied: string[]): string[];
export declare function versionMessage(sha: string, subject: string): string;
export declare function deploy(options: {
  run: Run;
  migrations: string[];
  dryRun?: boolean;
  log?: (line: string) => void;
  error?: (line: string) => void;
  /** Waits between two reads of the live migrations (tests pass a no-op). */
  pause?: (ms: number) => void;
}): number;
