/**
 * Moshi publisher tests: payload shape, redaction and transport behaviour.
 * Every request is served by a fixture; nothing reaches the network.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildUsagePayload, pushUsage, readHostCredentials, secondPrecision } from "../src/moshi/client.js";
import { buildArtifact } from "../src/moshi/artifact.js";
import { readUsageCollection } from "../src/moshi/settings.js";
import { jsonResponse, routedFetch } from "./helpers.mjs";

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
    byFamily: {},
  };
}

test("timestamps are reduced to the second precision this wire uses", () => {
  assert.equal(secondPrecision("2026-09-12T16:50:46.123Z"), "2026-09-12T16:50:46Z");
  assert.equal(secondPrecision(null), null);
  assert.equal(secondPrecision("garbage"), null);
});

test("the usage payload matches the observed Moshi schema", () => {
  const payload = buildUsagePayload(report([provider()]), { hostName: "TESTHOST" });

  assert.equal(payload.snapshots.length, 1);
  const snapshot = payload.snapshots[0];
  assert.equal(snapshot.accountId, "pi:codex");
  assert.equal(snapshot.accountLabel, "Codex (Pi)");
  assert.equal(snapshot.agent, "codex");
  assert.equal(snapshot.hostName, "TESTHOST");
  assert.equal(snapshot.capturedAt, "2026-09-12T16:50:46Z");
  assert.deepEqual(snapshot.windows[0], { label: "5h", usedPercentage: 19.46, resetsAt: "2026-09-12T13:10:17Z" });
  assert.deepEqual(snapshot.windows[1], { label: "weekly", usedPercentage: 3 });
});

test("account ids are stable per family and never derived from a secret", () => {
  const first = buildUsagePayload(report([provider()]));
  const second = buildUsagePayload(report([provider({ account: "someone-else@example.com" })]));
  assert.equal(first.snapshots[0].accountId, second.snapshots[0].accountId);

  const duplicates = buildUsagePayload(report([provider(), provider()]));
  assert.deepEqual(duplicates.snapshots.map((snapshot) => snapshot.accountId), ["pi:codex", "pi:codex:2"]);
});

test("agents map onto the union the server accepts, with Pi carried by the label", () => {
  const payload = buildUsagePayload(report([
    provider(),
    provider({ family: "claude", label: "Claude (Pi)" }),
    provider({ family: "antigravity", label: "Antigravity (Pi)" }),
    provider({ family: "opencode-go", label: "OpenCode Go (Pi)" }),
  ]));
  assert.deepEqual(payload.snapshots.map((snapshot) => snapshot.agent), ["codex", "claude-code", "antigravity", "opencode"]);
  assert.deepEqual(payload.snapshots.map((snapshot) => snapshot.accountLabel), [
    "Codex (Pi)",
    "Claude (Pi)",
    "Antigravity (Pi)",
    "OpenCode Go (Pi)",
  ]);
});

test("the rejected \"pi\" agent id is still available explicitly, for diagnostics", () => {
  const payload = buildUsagePayload(report([provider()]), { agentMode: "pi" });
  assert.equal(payload.snapshots[0].agent, "pi");
});

test("degraded providers and window-less providers are not published", () => {
  const payload = buildUsagePayload(
    report([
      provider({ family: "antigravity", ok: false, error: "expired" }),
      provider({ family: "opencode-go", windows: [] }),
    ]),
  );
  assert.deepEqual(payload.snapshots, []);
});

test("the payload never contains credential material", () => {
  const serialized = JSON.stringify(buildUsagePayload(report([provider()])));
  for (const secret of ["sk-ant", "ya29", "eyJ", "user@example.com", "rt.1"]) {
    assert.equal(serialized.includes(secret), false, `payload leaked ${secret}`);
  }
});

test("pushUsage posts to the paired host channel with the host secret", async () => {
  const { fetchFn, calls } = routedFetch([["api.getmoshi.app", () => jsonResponse({ ok: true })]]);
  const payload = buildUsagePayload(report([provider()]));

  const result = await pushUsage(payload, { hostId: "host_test", hostSecret: "secret_test", fetchFn });
  assert.equal(result.ok, true);
  assert.equal(result.pushed, 1);
  assert.equal(calls[0].url, "https://api.getmoshi.app/api/v1/hosts/host_test/usage");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret_test");
  assert.equal(JSON.parse(calls[0].init.body).snapshots.length, 1);
});

test("pushUsage reports a rejected host secret without leaking it", async () => {
  const { fetchFn } = routedFetch([["api.getmoshi.app", () => jsonResponse({}, { status: 401 })]]);
  const result = await pushUsage(buildUsagePayload(report([provider()])), {
    hostId: "host_test",
    hostSecret: "secret_supersecret",
    fetchFn,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /rejected the host secret/);
  assert.equal((result.error ?? "").includes("supersecret"), false);
});

test("pushUsage does nothing when there is nothing to publish", async () => {
  const result = await pushUsage({ snapshots: [] }, {});
  assert.equal(result.ok, true);
  assert.equal(result.pushed, 0);
});

test("host credentials are read from moshi-hook's own store, and its absence is explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-moshi-"));
  const missing = readHostCredentials({ stateDir: dir });
  assert.equal(missing.ok, false);
  assert.match(/** @type {{ error: string }} */ (missing).error, /not paired/);

  const secrets = join(dir, "secrets.json");
  writeFileSync(secrets, JSON.stringify({ "host-id": "host_1", "host-secret": "secret_1", "host-display-name": "BOX" }));
  const found = readHostCredentials({ stateDir: dir });
  assert.equal(found.ok, true);
  assert.deepEqual(Object.keys(found), ["ok", "hostId", "hostSecret", "hostName"]);
});

