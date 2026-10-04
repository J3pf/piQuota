/**
 * Per-family refresh cadence.
 *
 * The watcher used to run on one clock: refetch everything every 300 s and re-push
 * the same numbers five times in between. Claude genuinely needs that slow clock —
 * Anthropic answers 429 when the usage endpoint is polled every minute — but the
 * other three providers do not, and they were paying for it.
 *
 * These tests pin the split, the merge back into one canonical report, and the fact
 * that a family's own clock survives a restart.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CLAUDE_TTL_SEC,
  DEFAULT_FAMILY_TTL_SEC,
  collectWithCadence,
  mergeReports,
  readRefreshState,
  resolveFamilyTtls,
  resolveRefreshStatePath,
  staleFamilies,
  writeRefreshState,
} from "../src/refresh.js";
import { writeCache } from "../src/cache.js";
import { FAMILIES } from "../src/engine.js";

const NOW = 1_800_000_000_000;
const ALL = ["claude", "codex", "antigravity", "opencode-go"];

/**
 * @param {string} family
 * @param {{ usedPercent?: number, ok?: boolean, error?: string | null }} [options]
 */
function provider(family, options = {}) {
  const ok = options.ok ?? true;
  return {
    family,
    label: `${family} (Pi)`,
    primaryWindowId: ok ? "5h" : null,
    account: "fixture@example.com",
    plan: null,
    windows: ok
      ? [{ id: "5h", label: "5h", usedPercent: options.usedPercent ?? 10, remainingPercent: 90, resetsAt: null, resetsInSec: 3600, note: null }]
      : [],
    error: options.error ?? null,
    ok,
    updatedAt: new Date(NOW).toISOString(),
    source: "/tmp/auth.json",
    sourceKind: "pi",
    expiresInMin: 60,
  };
}

/**
 * @param {string[]} families
 * @param {string[]} [warnings]
 */
function report(families, warnings = []) {
  const providers = families.map((family) => provider(family));
  return {
    engine: "pi-quota",
    schemaVersion: 1,
    readOnly: true,
    generatedAt: new Date(NOW).toISOString(),
    sources: ["/tmp/auth.json"],
    warnings,
    providers,
    byFamily: Object.fromEntries(families.map((family, index) => [family, [providers[index]]])),
  };
}

test("the slow clock is Claude's alone", () => {
  const ttls = resolveFamilyTtls({});
  assert.equal(ttls.claude, CLAUDE_TTL_SEC);
  assert.equal(ttls.codex, DEFAULT_FAMILY_TTL_SEC);
  assert.equal(ttls.antigravity, DEFAULT_FAMILY_TTL_SEC);
  assert.equal(ttls["opencode-go"], DEFAULT_FAMILY_TTL_SEC);
  assert.equal(CLAUDE_TTL_SEC > DEFAULT_FAMILY_TTL_SEC, true);
});

test("the watcher's fetch TTL drives the fast families, not Claude's", () => {
  const ttls = resolveFamilyTtls({ defaultTtlSec: 45 });
  assert.equal(ttls.codex, 45);
  assert.equal(ttls.claude, CLAUDE_TTL_SEC, "Claude keeps its own clock");

  const overridden = resolveFamilyTtls({ defaultTtlSec: 45, claudeTtlSec: 120 });
  assert.equal(overridden.claude, 120);
  assert.equal(overridden.codex, 45);
});

test("only families past their own clock are stale", () => {
  const ttls = resolveFamilyTtls({ defaultTtlSec: 60 });
  const fetchedAtMs = Object.fromEntries(ALL.map((family) => [family, NOW - 90_000]));

  // 90 s ago: the three fast families are stale, Claude (300 s) is not.
  assert.deepEqual(staleFamilies({ fetchedAtMs, ttls, families: ALL, now: NOW }), ["codex", "antigravity", "opencode-go"]);

  // 400 s ago: everything is.
  const old = Object.fromEntries(ALL.map((family) => [family, NOW - 400_000]));
  assert.deepEqual(staleFamilies({ fetchedAtMs: old, ttls, families: ALL, now: NOW }), ALL);
});

test("a family that was never fetched is always stale", () => {
  const ttls = resolveFamilyTtls({});
  assert.deepEqual(staleFamilies({ fetchedAtMs: {}, ttls, families: ALL, now: NOW }), ALL);
  assert.deepEqual(staleFamilies({ fetchedAtMs: { codex: NOW }, ttls, families: ALL, now: NOW }), ["claude", "antigravity", "opencode-go"]);
});

