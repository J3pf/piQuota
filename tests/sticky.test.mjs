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
  mergeLastGood,
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

test("isTransientError distinguishes transient network/throttle failures from permanent ones", () => {
  assert.equal(isTransientError("Claude usage request failed: rate limited (HTTP 429); retry in 30s"), true);
  assert.equal(isTransientError("Claude usage request failed: rate limited (HTTP 429); retry in 401s"), true);
  assert.equal(isTransientError("Claude usage request failed: HTTP 503"), true);
  assert.equal(isTransientError("request timed out"), true);
  assert.equal(isTransientError("timed out after 15401ms"), true);
  // The backoff layer's own message must be treated as transient, otherwise the
  // last-good restore refuses to act precisely while a provider is throttled.
  assert.equal(isTransientError("backing off after a throttle: next attempt in 231s"), true);
  assert.equal(isTransientError("backing off after a throttle: next attempt in 401s"), true);
  assert.equal(isTransientError("throttled upstream; pausing that family for 300s"), true);
  assert.equal(isTransientError("Claude usage request failed: HTTP 400: bad request"), false);
  assert.equal(isTransientError("Claude usage request failed: response was not valid JSON"), false);
  assert.equal(isTransientError("Claude token rejected; run /login"), false);
  assert.equal(isTransientError("no claude credential in the Pi store"), false);
  assert.equal(isTransientError(null), false);
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

test("an expired credential (expiresInMin <= 0) is never masked by mergeLastGood", () => {
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

  const viaLastGood = mergeLastGood(next, { path: join(dir, "last-good.json"), now: NOW + 60_000 });
  assert.deepEqual(viaLastGood.report.providers.map((p) => p.family), ["claude", "codex", "opencode-go"]);
  assert.deepEqual(viaLastGood.restored, ["claude"]);
});
