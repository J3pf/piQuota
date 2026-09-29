/**
 * Renderer tests: thresholds, widths and the guarantees that keep the panel
 * readable next to long degradation messages.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bar, plainPalette, ringGlyph, thresholdKey } from "../src/render/theme.js";
import {
  headlineWindow,
  renderBoxWidget,
  renderProviderLines,
  renderCompact,
  renderPanel,
  renderStatusLine,
  visibleLength,
} from "../src/render/panel.js";
import { buildWindow, clampPercent, humanDuration, humanReset, parseReset } from "../src/model.js";

/** @param {Partial<import("../src/model.js").QuotaWindow>} overrides */
function windowFixture(overrides = {}) {
  return {
    id: "5h",
    label: "5h window",
    usedPercent: 20,
    remainingPercent: 80,
    resetsAt: null,
    resetsInSec: 7200,
    windowSeconds: null,
    note: null,
    ...overrides,
  };
}

/** @param {Partial<import("../src/model.js").QuotaResult>} overrides */
function providerFixture(overrides = {}) {
  return {
    family: "codex",
    label: "Codex (Pi)",
    account: "fixture@example.com",
    plan: "plus",
    windows: [windowFixture()],
    error: null,
    ok: true,
    updatedAt: "2030-01-01T00:00:00.000Z",
    source: "/tmp/auth.json",
    expiresInMin: 600,
    ...overrides,
  };
}

test("thresholds match the agreed colour bands", () => {
  assert.equal(thresholdKey(100), "ok");
  assert.equal(thresholdKey(51), "ok");
  assert.equal(thresholdKey(50), "warn");
  assert.equal(thresholdKey(20), "warn");
  assert.equal(thresholdKey(19.9), "danger");
  assert.equal(thresholdKey(0), "danger");
  assert.equal(thresholdKey(null), "unknown");
});

test("ring glyphs cover the full range including the unknown state", () => {
  assert.equal(ringGlyph(null), "◌");
  assert.equal(ringGlyph(100), "●");
  assert.equal(ringGlyph(50), "◑");
  assert.equal(ringGlyph(5), "○");
});

test("bars fill proportionally and tolerate missing values", () => {
  assert.equal(bar(100, 10), "█".repeat(10));
  assert.equal(bar(0, 10), "░".repeat(10));
  assert.equal(bar(50, 10), "█".repeat(5) + "░".repeat(5));
  assert.equal(bar(null, 4), "····");
});

test("the headline window is the tightest one", () => {
  const provider = providerFixture({
    windows: [windowFixture({ id: "weekly", remainingPercent: 90 }), windowFixture({ id: "5h", remainingPercent: 12 })],
  });
  assert.equal(headlineWindow(provider)?.id, "5h");
});

test("reset countdowns read as human durations", () => {
  assert.equal(humanDuration(11520), "3h 12m");
  assert.equal(humanDuration(0), "now");
  assert.equal(humanDuration(45), "45s");
  assert.equal(humanReset(11520), "reset in 3h 12m");
  assert.equal(humanReset(null), "reset unknown");
});

test("the panel keeps a uniform width even when a message is long", () => {
  const providers = [
    providerFixture(),
    providerFixture({
      family: "opencode-go",
      label: "OpenCode Go (Pi)",
      ok: false,
      windows: [],
      error: "Pi key is a valid OpenCode Zen key (70 models visible). The Go 5h/weekly/monthly windows are not exposed to Pi: missing OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE in ~/.shuvquota.env",
    }),
  ];
  const lines = renderPanel(providers, plainPalette(), {
    generatedAt: "2030-01-01T00:00:00.000Z",
    warnings: ["one warning long enough to require wrapping inside the box as well"],
    maxWidth: 100,
  });
  const widths = new Set(lines.map((line) => visibleLength(line)));
  assert.equal(widths.size, 1, `expected one width, saw ${[...widths].join(",")}`);
  assert.ok(Math.max(...widths) <= 100);
  assert.equal(lines.some((line) => line.includes("OPENCODE_GO_WORKSPACE_ID")), true);
  assert.equal(lines.some((line) => line.includes("warn:")), true);
});

test("compact and status renderers mention every provider", () => {
  const providers = [
    providerFixture(),
    providerFixture({
      family: "claude",
      label: "Claude (Pi)",
      windows: [windowFixture({ remainingPercent: 15, resetsInSec: 11_520 })],
    }),
  ];
  const compact = renderCompact(providers, plainPalette()).join("\n");
  assert.match(compact, /Codex \(Pi\)/);
  assert.match(compact, /Claude \(Pi\)/);
  assert.match(compact, /reset in 3h 12m/);

  const status = renderStatusLine(providers, plainPalette());
  assert.match(status, /X/);
  assert.match(status, /C/);
  assert.match(status, /15%/);
});

test("transient upstream failure paints ~ + caption, not !", () => {
  const status = renderStatusLine(
    [providerFixture({ ok: false, windows: [], error: "upstream request failed: HTTP 502" })],
    plainPalette(),
  );
  assert.match(status, /X ~ upstream temporarily unavailable/);
  assert.equal(status.includes("!"), false);
});

test("throttle paints … + rate-limited caption", () => {
  const status = renderStatusLine(
    [providerFixture({ ok: false, windows: [], error: "upstream request failed: HTTP 429" })],
    plainPalette(),
  );
  assert.match(status, /X … rate-limited upstream/);
});

test("expired token paints ! + token expired caption", () => {
  const status = renderStatusLine(
    [providerFixture({ ok: false, windows: [], error: "token expired" })],
    plainPalette(),
  );
  assert.match(status, /X ! token expired/);
});