test("the refresh state is private, atomic and survives a rewrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const statePath = join(dir, "state.json");

  assert.deepEqual(readRefreshState({ statePath }).fetchedAtMs, {});
  assert.equal(writeRefreshState({ fetchedAtMs: { codex: NOW } }, { statePath }).ok, true);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.deepEqual(readRefreshState({ statePath }).fetchedAtMs, { codex: NOW });

  writeRefreshState({ fetchedAtMs: { claude: NOW + 1 } }, { statePath });
  assert.deepEqual(readRefreshState({ statePath }).fetchedAtMs, { claude: NOW + 1 });
  assert.equal(resolveRefreshStatePath({ statePath }), statePath);
});

test("a corrupt refresh state is treated as empty instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, "{ truncated");

  const state = readRefreshState({ statePath });
  assert.deepEqual(state.fetchedAtMs, {});
  assert.match(state.error ?? "", /cannot parse/);
});

test("merging keeps the canonical family order whatever the fetch order was", () => {
  const merged = mergeReports([report(["codex", "antigravity"]), report(["claude"])], { families: ALL, now: NOW });

  assert.deepEqual(merged.providers.map((p) => p.family), ["claude", "codex", "antigravity"]);
  assert.deepEqual(Object.keys(merged.byFamily), ["claude", "codex", "antigravity"]);
  assert.equal(merged.readOnly, true);
  assert.equal(merged.engine, "pi-quota");
});

test("merging deduplicates sources and keeps warnings that belong to a kept family", () => {
  const fresh = report(["codex"], ["codex: throttled upstream; pausing that family for 300s"]);
  fresh.sources = ["/tmp/auth.json"];
  const cached = report(["claude"], ["claude: the token expired 2m ago; run `claude` once", "opencode-go: gone"]);
  cached.sources = ["/tmp/auth.json", "/tmp/other.json"];

  const merged = mergeReports([fresh, cached], { families: ALL, now: NOW, reused: ["claude"] });
  assert.deepEqual(merged.sources, ["/tmp/auth.json", "/tmp/other.json"]);
  assert.ok(merged.warnings.some((w) => w.startsWith("codex:")));
  assert.ok(merged.warnings.some((w) => w.startsWith("claude:")), "a warning about a family we kept must survive");
  assert.equal(merged.warnings.some((w) => w.startsWith("opencode-go:")), false, "a warning about a family we refetched must not");
});

test("nothing is fetched while every family is inside its clock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const cachePath = join(dir, "usage.json");
  const statePath = join(dir, "refresh.json");
  writeCache(report(ALL), { path: cachePath, now: NOW });
  writeRefreshState({ fetchedAtMs: Object.fromEntries(ALL.map((f) => [f, NOW])) }, { statePath });

  let loads = 0;
  const result = await collectWithCadence({
    families: ALL,
    cachePath,
    statePath,
    now: NOW,
    loader: async () => {
      loads += 1;
      return report(ALL);
    },
  });

  assert.equal(loads, 0);
  assert.deepEqual(result.fetched, []);
  assert.deepEqual(result.reused, ALL);
  assert.equal(result.report.providers.length, 4);
});

test("only the stale families are requested, and the rest are kept from the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const cachePath = join(dir, "usage.json");
  const statePath = join(dir, "refresh.json");

  // A cached report where every family has a distinct, recognisable value.
  const cached = report(ALL);
  cached.providers[1].windows[0].usedPercent = 33; // codex
  writeCache(cached, { path: cachePath, now: NOW });
  writeRefreshState(
    { fetchedAtMs: { claude: NOW, codex: NOW, antigravity: NOW, "opencode-go": NOW - 120_000 } },
    { statePath },
  );

  /** @type {string[][]} */
  const requested = [];
  const result = await collectWithCadence({
    families: ALL,
    cachePath,
    statePath,
    now: NOW,
    ttls: resolveFamilyTtls({ defaultTtlSec: 60 }),
    loader: async (families) => {
      requested.push(families);
      return report(families);
    },
  });

  assert.deepEqual(requested, [["opencode-go"]], "one call, only the stale family");
  assert.deepEqual(result.fetched, ["opencode-go"]);
  assert.deepEqual(result.reused, ["claude", "codex", "antigravity"]);

  // The freshly fetched family replaced its cached copy...
  const opencode = result.report.providers.find((p) => p.family === "opencode-go");
  assert.equal(opencode.windows[0].usedPercent, 10);
  // ...and the reused ones kept their cached values.
  const codex = result.report.providers.find((p) => p.family === "codex");
  assert.equal(codex.windows[0].usedPercent, 33);
  assert.deepEqual(result.report.providers.map((p) => p.family), ["claude", "codex", "antigravity", "opencode-go"]);
});

