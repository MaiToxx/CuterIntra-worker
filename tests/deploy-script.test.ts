import { describe, it, expect } from "vitest";
import {
  APPLIED_MIGRATIONS_QUERY,
  MAX_MESSAGE_LENGTH,
  deploy,
  parseAppliedMigrations,
  pendingMigrations,
  versionMessage,
  type Run,
  type RunResult,
  type Tool,
} from "../scripts/deploy.mjs";
import { MIGRATIONS } from "./helpers/fake-env";

const LOCAL = ["0001_baseline.sql", "0002_sessions.sql", "0003_kv_write_budget.sql"];

/** What `wrangler d1 execute --json` prints for the applied migrations. */
const appliedJson = (names: string[]) =>
  `\n${JSON.stringify([{ results: names.map((name) => ({ name })), success: true, meta: { duration: 0 } }], null, 2)}\n`;
/** What it prints for a database that never applied a migration. */
const NO_TABLE = `\n{\n  "error": {\n    "text": "no such table: d1_migrations: SQLITE_ERROR"\n  }\n}\n`;

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

/**
 * A run() that answers like a clean, committed tree whose checks pass and
 * whose live database applied `applied`; `override` changes one answer.
 */
function fakeRun(
  applied: RunResult = ok(appliedJson(LOCAL)),
  override: (tool: Tool, args: string[]) => RunResult | undefined = () => undefined,
) {
  const calls: { tool: Tool; args: string[]; capture: boolean }[] = [];
  const run: Run = (tool, args, { capture }) => {
    calls.push({ tool, args, capture });
    const answer = override(tool, args);
    if (answer) return answer;
    if (tool === "git") {
      if (args[0] === "status") return ok("");
      if (args[0] === "rev-parse") return ok("abc1234\n");
      if (args[0] === "log") return ok("Worker for extension 1.18: sessions in D1\n");
      if (args[0] === "branch") return ok("  origin/main\n");
    }
    if (tool === "wrangler" && args[0] === "d1") return applied;
    return ok();
  };
  const lines: string[] = [];
  const errors: string[] = [];
  const go = (dryRun = false) =>
    deploy({
      run,
      migrations: LOCAL,
      dryRun,
      log: (l) => lines.push(l),
      error: (l) => errors.push(l),
      pause: () => {},
    });
  return { run, calls, lines, errors, go };
}

const deployCall = (calls: { tool: Tool; args: string[] }[]) =>
  calls.find((c) => c.tool === "wrangler" && c.args[0] === "deploy");

