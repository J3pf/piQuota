/**
 * Sticky snapshots and last-good cache tests: transient failure resilience.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  isTransientError,
  loadLastPublished,
  mergeLastGood,
  mergeSticky,
  saveLastPublished,
} from "../src/sticky.js";

const NOW = "2026-09-12T16:50:46.123Z";

/** @param {Partial<import("../src/model.js").QuotaResult>} overrides */
function provider(overrides = {}) {
  return {
    family: "codex",
    label: "Codex (Pi)",
    account: "user@example.com",
    plan: "plus",
    windows: [
      {
        id: "5h",
        label: "5h window",
        usedPercent: 19.456,
        remainingPercent: 80.544,
        resetsAt: "2026-09-12T13:10:17.000Z",
        resetsInSec: 3600,
        windowSeconds: 18000,
        note: null,
      },
      {
        id: "weekly",
        label: "Weekly window",
        usedPercent: 3,
        remainingPercent: 97,
        resetsAt: null,
        resetsInSec: null,
        windowSeconds: 604800,
        note: null,
      },
    ],
    error: null,
    ok: true,
    updatedAt: NOW,
    source: "/tmp/auth.json",
    expiresInMin: 600,
    ...overrides,
  };
}

/** @param {import("../src/model.js").QuotaResult[]} providers */
function report(providers) {
  return {
    engine: "pi-quota",
    schemaVersion: 1,
    readOnly: true,
    generatedAt: NOW,
    sources: ["/tmp/auth.json"],
    warnings: [],
    providers,
    byFamily: Object.fromEntries(providers.map((p) => [p.family, [p]])),
  };
}

test("a transient upstream failure keeps the previous snapshot on the card", () => {
  assert.equal(isTransientError("Claude usage request failed: rate limited (HTTP 429); retry in 30s"), true);
  assert.equal(isTransientError("Claude usage request failed: HTTP 503"), true);
  assert.equal(isTransientError("request timed out"), true);
  // The backoff layer's own message must be treated as transient, otherwise the
  // last-good restore refuses to act precisely while a provider is throttled.
  assert.equal(isTransientError("backing off after a throttle: next attempt in 231s"), true);
  assert.equal(isTransientError("throttled upstream; pausing that family for 300s"), true);
  assert.equal(isTransientError("Claude token rejected; run /login"), false);
  assert.equal(isTransientError("no claude credential in the Pi store"), false);
  assert.equal(isTransientError(null), false);

  const healthy = provider({ family: "claude", label: "Claude (Pi)" });
  const previous = { ...report([healthy]), byFamily: { claude: [healthy] } };
  const degraded = provider({ family: "claude", label: "Claude (Pi)", ok: false, windows: [], error: "rate limited (HTTP 429); retry in 30s" });
  const throttled = { ...report([degraded]), byFamily: { claude: [degraded] } };

  const merged = mergeSticky(previous, throttled);
  assert.deepEqual(merged.reused, ["claude"]);
  assert.equal(merged.report.providers[0].ok, true);
  assert.equal(merged.report.providers[0].windows.length, 2);
  assert.match(merged.report.warnings.join(" "), /reused the previous snapshot for: claude/);

  // A permanent failure is NOT masked.
  const expiredResult = provider({ family: "claude", label: "Claude (Pi)", ok: false, windows: [], error: "Claude token rejected; run /login" });
  const expired = { ...report([expiredResult]), byFamily: { claude: [expiredResult] } };
  const notMasked = mergeSticky(previous, expired);
  assert.deepEqual(notMasked.reused, []);
  assert.equal(notMasked.report.providers[0].ok, false);
});

test("mergeSticky is a no-op without a previous report", () => {
  const fresh = report([provider()]);
  assert.equal(mergeSticky(null, fresh).report, fresh);
});

test("the last published report survives a restart so a 429 cannot drop a card", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-last-"));
  const path = join(dir, "last-published.json");

  assert.equal(loadLastPublished({ path }), null);
  assert.equal(saveLastPublished(report([provider()]), { path }).ok, true);
  const restored = loadLastPublished({ path });
  assert.equal(restored.providers.length, 1);
  assert.equal(restored.providers[0].family, "codex");
  assert.equal(restored.providers[0].windows.length, 2);
});

