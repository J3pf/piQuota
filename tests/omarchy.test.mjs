import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runOmarchyCommand, skippedFamilies } from "../src/cli/commands/omarchy.js";
import { publishRecords, resolveOmarchyDir } from "../src/omarchy/publish.js";
import { buildRecord, buildRecords } from "../src/omarchy/record.js";

const NOW = Date.parse("2026-10-04T05:00:00.000Z");

/** @returns {any} */
function provider(overrides = {}) {
  return {
    family: "claude",
    label: "Claude (Pi)",
    account: "someone@example.com",
    plan: "pro",
    windows: [
      { id: "5h", label: "5h window", usedPercent: 25, remainingPercent: 75, resetsAt: "2026-10-04T10:00:00.000Z" },
      { id: "weekly", label: "Weekly window", usedPercent: 40.5, remainingPercent: 59.5, resetsAt: null },
    ],
    error: null,
    ok: true,
    source: "/home/u/.claude/.credentials.json",
    updatedAt: "2026-10-04T05:00:00.000Z",
    ...overrides,
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-quota-omarchy-"));
}

test("a healthy provider maps to a ready record with fractional used percent", () => {
  const built = buildRecord(provider(), { now: NOW });
  assert.equal(built.id, "pi-claude");
  assert.deepEqual(built.record, {
    schemaVersion: 1,
    id: "pi-claude",
    name: "Claude",
    ready: true,
    tierLabel: "pro",
    limits: [
      { label: "5h window", title: "Session", percent: 0.25, resetsAt: "2026-10-04T10:00:00.000Z" },
      { label: "Weekly window", title: "Weekly", percent: 0.405, resetsAt: "" },
    ],
    usageStatusText: "",
    authHelpText: "",
    hasLocalStats: false,
    hasPromptStats: false,
    updatedAt: "2026-10-04T05:00:00.000Z",
  });
});

test("windows without a percentage are dropped instead of reading as 0% used", () => {
  const built = buildRecord(
    provider({ windows: [{ id: "5h", label: "5h window", usedPercent: null }, { id: "x", label: "Gemini · 5h", usedPercent: 10 }] }),
    { now: NOW },
  );
  assert.equal(built.record.limits.length, 1);
  assert.equal(built.record.limits[0].title, "Gemini · 5h");
});

test("a provider that is not configured produces no record", () => {
  const built = buildRecord(
    provider({ ok: false, windows: [], error: "no opencode-go credential in the Pi store" }),
    { now: NOW },
  );
  assert.equal(built, null);
});

test("an expired or rejected sign-in surfaces a status and a help text", () => {
  const expired = buildRecord(provider({ ok: false, windows: [], error: "Claude Code token expired or rejected; run `claude` once" }), { now: NOW });
  assert.equal(expired.record.ready, false);
  assert.equal(expired.record.usageStatusText, "Sign-in expired");
  assert.match(expired.record.authHelpText, /claude/);

  const rejected = buildRecord(provider({ family: "codex", ok: false, windows: [], error: "HTTP 401 unauthorized" }), { now: NOW });
  assert.equal(rejected.record.usageStatusText, "Credential rejected");
  assert.match(rejected.record.authHelpText, /openai-codex/);
});

test("an error record keeps a placeholder limit the panel never draws", () => {
  const { record } = buildRecord(provider({ ok: false, windows: [], error: "HTTP 503" }), { now: NOW });
  assert.equal(record.limits.length, 1);
  assert.ok(record.limits[0].percent < 0, "the panel filters percent < 0, so nothing is drawn");
});

test("transient and throttled failures degrade into readable states", () => {
  const transient = buildRecord(provider({ ok: false, windows: [], error: "fetch failed: ECONNRESET" }), { now: NOW });
  assert.equal(transient.record.usageStatusText, "Temporarily unavailable");
  const throttled = buildRecord(provider({ ok: false, windows: [], error: "backing off after a throttle: next attempt in 30s" }), { now: NOW });
  assert.equal(throttled.record.usageStatusText, "Rate limited");
});

test("an unknown error is shown redacted and truncated", () => {
  const { record } = buildRecord(provider({ ok: false, windows: [], error: `weird failure for a@b.io ${"x".repeat(500)}` }), { now: NOW });
  assert.equal(record.usageStatusText, "Quota unavailable");
  assert.ok(record.authHelpText.length <= 200);
  assert.ok(!record.authHelpText.includes("a@b.io"));
});

test("buildRecords keeps one record per family and never throws on garbage", () => {
  const report = {
    providers: [provider(), provider({ label: "second claude" }), null, { family: 42 }, provider({ family: "codex", label: "Codex (Pi)" })],
  };
  const records = buildRecords(/** @type {any} */ (report), { now: NOW });
  assert.deepEqual(records.map((r) => r.id), ["pi-claude", "pi-codex"]);
  assert.deepEqual(buildRecords(/** @type {any} */ (null)), []);
});

test("records never carry tokens, accounts or e-mail addresses", () => {
  const secret = "sk-abcdefSECRETSECRET";
  const records = buildRecords(
    /** @type {any} */ ({
      providers: [
        provider({ plan: "pro", account: "someone@example.com", accessToken: secret }),
        provider({ family: "codex", label: "Codex (Pi)", ok: false, windows: [], error: `Bearer ${secret} rejected for someone@example.com` }),
      ],
    }),
    { now: NOW },
  );
  const text = JSON.stringify(records);
  assert.ok(!text.includes("someone@example.com"));
  assert.ok(!text.includes("SECRETSECRET"));
  assert.ok(!text.includes("account"));
  assert.ok(!text.includes("/home/u"), "credential source paths stay out of the record");
});

test("publishRecords writes valid JSON atomically and leaves no temp files", () => {
  const dir = join(tempDir(), "usage");
  try {
    const records = buildRecords(/** @type {any} */ ({ providers: [provider()] }), { now: NOW });
    const result = publishRecords(records, { dir });
    assert.deepEqual(result.written, [join(dir, "pi-claude.json")]);
    assert.equal(JSON.parse(readFileSync(join(dir, "pi-claude.json"), "utf-8")).id, "pi-claude");
    assert.deepEqual(readdirSync(dir), ["pi-claude.json"]);

    // A second run replaces the file in place.
    publishRecords(buildRecords(/** @type {any} */ ({ providers: [provider({ plan: "max" })] }), { now: NOW }), { dir });
    assert.equal(JSON.parse(readFileSync(join(dir, "pi-claude.json"), "utf-8")).tierLabel, "max");
    assert.deepEqual(readdirSync(dir), ["pi-claude.json"]);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

test("stale pi-*.json records are removed and foreign records are untouched", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "pi-antigravity.json"), "{}");
    writeFileSync(join(dir, "claude.json"), '{"id":"claude"}');
    writeFileSync(join(dir, "notes.txt"), "keep");
    const records = buildRecords(/** @type {any} */ ({ providers: [provider()] }), { now: NOW });
    const result = publishRecords(records, { dir });
    assert.deepEqual(result.removed, [join(dir, "pi-antigravity.json")]);
    assert.ok(!existsSync(join(dir, "pi-antigravity.json")));
    assert.deepEqual(readdirSync(dir).sort(), ["claude.json", "notes.txt", "pi-claude.json"]);
    assert.equal(readFileSync(join(dir, "claude.json"), "utf-8"), '{"id":"claude"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the output directory honours PI_QUOTA_OMARCHY_DIR, then XDG_STATE_HOME, then ~/.local/state", () => {
  assert.equal(resolveOmarchyDir({ env: { PI_QUOTA_OMARCHY_DIR: "/x/y", XDG_STATE_HOME: "/s" } }), "/x/y");
  assert.equal(resolveOmarchyDir({ env: { XDG_STATE_HOME: "/s" } }), "/s/omarchy/agents/usage");
  assert.equal(resolveOmarchyDir({ env: {}, home: "/h" }), "/h/.local/state/omarchy/agents/usage");
});

test("the command publishes from the loaded report and survives a failing load", async () => {
  const dir = tempDir();
  try {
    const code = await runOmarchyCommand({
      load: async () => /** @type {any} */ ({ providers: [provider()] }),
      dir,
      quiet: true,
    });
    assert.equal(code, 0);
    assert.ok(existsSync(join(dir, "pi-claude.json")));

    const failing = await runOmarchyCommand({
      load: async () => {
        throw new Error("boom for a@b.io");
      },
      dir,
      quiet: true,
    });
    assert.equal(failing, 1);
    assert.ok(existsSync(join(dir, "pi-claude.json")), "a failed collection leaves the previous records in place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PI_QUOTA_OMARCHY_SKIP drops a family and removes its stale record", async () => {
  const dir = tempDir();
  const env = { PI_QUOTA_OMARCHY_SKIP: " Claude " };
  assert.deepEqual([...skippedFamilies(env)], ["claude"]);
  writeFileSync(join(dir, "pi-claude.json"), "{}");
  const report = { providers: [provider({ family: "claude" }), provider({ family: "codex" })] };
  const code = await runOmarchyCommand({ load: async () => report, dir, env, quiet: true });
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, "pi-claude.json")), false);
  assert.equal(existsSync(join(dir, "pi-codex.json")), true);
});

test("omarchy automatically skips claude when native claude.json exists in target dir", async () => {
  const dir = tempDir();
  writeFileSync(join(dir, "claude.json"), "{}");
  writeFileSync(join(dir, "pi-claude.json"), "{}");
  assert.deepEqual([...skippedFamilies({}, dir)], ["claude"]);

  const report = { providers: [provider({ family: "claude" }), provider({ family: "codex" })] };
  const code = await runOmarchyCommand({ load: async () => report, dir, env: {}, quiet: true });
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, "pi-claude.json")), false);
  assert.equal(existsSync(join(dir, "pi-codex.json")), true);
});