describe("scripts/deploy.mjs", () => {
  it("deploys a clean, tested commit, tagged with it, once the live database has every migration", () => {
    const { calls, lines, go } = fakeRun();
    expect(go()).toBe(0);
    expect(calls.map((c) => c.tool)).toEqual(["git", "git", "git", "git", "vitest", "tsc", "wrangler", "wrangler"]);
    expect(calls.find((c) => c.tool === "vitest")!.args).toEqual(["run"]);
    expect(calls.find((c) => c.tool === "tsc")!.args).toEqual(["--noEmit", "-p", "."]);
    // the live check is read-only: one SELECT
    expect(calls[6].args).toEqual([
      "d1",
      "execute",
      "better-intra-d1",
      "--remote",
      "--json",
      "--command",
      APPLIED_MIGRATIONS_QUERY,
    ]);
    expect(APPLIED_MIGRATIONS_QUERY).toMatch(/^SELECT /);
    expect(deployCall(calls)!.args).toEqual([
      "deploy",
      "--tag",
      "abc1234",
      "--message",
      "abc1234 Worker for extension 1.18: sessions in D1",
    ]);
    expect(lines.join("\n")).toContain("npx wrangler rollback <version-id>");
    // self-hosted copies deploy under their own host: none is written in
    expect(lines.join("\n")).toContain("<the URL wrangler printed above>/api/v1/public/stats");
    expect(lines.join("\n")).not.toMatch(/\.workers\.dev/);
  });

  it("refuses a tree with uncommitted changes before running anything else", () => {
    const { calls, errors, go } = fakeRun(undefined, (tool, args) =>
      tool === "git" && args[0] === "status" ? ok(" M src/index.ts\n?? migrations/0005_x.sql\n") : undefined,
    );
    expect(go()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(errors.join("\n")).toContain("src/index.ts");
  });

  for (const tool of ["vitest", "tsc"] as const) {
    it(`refuses when ${tool} fails, before touching the live database`, () => {
      const { calls, go } = fakeRun(undefined, (t) => (t === tool ? { status: 1, stdout: "", stderr: "" } : undefined));
      expect(go()).toBe(1);
      expect(calls.some((c) => c.tool === "wrangler")).toBe(false);
    });
  }

  it("refuses while the live database misses a migration, and says how to apply it", () => {
    const { calls, errors, go } = fakeRun(ok(appliedJson(LOCAL.slice(0, 2))));
    expect(go()).toBe(1);
    expect(deployCall(calls)).toBeUndefined();
    expect(errors.join("\n")).toContain("0003_kv_write_budget.sql");
    expect(errors.join("\n")).toContain("npx wrangler d1 migrations apply better-intra-d1 --remote");
  });

  it("counts every migration as pending on a database that never applied one", () => {
    const { calls, errors, go } = fakeRun({ status: 1, stdout: NO_TABLE, stderr: "" });
    expect(go()).toBe(1);
    expect(deployCall(calls)).toBeUndefined();
    expect(errors[0]).toContain(LOCAL.join(", "));
  });

  it("refuses when the live database cannot be read (not logged in, offline)", () => {
    const { calls, errors, go } = fakeRun({ status: 1, stdout: "", stderr: "You are not authenticated." });
    expect(go()).toBe(1);
    expect(deployCall(calls)).toBeUndefined();
    expect(errors.join("\n")).toContain("You are not authenticated.");
  });

  it("reads the live migrations a second time when the first read fails, then deploys", () => {
    let reads = 0;
    const { calls, lines, go } = fakeRun(undefined, (tool, args) => {
      if (tool === "wrangler" && args[0] === "d1" && ++reads === 1) {
        return { status: 1, stdout: "", stderr: "A request to the Cloudflare API failed." };
      }
      return undefined;
    });
    expect(go()).toBe(0);
    expect(reads).toBe(2);
    expect(lines.join("\n")).toContain("trying again");
    expect(deployCall(calls)).toBeDefined();
  });

  it("gives up after the second failed read", () => {
    const { calls, go } = fakeRun({ status: 1, stdout: "", stderr: "down" });
    expect(go()).toBe(1);
    expect(calls.filter((c) => c.tool === "wrangler" && c.args[0] === "d1")).toHaveLength(2);
    expect(deployCall(calls)).toBeUndefined();
  });

  it("passes a failed deploy's exit code on", () => {
    const { go } = fakeRun(undefined, (tool, args) =>
      tool === "wrangler" && args[0] === "deploy" ? { status: 3, stdout: "", stderr: "" } : undefined,
    );
    expect(go()).toBe(3);
  });

  it("only warns about a commit not pushed yet", () => {
    const { calls, lines, go } = fakeRun(undefined, (tool, args) =>
      tool === "git" && args[0] === "branch" ? ok("") : undefined,
    );
    expect(go()).toBe(0);
    expect(lines.join("\n")).toContain("not on any remote branch");
    expect(deployCall(calls)).toBeDefined();
  });

  it("dry run: same checks but the live one, and wrangler's own --dry-run", () => {
    const { calls, go } = fakeRun();
    expect(go(true)).toBe(0);
    expect(calls.some((c) => c.args.includes("--remote"))).toBe(false);
    expect(deployCall(calls)!.args.at(-1)).toBe("--dry-run");
  });
});

describe("deploy helpers", () => {
  it("read wrangler's JSON, with or without a leading blank line", () => {
    expect(parseAppliedMigrations(appliedJson(LOCAL), 0)).toEqual(LOCAL);
    expect(parseAppliedMigrations(NO_TABLE, 1)).toEqual([]);
    expect(() => parseAppliedMigrations(`{"error":{"text":"Authentication error [code: 10000]"}}`, 1)).toThrow(
      /Authentication error/,
    );
    expect(() => parseAppliedMigrations("✘ [ERROR] something", 1)).toThrow(/could not read/);
  });

  it("list the local files missing from the live list, in order", () => {
    expect(pendingMigrations(LOCAL, ["0002_sessions.sql"])).toEqual(["0001_baseline.sql", "0003_kv_write_budget.sql"]);
    expect(pendingMigrations(LOCAL, [...LOCAL, "0000_other.sql"])).toEqual([]);
    // the real files are what main() passes
    expect(pendingMigrations(MIGRATIONS.map((m) => m.name), [])).toHaveLength(MIGRATIONS.length);
  });

  it("keep the version message to what the API takes", () => {
    expect(versionMessage("abc1234", "Short\nsubject")).toBe("abc1234 Short subject");
    const long = versionMessage("abc1234", "x".repeat(300));
    expect(long).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(long.startsWith("abc1234 xxx")).toBe(true);
  });
});
