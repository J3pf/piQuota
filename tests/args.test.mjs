/**
 * CLI argument parsing.
 *
 * Two defects hid here for a while, and both were silent:
 *
 *   1. `parsed.unknown` was filled but never read, so `piquota --stauts` ran a
 *      normal report instead of complaining — a typo looked like a no-op.
 *   2. The CLI rebuilt its positional list by filtering the raw argv for "does not
 *      start with a dash", which also kept the *values* of value flags: `--ttl 300`
 *      made `300` a family name.
 *
 * Neither surfaced in a normal run, which is exactly why they are pinned here.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseArgs } from "../src/cli/args.js";

const CLI = fileURLToPath(new URL("../bin/piquota.js", import.meta.url));

test("own value flags are consumed with their value", () => {
  const ttl = parseArgs(["--ttl", "300", "--compact"]);
  assert.equal(ttl.ttlMs, 300_000);
  assert.deepEqual(ttl.positionals, []);
  assert.deepEqual(ttl.unknown, []);
  assert.equal(ttl.compact, true);

  const timeout = parseArgs(["--timeout", "5000"]);
  assert.equal(timeout.timeoutMs, 5000);
  assert.deepEqual(timeout.positionals, []);
  assert.deepEqual(timeout.unknown, []);
});

test("a non-numeric value for an own flag is reported, never silently dropped", () => {
  const parsed = parseArgs(["--ttl", "abc"]);
  assert.deepEqual(parsed.positionals, []);
  assert.deepEqual(parsed.unknown, ["--ttl", "abc"]);
  assert.equal(parsed.ttlMs, 60_000, "the default is kept when the value is unusable");
});

test("subcommand value flags stay out of both positionals and unknown", () => {
  const watch = parseArgs(["moshi", "watch", "--interval", "30", "--fetch-ttl", "300", "--claude-ttl", "180"]);
  assert.deepEqual(watch.positionals, ["moshi", "watch"]);
  assert.deepEqual(watch.unknown, [], "a subcommand flag is not a typo");
});

test("subcommand booleans stay out of unknown", () => {
  for (const argv of [
    ["moshi", "artifact", "--print"],
    ["claude", "--no-refresh"],
    ["auth", "opencode", "--paste"],
    ["auth", "opencode", "--no-browser"],
  ]) {
    const parsed = parseArgs(argv);
    assert.deepEqual(parsed.unknown, [], `argv ${argv.join(" ")}`);
  }
});

test("a subcommand value flag without a usable value is reported", () => {
  assert.deepEqual(parseArgs(["moshi", "watch", "--interval"]).unknown, ["--interval"]);
  assert.deepEqual(parseArgs(["moshi", "watch", "--interval", "--fetch-ttl", "300"]).unknown, ["--interval"]);
});

test("--box enables the compact box widget", () => {
  const args = parseArgs(["--box"]);
  assert.equal(args.box, true);
  assert.deepEqual(args.unknown, []);
});

test("a genuinely unknown flag is collected for the caller to reject", () => {
  assert.deepEqual(parseArgs(["--banana"]).unknown, ["--banana"]);
  assert.deepEqual(parseArgs(["--stauts"]).unknown, ["--stauts"]);
  assert.deepEqual(parseArgs(["-x"]).unknown, ["-x"]);
});

test("the two flags that once parsed and did nothing are gone", () => {
  // They were accepted and ignored, which made them look supported.
  assert.deepEqual(parseArgs(["--no-pi"]).unknown, ["--no-pi"]);
  assert.deepEqual(parseArgs(["--show-email"]).unknown, ["--show-email"]);
});

test("real families still resolve, and an unknown positional is not a family", () => {
  const parsed = parseArgs(["claude", "codex", "--status"]);
  assert.deepEqual(parsed.positionals, ["claude", "codex"]);
  assert.deepEqual(parsed.unknown, []);
});

/**
 * @param {string[]} argv
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runCli(argv) {
  const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf-8", timeout: 60_000 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the CLI rejects an unknown flag instead of running anyway", () => {
  // `moshi status` touches no network, so a failure here is about parsing alone.
  const result = runCli(["moshi", "status", "--stauts"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag: --stauts/);
  assert.equal(result.stdout.includes("state dir:"), false, "the status report must not run after a rejected flag");
});

test("a value flag no longer turns its value into a family name", () => {
  const result = runCli(["moshi", "status", "--ttl", "300"]);
  assert.equal(result.status, 0, `stderr was: ${result.stderr}`);
  assert.equal(result.stderr.includes("unknown argument: 300"), false);
  assert.match(result.stdout, /Moshi/);
});

test("a valid report still exits zero and prints one line", () => {
  const result = runCli(["moshi", "status"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /publisher:/);
});