test("Claude keeps its slow clock while the rest refresh every minute", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const cachePath = join(dir, "usage.json");
  const statePath = join(dir, "refresh.json");
  writeCache(report(ALL), { path: cachePath, now: NOW - 90_000 });
  writeRefreshState({ fetchedAtMs: Object.fromEntries(ALL.map((f) => [f, NOW - 90_000])) }, { statePath });

  /** @type {string[][]} */
  const requested = [];
  await collectWithCadence({
    families: ALL,
    cachePath,
    statePath,
    now: NOW,
    ttls: resolveFamilyTtls({ defaultTtlSec: 60 }),
    loader: async (families) => {
      requested.push(families);
      return report(families);
    },
  });

  assert.deepEqual(requested, [["codex", "antigravity", "opencode-go"]]);
});

test("a fetch updates the clocks only for the families that were fetched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const cachePath = join(dir, "usage.json");
  const statePath = join(dir, "refresh.json");
  writeCache(report(ALL), { path: cachePath, now: NOW - 400_000 });
  writeRefreshState({ fetchedAtMs: { claude: NOW - 400_000, codex: NOW } }, { statePath });

  await collectWithCadence({
    families: ALL,
    cachePath,
    statePath,
    now: NOW,
    ttls: resolveFamilyTtls({ defaultTtlSec: 60 }),
    loader: async (families) => report(families),
  });

  const state = readRefreshState({ statePath });
  assert.equal(state.fetchedAtMs.codex, NOW, "unrelated clocks must not be touched");
  assert.equal(state.fetchedAtMs.claude, NOW);
  assert.equal(state.fetchedAtMs.antigravity, NOW);
  assert.equal(state.fetchedAtMs["opencode-go"], NOW);
});

test("the merged report is written back so the CLI surfaces benefit too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const cachePath = join(dir, "usage.json");
  const statePath = join(dir, "refresh.json");
  writeRefreshState({ fetchedAtMs: {} }, { statePath });

  await collectWithCadence({
    families: ALL,
    cachePath,
    statePath,
    now: NOW,
    loader: async (families) => report(families),
  });

  const written = JSON.parse(readFileSync(cachePath, "utf-8"));
  assert.equal(written.savedAt, NOW);
  assert.deepEqual(written.report.providers.map((p) => p.family), ALL);
});

test("an empty cache fetches everything in one call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  /** @type {string[][]} */
  const requested = [];
  const result = await collectWithCadence({
    families: ALL,
    cachePath: join(dir, "usage.json"),
    statePath: join(dir, "refresh.json"),
    now: NOW,
    loader: async (families) => {
      requested.push(families);
      return report(families);
    },
  });

  assert.deepEqual(requested, [ALL]);
  assert.deepEqual(result.fetched, ALL);
  assert.deepEqual(result.reused, []);
});

test("a degraded reused family is kept as it was, so a throttle keeps its values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const cachePath = join(dir, "usage.json");
  const statePath = join(dir, "refresh.json");

  const cached = report(ALL);
  cached.providers[0].windows[0].usedPercent = 77;
  cached.providers[0].error = "backing off after a throttle: next attempt in 120s";
  cached.providers[0].ok = false;
  writeCache(cached, { path: cachePath, now: NOW });
  // Every clock is current, so nothing is fetched and every provider is the cached copy.
  writeRefreshState({ fetchedAtMs: Object.fromEntries(ALL.map((family) => [family, NOW])) }, { statePath });

  const result = await collectWithCadence({
    families: ALL,
    cachePath,
    statePath,
    now: NOW,
    ttls: resolveFamilyTtls({}),
    loader: async (families) => report(families),
  });

  assert.deepEqual(result.fetched, []);
  const claude = result.report.providers.find((p) => p.family === "claude");
  assert.equal(claude.windows[0].usedPercent, 77, "the last real reading survives being carried");
  assert.equal(claude.ok, false);
  assert.match(claude.error, /backing off/);
  assert.equal(result.report.providers.length, 4, "a degraded provider still occupies its slot");
});

test("the names the callers rely on are always present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-refresh-"));
  const result = await collectWithCadence({
    families: ALL,
    cachePath: join(dir, "usage.json"),
    statePath: join(dir, "refresh.json"),
    now: NOW,
    loader: async (families) => report(families),
  });

  assert.deepEqual(Object.keys(result).sort(), ["ageMs", "fetched", "report", "reused"]);
  for (const family of ALL) {
    assert.equal(typeof result.ageMs[family], "number", `ageMs.${family}`);
  }
  assert.deepEqual(FAMILIES, ["claude", "codex", "antigravity", "opencode-go", "github-actions"]);
});
