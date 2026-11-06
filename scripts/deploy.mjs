#!/usr/bin/env node
/**
 * `npm run deploy`: the one way this worker goes live. `wrangler deploy`
 * alone type-checks nothing, runs no test, deploys whatever the working tree
 * holds, and leaves no record of which commit is live. This script refuses
 * to deploy:
 *
 *  - a tree with uncommitted changes (what goes live must be a commit);
 *  - when the tests or the type check fail;
 *  - while migrations/ holds a file the live database has not applied: the
 *    worker would answer 500 on the routes that need the new tables. It
 *    reads the live d1_migrations table (read-only) and prints the apply
 *    command.
 *
 * Then it runs `wrangler deploy --tag <commit> --message "<commit> <subject>"`,
 * so `npx wrangler deployments list` shows which commit each version is, and
 * prints how to roll back.
 *
 *   npm run deploy                 checks, then deploys
 *   npm run deploy -- --dry-run    checks (not the live migrations), then
 *                                  `wrangler deploy --dry-run`: builds,
 *                                  uploads nothing
 *
 * Plain Node, no shell: works the same from cmd, PowerShell and bash. Needs a
 * logged-in wrangler (`npx wrangler login`).
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DATABASE = "better-intra-d1";
export const APPLIED_MIGRATIONS_QUERY = "SELECT name FROM d1_migrations ORDER BY id";
/** The Cloudflare API caps a version message; wrangler does not check. */
export const MAX_MESSAGE_LENGTH = 100;

/**
 * Names of the migrations the live database applied, from the output of
 * `wrangler d1 execute --json` (`[{"results":[{"name":...}],...}]`). A
 * database that never applied one has no d1_migrations table: nothing
 * applied. Throws on any other error.
 */