test("the local artifact redacts identities and carries no tokens", () => {
  const artifact = buildArtifact(report([provider()]));
  const serialized = JSON.stringify(artifact);
  assert.equal(serialized.includes("user@example.com"), false);
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.snapshots[0].account, "us***@example.com");
  assert.equal(artifact.snapshots[0].authoritative, false);
});

test("moshi-hook's usage-collection setting is respected in every documented form", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-moshi-cfg-"));
  const path = join(dir, "config.toml");
  for (const [value, enabled] of [["true", true], ["on", true], ["off", false], ["false", false]]) {
    writeFileSync(path, `[gateway]\nusage_collection = ${value}\n`);
    assert.equal(readUsageCollection({ configPath: path }).enabled, enabled, `value ${value}`);
  }
  assert.equal(readUsageCollection({ configPath: join(dir, "missing.toml") }).enabled, true);
});

test("a transient upstream failure keeps the previous snapshot on the card", async () => {
  const { mergeSticky, isTransientError } = await import("../src/moshi/sticky.js");

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

test("mergeSticky is a no-op without a previous report", async () => {
  const { mergeSticky } = await import("../src/moshi/sticky.js");
  const fresh = report([provider()]);
  assert.equal(mergeSticky(null, fresh).report, fresh);
});

test("the last published report survives a restart so a 429 cannot drop a card", async () => {
  const { loadLastPublished, saveLastPublished } = await import("../src/moshi/sticky.js");
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-last-"));
  const path = join(dir, "last-published.json");

  assert.equal(loadLastPublished({ path }), null);
  assert.equal(saveLastPublished(report([provider()]), { path }).ok, true);
  const restored = loadLastPublished({ path });
  assert.equal(restored.providers.length, 1);
  assert.equal(restored.providers[0].family, "codex");
  assert.equal(restored.providers[0].windows.length, 2);
});

test("windows are translated into Moshi's own vocabulary", async () => {
  const { moshiWindowLabel } = await import("../src/moshi/client.js");
  const make = (id, label) => ({ id, label, usedPercent: 1, remainingPercent: 99, resetsAt: null, resetsInSec: null, windowSeconds: null, note: null });

  assert.equal(moshiWindowLabel(make("5h", "5h window")), "5h");
  assert.equal(moshiWindowLabel(make("weekly", "Weekly window")), "weekly");
  assert.equal(moshiWindowLabel(make("monthly", "Monthly window")), "monthly");
  // Antigravity's per-group windows keep the group as a prefix.
  assert.equal(moshiWindowLabel(make("gemini-5h", "Gemini · 5h")), "Gemini · 5h");
  assert.equal(moshiWindowLabel(make("claude-gpt-weekly", "Claude/GPT · weekly")), "Claude/GPT · weekly");
  // Anything unrecognized keeps its human label.
  assert.equal(moshiWindowLabel(make("credits", "Credits")), "Credits");
});

test("a throttled family keeps showing its last known real values", async () => {
  const { mergeLastGood } = await import("../src/moshi/sticky.js");
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

test("an expired credential (expiresInMin <= 0) is never masked by mergeLastGood or mergeSticky", async () => {
  const { mergeLastGood, mergeSticky } = await import("../src/moshi/sticky.js");
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

test("a backoff message still restores the last known values", async () => {
  const { mergeLastGood } = await import("../src/moshi/sticky.js");
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

test("carrying a snapshot never reorders the providers", async () => {
  const { mergeSticky, mergeLastGood } = await import("../src/moshi/sticky.js");
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
