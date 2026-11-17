/**
 * Antigravity quota through the `agy` CLI.
 *
 * Bridge-style installs (`@estebanforge/pi-antigravity-bridge` and anything
 * else driving Antigravity over ACP) keep the Google identity inside Google's
 * own CLI, so Pi's auth.json carries no `antigravity` entry. These tests pin
 * the discovery rule, the bucket mapping and every degradation path against
 * the payload the live CLI returned for `agy --print /usage --output-format
 * json`, not a hand-written guess.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AGY_BIN_ENV, loadAgyCredential, resolveAgyBinary } from "../src/auth/agy-auth.js";
import { AGY_USAGE_ARGS, fetchQuota as fetchAntigravityAgy, parseAgyUsage } from "../src/providers/antigravity-agy.js";
import { agyUsageBody } from "./helpers.mjs";

const NOW = 1_800_000_000_000;

/** One executable file named `agy`, never spawned by these tests. */
function fakeBinary(dir, name = "agy") {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 1\n");
  chmodSync(path, 0o755);
  return path;
}

test("agy: an executable named agy on PATH becomes the quota source", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-bin-"));
  const binary = fakeBinary(dir);
  assert.equal(resolveAgyBinary({ env: { PATH: `${join(dir, "nope")}:${dir}` }, home: dir }), binary);
  assert.equal(resolveAgyBinary({ env: { PATH: join(dir, "empty") }, home: dir }), null);
});

test("agy: PI_QUOTA_AGY_BIN wins over PATH discovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-explicit-"));
  const explicit = join(dir, "custom-agy");
  assert.equal(resolveAgyBinary({ env: { PATH: "", [AGY_BIN_ENV]: explicit }, home: dir }), explicit);
});

test("agy: the fallback credential points at the binary, never at a token store", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-cred-"));
  const binary = fakeBinary(dir);
  const credential = loadAgyCredential({ env: { PATH: dir }, home: dir });
  assert.ok(credential);
  assert.equal(credential.family, "antigravity");
  assert.equal(credential.sourceKind, "agy-cli");
  assert.equal(credential.source, binary);
  assert.equal(credential.expiresAtMs, null);
  assert.equal(credential.access, undefined);
  assert.equal(credential.refresh, undefined);
});

test("agy: PI_QUOTA_ANTIGRAVITY_SOURCE=pi and hermetic path overrides disable it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-off-"));
  fakeBinary(dir);
  assert.equal(loadAgyCredential({ env: { PATH: dir, PI_QUOTA_ANTIGRAVITY_SOURCE: "pi" }, home: dir }), null);
  assert.equal(loadAgyCredential({ env: { PATH: dir }, home: dir, paths: ["/tmp/fixture-auth.json"] }), null);
  assert.ok(loadAgyCredential({ env: { PATH: dir }, home: dir, paths: ["/tmp/fixture-auth.json"], binary: join(dir, "agy") }));
});

test("agy: parse maps the live payload into groups and buckets", () => {
  const report = parseAgyUsage(JSON.stringify(agyUsageBody()));
  assert.deepEqual(report.groups.map((group) => group.name), ["Gemini Models", "Claude and GPT models"]);
  assert.equal(report.groups[0].buckets.length, 2);
  assert.deepEqual(report.groups[0].buckets[0], {
    id: "gemini-weekly",
    name: "Weekly Limit Remaining",
    window: "weekly",
    remainingFraction: 0.9823,
    resetTime: "2030-01-08T08:06:47Z",
    description: "You have used some of your weekly limit.",
  });
});

test("agy: parse unwraps a stream-json result envelope and rejects a non-success status", () => {
  const wrapped = { event: "result", result: agyUsageBody() };
  assert.equal(parseAgyUsage(JSON.stringify(wrapped)).groups.length, 2);

  const failed = JSON.stringify({ ...agyUsageBody(), status: "ERROR" });
  assert.throws(() => parseAgyUsage(failed), /status ERROR/);
});

test("agy: parse reports a short reason instead of throwing a stack for bad output", () => {
  assert.throws(() => parseAgyUsage("not json"), /not JSON/);
  assert.throws(() => parseAgyUsage(JSON.stringify({ status: "SUCCESS" })), /not a \/usage command result/);
  assert.throws(() => parseAgyUsage(JSON.stringify(agyUsageBody({ groups: [] }))), /no quota groups/);
});

test("agy: fetch runs the zero-token usage command and returns both windows per group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-agy-fetch-"));
  const binary = fakeBinary(dir);
  const credential = loadAgyCredential({ env: { PATH: dir }, home: dir });
  assert.ok(credential);

  const calls = [];
  const runCommand = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: JSON.stringify(agyUsageBody()), stderr: "", error: null };
  };

  const result = await fetchAntigravityAgy(credential, { now: NOW, runCommand });
  assert.equal(result.ok, true);
  assert.equal(result.account, "agy CLI");
  assert.equal(result.sourceKind, "agy-cli");
  assert.equal(result.source, binary);
  assert.deepEqual(calls, [{ command: binary, args: AGY_USAGE_ARGS }]);
  assert.deepEqual(result.windows.map((window) => window.id), ["gemini-weekly", "gemini-5h", "claude-gpt-weekly"]);
  assert.deepEqual(result.windows.map((window) => window.label), ["Gemini · weekly", "Gemini · 5h", "Claude/GPT · weekly"]);
  const weekly = result.windows[0];
  assert.ok(Math.abs((weekly.usedPercent ?? 0) - 1.77) < 0.001, `usedPercent was ${weekly.usedPercent}`);
  assert.equal(weekly.resetsAt, new Date("2030-01-08T08:06:47Z").toISOString());
});

test("agy: a missing binary degrades with an actionable message", async () => {
  const credential = { family: "antigravity", source: "/nonexistent/agy", sourceKind: "agy-cli", expiresAtMs: null };
  const result = await fetchAntigravityAgy(credential, {
    now: NOW,
    runCommand: () => ({ status: null, stdout: "", stderr: "", error: "spawnSync /nonexistent/agy ENOENT" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /agy CLI was not found/);
  assert.match(result.error ?? "", new RegExp(AGY_BIN_ENV));
});

test("agy: an authentication failure becomes a login hint, other exits stay diagnostics", async () => {
  const credential = { family: "antigravity", source: "/opt/agy", sourceKind: "agy-cli", expiresAtMs: null };
  const authFailure = await fetchAntigravityAgy(credential, {
    now: NOW,
    runCommand: () => ({ status: 1, stdout: "", stderr: "Error: not logged in. Run `agy` to sign in.", error: null }),
  });
  assert.equal(authFailure.ok, false);
  assert.match(authFailure.error ?? "", /agy login|not logged in/);

  const broken = await fetchAntigravityAgy(credential, {
    now: NOW,
    runCommand: () => ({ status: 2, stdout: "", stderr: "segfault", error: null }),
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error ?? "", /exited with status 2/);

  const empty = await fetchAntigravityAgy(credential, {
    now: NOW,
    runCommand: () => ({ status: 0, stdout: "", stderr: "", error: null }),
  });
  assert.equal(empty.ok, false);
  assert.match(empty.error ?? "", /no output/);
});