test("auth failure paints ! + credential rejected caption", () => {
  const status = renderStatusLine(
    [providerFixture({ ok: false, windows: [], error: "upstream request failed: HTTP 401" })],
    plainPalette(),
  );
  assert.match(status, /X ! credential rejected/);
});

test("missing credential paints · + not configured caption when the provider is configured", () => {
  const status = renderStatusLine(
    [providerFixture({ ok: false, windows: [], error: "no codex credential in the Pi store" })],
    plainPalette(),
  );
  assert.match(status, /X · not configured/);
});

test("unknown failure paints ? + unavailable caption", () => {
  const status = renderStatusLine(
    [providerFixture({ ok: false, windows: [], error: "API shape may have changed" })],
    plainPalette(),
  );
  assert.match(status, /X \? unavailable/);
});

test("notConfigured providers are excluded from the status line entirely", () => {
  const status = renderStatusLine(
    [
      providerFixture({ family: "claude", label: "Claude (Pi)" }),
      providerFixture({ notConfigured: true, ok: false, windows: [], error: "no codex credential in the Pi store" }),
    ],
    plainPalette(),
  );
  assert.match(status, /C/);
  assert.equal(status.includes("X"), false);

  const empty = renderStatusLine(
    [providerFixture({ notConfigured: true, ok: false, windows: [], error: "no codex credential in the Pi store" })],
    plainPalette(),
  );
  assert.equal(empty, "quota: no configured providers");
});

test("a healthy provider with no remainingPercent shows ? + n/a", () => {
  const status = renderStatusLine(
    [providerFixture({ windows: [windowFixture({ remainingPercent: null })] })],
    plainPalette(),
  );
  assert.match(status, /X \? n\/a/);
});

test("the headline window is the shortest one, not the most consumed", () => {
  const provider = providerFixture({
    windows: [
      windowFixture({ id: "weekly", label: "Weekly window", remainingPercent: 31 }),
      windowFixture({ id: "monthly", label: "Monthly window", remainingPercent: 65 }),
      windowFixture({ id: "5h", label: "5h window", remainingPercent: 97 }),
    ],
  });
  // A weekly window at 31% left is the most consumed, but the 5h is what will
  // stop you first, so the status ring must report the 5h.
  assert.equal(headlineWindow(provider)?.id, "5h");
  assert.match(renderStatusLine([provider], plainPalette()), /97%/);
});

test("the CLI's stamped choice wins, so every surface agrees", () => {
  const provider = providerFixture({
    primaryWindowId: "weekly",
    windows: [
      windowFixture({ id: "5h", label: "5h window", remainingPercent: 97 }),
      windowFixture({ id: "weekly", label: "Weekly window", remainingPercent: 31 }),
    ],
  });
  assert.equal(headlineWindow(provider)?.id, "weekly");
});

test("with several windows of the same rank the tightest one wins", () => {
  const provider = providerFixture({
    windows: [
      windowFixture({ id: "gemini-5h", label: "Gemini · 5h", remainingPercent: 96.7 }),
      windowFixture({ id: "claude-gpt-5h", label: "Claude/GPT · 5h", remainingPercent: 100 }),
      windowFixture({ id: "gemini-weekly", label: "Gemini · weekly", remainingPercent: 3 }),
    ],
  });
  assert.equal(headlineWindow(provider)?.id, "gemini-5h");
});

test("an unrecognized window only wins when nothing better exists", () => {
  const provider = providerFixture({
    windows: [windowFixture({ id: "credits", label: "Credits", remainingPercent: null })],
  });
  assert.equal(headlineWindow(provider)?.id, "credits");
});

test("the panel names the Claude store that was actually read", () => {
  const plainPaint = (key, text) => text;
  const base = {
    family: "claude", label: "Claude (Pi)", account: "fixture@example.com", plan: "pro",
    windows: [], error: null, ok: true, updatedAt: "2030-01-01T00:00:00.000Z", source: "/tmp/x", expiresInMin: 60,
  };

  const fromCli = renderProviderLines({ ...base, sourceKind: "claude-code" }, plainPaint).join("\n");
  assert.match(fromCli, /Claude Code CLI/);

  const fromStore = renderProviderLines({ ...base, sourceKind: "pi" }, plainPaint).join("\n");
  assert.equal(fromStore.includes("Claude Code CLI"), false, "Pi's own entry is the unremarkable default");
});

test("the box widget borders and content align to the exact same visible width", () => {
  const plainPaint = (key, text) => text;
  const lines = renderBoxWidget([providerFixture()], plainPaint, 0);
  const lengths = lines.map(visibleLength);
  assert.equal(lengths.length > 2, true);
  for (let i = 1; i < lengths.length; i++) {
    assert.equal(lengths[i], lengths[0], `line ${i} width matches top border width`);
  }
});

test("model defensive parsing: booleans, arrays, reset seconds, and phantom quota guards", () => {
  assert.equal(clampPercent(true), null);
  assert.equal(clampPercent(false), null);
  assert.equal(clampPercent([]), null);
  assert.equal(clampPercent([50]), null);
  assert.equal(clampPercent("85"), 85);

  const now = 1_800_000_000_000;
  const resetFromString = parseReset("1800", now);
  assert.equal(resetFromString.resetsInSec, 1800);
  assert.equal(resetFromString.resetsAt, new Date(now + 1800 * 1000).toISOString());

  const resetFromNum = parseReset(3600, now);
  assert.equal(resetFromNum.resetsInSec, 3600);

  const windowWithInvalidRemaining = buildWindow({ id: "test", label: "Test", remainingPercent: "not-a-number", now });
  assert.equal(windowWithInvalidRemaining.usedPercent, null);
  assert.equal(windowWithInvalidRemaining.remainingPercent, null);

  assert.equal(humanDuration(45.8), "46s");
});