export function parseAppliedMigrations(stdout, status) {
  const start = stdout.search(/[[{]/);
  let data;
  try {
    data = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    throw new Error(`could not read the live migrations (wrangler exit ${status}): ${stdout.trim().slice(0, 300)}`);
  }
  if (!Array.isArray(data)) {
    const text = String(data?.error?.text ?? JSON.stringify(data));
    if (/no such table: d1_migrations/.test(text)) return [];
    throw new Error(`could not read the live migrations: ${text}`);
  }
  if (status !== 0) throw new Error(`could not read the live migrations (wrangler exit ${status})`);
  return data.flatMap((r) => (Array.isArray(r?.results) ? r.results : [])).map((row) => String(row.name));
}

/** Local migration files the live database has not applied, in order. */
export function pendingMigrations(local, applied) {
  const done = new Set(applied);
  return local.filter((name) => !done.has(name));
}

/** "<commit> <subject>", cut to what the API takes. */
export function versionMessage(sha, subject) {
  const message = `${sha} ${subject}`.replace(/\s+/g, " ").trim();
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : message;
}

/**
 * The deploy, with every command behind `run(tool, args, { capture })`
 * (tool: "git", "vitest", "tsc" or "wrangler"; answers {status, stdout,
 * stderr}; `capture` false streams the output to the terminal). Returns the
 * exit code.
 */
/** Blocks for `ms` (the script is synchronous: spawnSync all the way). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Tries to read the live migrations this many times. The Cloudflare API
 * answered "A request to the Cloudflare API (.../d1/database/.../query)
 * failed" on the first try of two deploys in a row (2026-11-04), and the
 * second try passed both times.
 */
export const LIVE_READ_ATTEMPTS = 2;
const LIVE_READ_PAUSE_MS = 3000;

export function deploy({
  run,
  migrations,
  dryRun = false,
  log = console.log,
  error = console.error,
  pause = sleepSync,
}) {
  const git = (...args) => run("git", args, { capture: true });

  const tree = git("status", "--porcelain");
  if (tree.status !== 0) {
    error(`git status failed: ${tree.stderr.trim()}`);
    return 1;
  }
  if (tree.stdout.trim()) {
    error("Refusing to deploy: the working tree has uncommitted changes. Commit them first, so the live version is a commit:");
    error(tree.stdout.trimEnd());
    return 1;
  }
  const sha = git("rev-parse", "--short", "HEAD").stdout.trim();
  const subject = git("log", "-1", "--format=%s").stdout.trim();
  if (!git("branch", "-r", "--contains", "HEAD").stdout.trim()) {
    log(`Note: ${sha} is not on any remote branch yet; push it so the live version can be found in the repository.`);
  }

  for (const [name, tool, args] of [
    ["tests", "vitest", ["run"]],
    ["type check", "tsc", ["--noEmit", "-p", "."]],
  ]) {
    log(`> ${name}`);
    if (run(tool, args, { capture: false }).status !== 0) {
      error(`Refusing to deploy: the ${name} failed.`);
      return 1;
    }
  }

  if (dryRun) {
    log("> live D1 migrations: not checked in a dry run");
  } else {
    log("> live D1 migrations");
    let applied;
    for (let attempt = 1; ; attempt++) {
      const query = run(
        "wrangler",
        ["d1", "execute", DATABASE, "--remote", "--json", "--command", APPLIED_MIGRATIONS_QUERY],
        { capture: true },
      );
      try {
        applied = parseAppliedMigrations(query.stdout, query.status);
        break;
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (attempt < LIVE_READ_ATTEMPTS) {
          log(`  could not read them (${reason.slice(0, 120)}), trying again`);
          pause(LIVE_READ_PAUSE_MS);
          continue;
        }
        error(`Refusing to deploy: ${reason}`);
        if (query.stderr.trim()) error(query.stderr.trim());
        return 1;
      }
    }
    const pending = pendingMigrations(migrations, applied);
    if (pending.length > 0) {
      error(`Refusing to deploy: the live database has not applied ${pending.join(", ")}.`);
      error(`Apply them first (they only add tables and columns): npx wrangler d1 migrations apply ${DATABASE} --remote`);
      return 1;
    }
  }

  log(`> wrangler deploy (${sha})`);
  const deployed = run(
    "wrangler",
    ["deploy", "--tag", sha, "--message", versionMessage(sha, subject), ...(dryRun ? ["--dry-run"] : [])],
    { capture: false },
  );
  if (deployed.status !== 0) {
    error("wrangler deploy failed: nothing changed if it failed before the upload.");
    return deployed.status || 1;
  }
  if (!dryRun) {
    log("");
    // The URL wrangler printed: a self-hosted copy runs under its own name
    // and account subdomain, so a host written here would check someone else's.
    log(`Deployed ${sha}. Check: curl <the URL wrangler printed above>/api/v1/public/stats answers 200 JSON.`);
    log("To roll back (a live change, ask first): npx wrangler deployments list, then");
    log('  npx wrangler rollback <version-id> --message "<why>"');
    log("A rollback restores code and config only, never the D1 schema or the KV data (README, Deploy and roll back).");
  }
  return 0;
}

/** run() for deploy(): the local bins through Node, git from PATH, no shell. */
function localRunner(cwd) {
  const require = createRequire(import.meta.url);
  const bin = (pkg, path) => join(dirname(require.resolve(`${pkg}/package.json`)), path);
  const bins = {
    vitest: bin("vitest", "vitest.mjs"),
    tsc: bin("typescript", "bin/tsc"),
    wrangler: bin("wrangler", "bin/wrangler.js"),
  };
  return (tool, args, { capture }) => {
    const [command, argv] = tool === "git" ? ["git", args] : [process.execPath, [bins[tool], ...args]];
    const r = spawnSync(command, argv, {
      cwd,
      stdio: capture ? "pipe" : "inherit",
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) return { status: 1, stdout: "", stderr: String(r.error.message) };
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

function main(argv) {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const migrations = readdirSync(join(cwd, "migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return deploy({ run: localRunner(cwd), migrations, dryRun: argv.includes("--dry-run") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