test("a throttled family keeps showing its last known real values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-lastgood-"));
  const path = join(dir, "last-good.json");
  const NOW = 1_800_000_000_000;

  const healthy = provider({ family: "claude", label: "Claude (Pi)" });
  const first = mergeLastGood({ ...report([healthy]), byFamily: { claude: [healthy] } }, { path, now: NOW });
  assert.deepEqual(first.saved, ["claude"]);
  assert.deepEqual(first.restored, []);

  const throttled = provider({ family: "claude", label: "Claude (Pi)", ok: false, windows: [], error: "rate limited (HTTP 429)" });
  const second = mergeLastGood(
    { ...report([throttled]), byFamily: { claude: [throttled] } },
    { path, now: NOW + 12 * 60_000 },
  );
  assert.deepEqual(second.restored, ["claude"]);
  assert.equal(second.report.providers[0].ok, true, "the card must not go blank");
  assert.equal(second.report.providers[0].windows.length, 2);
  assert.match(second.report.providers[0].note ?? "", /last known values, 12 min old/);
  assert.match(second.report.warnings.join(" "), /showing the last known values \(12 min old\)/);

  // A permanent failure is never replaced by stale data.
  const expired = provider({ family: "claude", label: "Claude (Pi)", ok: false, windows: [], error: "Claude token rejected; run /login" });
  const third = mergeLastGood({ ...report([expired]), byFamily: { claude: [expired] } }, { path, now: NOW + 13 * 60_000 });
  assert.deepEqual(third.restored, []);
  assert.equal(third.report.providers[0].ok, false);

  // A snapshot older than the max sticky age (default 30m) is discarded.
  const fourth = mergeLastGood(
    { ...report([throttled]), byFamily: { claude: [throttled] } },
    { path, now: NOW + 35 * 60_000, maxAgeMs: 30 * 60_000 },
  );
  assert.deepEqual(fourth.restored, [], "must not restore data older than max sticky age");
  assert.equal(fourth.report.providers[0].ok, false);
  assert.match(fourth.report.warnings.join(" "), /discarded last known values because they are stale/);
});

test("an expired credential (expiresInMin <= 0) is never masked by mergeLastGood or mergeSticky", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-expired-"));
  const path = join(dir, "last-good.json");
  const NOW = 1_800_000_000_000;

  const healthy = provider({ family: "claude", label: "Claude (Pi)" });
  const previous = { ...report([healthy]), byFamily: { claude: [healthy] } };
  mergeLastGood(previous, { path, now: NOW });

  // A result where the token expired, but the error message is transient (e.g. backing off)
  const expiredBackingOff = provider({
    family: "claude",
    label: "Claude (Pi)",
    ok: false,
    windows: [],
    expiresInMin: -10,
    error: "backing off after a throttle: next attempt in 120s",
  });
  const current = { ...report([expiredBackingOff]), byFamily: { claude: [expiredBackingOff] } };

  // Neither mergeSticky nor mergeLastGood should restore old data when the token is expired
  const stickyResult = mergeSticky(previous, current, { now: NOW + 60_000 });
  assert.deepEqual(stickyResult.reused, []);
  assert.equal(stickyResult.report.providers[0].ok, false);

  const lastGoodResult = mergeLastGood(current, { path, now: NOW + 60_000 });
  assert.deepEqual(lastGoodResult.restored, []);
  assert.equal(lastGoodResult.report.providers[0].ok, false);
});

test("a backoff message still restores the last known values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-backoff-carry-"));
  const path = join(dir, "last-good.json");
  const NOW = 1_800_000_000_000;

  const healthy = provider({ family: "claude", label: "Claude (Pi)" });
  mergeLastGood({ ...report([healthy]), byFamily: { claude: [healthy] } }, { path, now: NOW });

  const backingOff = provider({
    family: "claude", label: "Claude (Pi)", ok: false, windows: [],
    error: "backing off after a throttle: next attempt in 231s",
  });
  const result = mergeLastGood({ ...report([backingOff]), byFamily: { claude: [backingOff] } }, { path, now: NOW + 3000 });
  assert.deepEqual(result.restored, ["claude"]);
  assert.equal(result.report.providers[0].ok, true);
  assert.equal(result.report.providers[0].windows.length, 2);
});

test("carrying a snapshot never reorders the providers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-order-"));
  const NOW = 1_800_000_000_000;

  const claude = provider({ family: "claude", label: "Claude (Pi)" });
  const codex = provider({ family: "codex", label: "Codex (Pi)" });
  const opencode = provider({ family: "opencode-go", label: "OpenCode Go (Pi)" });
  // The report's canonical order is claude, codex, opencode-go.
  const ordered = { ...report([claude, codex, opencode]), byFamily: { claude: [claude], codex: [codex], "opencode-go": [opencode] } };

  mergeLastGood(ordered, { path: join(dir, "last-good.json"), now: NOW });

  // A throttled Claude, and the byFamily map deliberately inserted in a different order.
  const throttled = provider({ family: "claude", label: "Claude (Pi)", ok: false, windows: [], error: "rate limited (HTTP 429)" });
  const next = {
    ...report([throttled, codex, opencode]),
    byFamily: { "opencode-go": [opencode], claude: [throttled], codex: [codex] },
  };

  const viaSticky = mergeSticky(ordered, next);
  assert.deepEqual(viaSticky.report.providers.map((p) => p.family), ["claude", "codex", "opencode-go"]);

  const viaLastGood = mergeLastGood(next, { path: join(dir, "last-good.json"), now: NOW + 60_000 });
  assert.deepEqual(viaLastGood.report.providers.map((p) => p.family), ["claude", "codex", "opencode-go"]);
  assert.deepEqual(viaLastGood.restored, ["claude"]);
});
