/**
 * Extension contract tests.
 *
 * The extension is loaded through Node's TypeScript type-stripping, so these run
 * without the Pi TUI. They pin the parts that are easy to break silently:
 * the default surface, the used-percent semantics, the brand colours, and the
 * fact that nothing touches the LLM context.
 */

import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mergeLastGood } from "../src/moshi/sticky.js";

const EXTENSION = new URL("../extensions/quota-panel.ts", import.meta.url).href;
const RAIL_PATCH_MODULE = fileURLToPath(new URL("../src/gentle-pi/rail-patch.js", import.meta.url));
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "pi-quota-extension-cache-"));
// These tests must never edit the real gentle-pi package, so the default lookup is
// pointed at an empty directory. The rail tests opt back in with their own fixture.
process.env.PI_QUOTA_GENTLE_PI_DIR = mkdtempSync(join(tmpdir(), "pi-quota-extension-no-gentle-pi-"));

/** Strips SGR sequences so assertions can talk about visible text. */
const plain = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, "");

function renderWidget(widget, theme = { fg: (_key, text) => text, bold: (text) => text }, width = 100, tui = { terminal: {} }) {
  if (Array.isArray(widget)) return widget;
  return widget(tui, theme).render(width);
}

const SIDEBAR_STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
const STOCK_RAIL = 'const sections = ["footer", "agents", "todo"].map((key) => key);\n';

const PATCHED_RAIL = 'const sections = ["footer", "agents", "todo", "quota"].map((key) => key);\n';

/** A throwaway gentle-pi package so the rail tests never touch the real install. */
function makeGentlePiFixture(patched = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-gentle-pi-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "shell-sidebar-layout.ts"), patched ? PATCHED_RAIL : STOCK_RAIL, "utf-8");
  return dir;
}

/**
 * A throwaway CLI tree holding the rail patcher where the extension looks for it,
 * so `PI_QUOTA_BIN` can point the extension at it instead of the real install.
 */
function makeCliTree() {
  const root = mkdtempSync(join(tmpdir(), "pi-quota-cli-tree-"));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "gentle-pi"), { recursive: true });
  writeFileSync(join(root, "bin", "piquota.js"), "#!/usr/bin/env node\n", "utf-8");
  copyFileSync(RAIL_PATCH_MODULE, join(root, "src", "gentle-pi", "rail-patch.js"));
  return join(root, "bin", "piquota.js");
}

/**
 * Run a body with `PI_QUOTA_BIN` and `PI_QUOTA_GENTLE_PI_DIR` pointed at fixtures,
 * restoring both afterwards so the other tests keep their hermetic defaults.
 */
async function withRailFixtures(body, { patched = false } = {}) {
  const gentlePiDir = makeGentlePiFixture(patched);
  const previousBin = process.env.PI_QUOTA_BIN;
  const previousDir = process.env.PI_QUOTA_GENTLE_PI_DIR;
  process.env.PI_QUOTA_BIN = makeCliTree();
  process.env.PI_QUOTA_GENTLE_PI_DIR = gentlePiDir;
  try {
    await body({ gentlePiDir, layoutPath: join(gentlePiDir, "lib", "shell-sidebar-layout.ts") });
  } finally {
    if (previousBin === undefined) delete process.env.PI_QUOTA_BIN;
    else process.env.PI_QUOTA_BIN = previousBin;
    if (previousDir === undefined) delete process.env.PI_QUOTA_GENTLE_PI_DIR;
    else process.env.PI_QUOTA_GENTLE_PI_DIR = previousDir;
  }
}

const REPORT = {
  providers: [
    {
      family: "claude",
      label: "Claude (Pi)",
      primaryWindowId: "5h",
      account: "fixture@example.com",
      plan: null,
      windows: [
        { id: "5h", label: "5h window", usedPercent: 4, remainingPercent: 96, resetsAt: null, resetsInSec: 3600, note: null },
        { id: "weekly", label: "Weekly window", usedPercent: 11, remainingPercent: 89, resetsAt: null, resetsInSec: 500000, note: null },
      ],
      error: null,
      ok: true,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: 600,
    },
    {
      family: "codex",
      label: "Codex (Pi)",
      primaryWindowId: "5h",
      account: "fixture@example.com",
      plan: "plus",
      windows: [
        { id: "5h", label: "5h window", usedPercent: 19, remainingPercent: 81, resetsAt: null, resetsInSec: 7200, note: null },
      ],
      error: null,
      ok: true,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: 600,
    },
    {
      family: "antigravity",
      label: "Antigravity (Pi)",
      primaryWindowId: "gemini-5h",
      account: "fixture@example.com",
      plan: null,
      windows: [
        { id: "gemini-5h", label: "Gemini · 5h", usedPercent: 62, remainingPercent: 38, resetsAt: null, resetsInSec: 300, note: null },
        { id: "gemini-weekly", label: "Gemini · weekly", usedPercent: 3, remainingPercent: 97, resetsAt: null, resetsInSec: 900000, note: null },
      ],
      error: null,
      ok: true,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: 600,
    },
    {
      family: "opencode-go",
      label: "OpenCode Go (Pi)",
      primaryWindowId: null,
      account: "workspace wrk_x",
      plan: "Go subscription",
      windows: [],
      error: "no auth cookie",
      ok: false,
      updatedAt: "2030-01-01T00:00:00.000Z",
      expiresInMin: null,
    },
  ],
  generatedAt: "2030-01-01T00:00:00.000Z",
  sources: ["/tmp/auth.json"],
  warnings: [],
};

/**
 * Minimal fake of the ExtensionAPI subset the extension uses.
 *
 * @param {{ report?: unknown, fail?: boolean }} [options]
 */
function withFamilies(report) {
  return {
    ...report,
    byFamily:
      report.byFamily ??
      Object.fromEntries(report.providers.map((provider) => [provider.family, report.providers.filter((other) => other.family === provider.family)])),
  };
}

function makeHarness(options = {}) {
  const commands = [];
  const handlers = new Map();
  const statuses = [];
  const widgets = [];
  const notifications = [];
  const forbidden = [];

  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    exec: async () => {
      if (options.fail) throw new Error("piquota exploded");
      return { stdout: JSON.stringify(withFamilies(options.report ?? REPORT)), stderr: "", code: 0 };
    },
    registerCommand: (name, definition) => commands.push({ name, definition }),
    registerTool: () => forbidden.push("registerTool"),
    registerFlag: () => forbidden.push("registerFlag"),
    sendMessage: () => forbidden.push("sendMessage"),
    appendEntry: () => forbidden.push("appendEntry"),
    registerEntryRenderer: () => forbidden.push("registerEntryRenderer"),
  };

  const ctx = {
    hasUI: true,
    ui: {
      theme: options.theme ?? { fg: (_key, text) => text, bold: (text) => text },
      setStatus: (_key, value) => statuses.push(value),
      setWidget: (_key, value) => widgets.push(value),
      notify: (message) => notifications.push(message),
    },
  };

  return { pi, ctx, commands, handlers, statuses, widgets, notifications, forbidden };
}

async function startSession(harness) {
  await harness.handlers.get("session_start")({}, harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test("the extension loads and registers /quota and /usage", async () => {
  const module = await import(EXTENSION);
  assert.equal(typeof module.default, "function");

  const harness = makeHarness();
  module.default(harness.pi);

  assert.deepEqual(harness.commands.map((command) => command.name), ["quota", "usage"]);
  for (const command of harness.commands) {
    assert.equal(typeof command.definition.handler, "function");
    assert.equal(typeof command.definition.description, "string");
  }
  assert.equal(harness.forbidden.length, 0, "extension must not register context-affecting APIs");
});

test("the boxed widget is the default surface and the footer is left alone", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);

  const widget = renderWidget(harness.widgets.at(-1));
  assert.ok(Array.isArray(widget), "the quota surface must be a Pi widget: gentle-pi truncates the footer from the end");
  assert.equal(widget.length, 7, "the default surface is the five-row box with borders");
  assert.equal(harness.statuses.at(-1), undefined, "the footer must stay untouched by default");
});

test("the boxed widget remains when sidebar symbols are present but inactive", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);

  const tui = {
    terminal: {
      [Symbol.for("gentle-pi.experimental-sidebar.state")]: { active: false, ownsHost: () => true, parts: new Map() },
      [Symbol.for("gentle-pi.experimental-sidebar.cache")]: { revision: 0 },
    },
  };
  const lines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, tui);
  assert.match(plain(lines.join("\n")), /Claude:\s+○\s+4%/);
});

test("a patched active rail registers quota natively and suppresses the above-editor widget", async () => {
  await withRailFixtures(async ({ layoutPath }) => {
    const originalLayout = readFileSync(layoutPath, "utf-8");
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    assert.equal(readFileSync(layoutPath, "utf-8"), originalLayout, "startup must leave the installed layout unchanged");

    const state = { active: true, ownsHost: () => true, parts: new Map() };
    const lines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, { terminal: { [SIDEBAR_STATE]: state } });
    assert.deepEqual(lines, [], "the rail is painting the card, so the box must not duplicate it");
    assert.ok(state.parts.get("quota"), "the rail part must be registered under the patched key");
  }, { patched: true });
});

test("todo rail mounting suppresses the above-editor widget without ownsHost", async () => {
  await withRailFixtures(async () => {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const widget = harness.widgets.at(-1);
    const state = { active: false, parts: new Map([["todo", {}]]) };
    const tui = { terminal: { [SIDEBAR_STATE]: state } };
    const mountedWidget = widget(tui, harness.ctx.ui.theme);

    tui.terminal[SIDEBAR_STATE] = { active: true, ownsHost: () => false, parts: new Map([["todo", {}]]) };
    assert.deepEqual(mountedWidget.render(100), [], "a live active rail suppresses the duplicate even when ownsHost() is false");

    for (const activeState of [
      { active: true, parts: new Map([["todo", {}]]) },
      { active: false, parts: new Map([["todo", {}]]) },
    ]) {
      const activeTui = { terminal: { [SIDEBAR_STATE]: activeState } };
      const activeWidget = widget(activeTui, harness.ctx.ui.theme);
      if (!activeState.active) {
        activeTui.mode = "fullscreen";
        activeTui.terminal.columns = 140;
      }
      assert.deepEqual(activeWidget.render(100), [], "active state or a wide fullscreen rail suppresses the box");
    }
  });
});

test("an inactive patched rail keeps the default box and allows opting into the compact line", async () => {
  await withRailFixtures(async () => {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const state = { active: false, ownsHost: () => true, parts: new Map() };
    const tui = { terminal: { [SIDEBAR_STATE]: state } };
    const defaultLines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, tui);
    assert.equal(defaultLines.length, 7, "the box remains the default when the rail is inactive");

    const quota = harness.commands.find((command) => command.name === "quota");
    await quota.definition.handler("line", harness.ctx);
    const lines = renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme, 100, tui);
    assert.equal(lines.length, 1, "explicit /quota line opts into the compact surface");
    assert.match(plain(lines[0]), /Claude:○\s+4%/);
  }, { patched: true });
});

test("an unpatched active rail uses the runtime hook without changing gentle-pi files", async () => {
  await withRailFixtures(async ({ layoutPath }) => {
    const originalLayout = readFileSync(layoutPath, "utf-8");
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const originalFooter = {
      digest: () => "footer",
      render: (width) => [`footer ${width}`],
    };
    const state = { active: true, ownsHost: () => true, parts: new Map([["footer", originalFooter]]) };
    const tui = { terminal: { [SIDEBAR_STATE]: state } };
    const widget = harness.widgets.at(-1)(tui, harness.ctx.ui.theme);

    assert.deepEqual(widget.render(100), [], "the active rail owns the quota surface");
    assert.equal(readFileSync(layoutPath, "utf-8"), originalLayout, "an unpatched layout stays byte-for-byte pristine");
    assert.equal(existsSync(`${layoutPath}.pi-quota-backup`), false, "startup creates no patch backup");
    assert.equal(originalLayout, STOCK_RAIL);
    assert.equal(harness.notifications.length, 0, "runtime fallback needs no restart warning");
    const chainedFooter = state.parts.get("footer");
    assert.notEqual(chainedFooter, originalFooter);
    assert.ok(state.parts.has("quota"), "the runtime quota part remains registered");
    const railLines = chainedFooter.render(40);
    assert.equal(railLines[0], "footer 40");
    assert.match(plain(railLines.join("\n")), /Quota/);
    assert.match(plain(railLines.join("\n")), /Claude:/);

    widget.dispose();
    assert.equal(state.parts.get("footer"), originalFooter, "disposal restores the original footer component");
    assert.equal(state.parts.has("quota"), false, "disposal removes the quota rail part");
  });
});

test("a gentle-pi update that removes the rail slot stays untouched and needs no restart warning", async () => {
  await withRailFixtures(async ({ layoutPath }) => {
    const module = await import(EXTENSION);
    const first = makeHarness();
    module.default(first.pi);
    await startSession(first);
    assert.equal(readFileSync(layoutPath, "utf-8"), PATCHED_RAIL, "startup leaves the native rail layout unchanged");

    writeFileSync(layoutPath, STOCK_RAIL, "utf-8");

    const second = makeHarness();
    module.default(second.pi);
    await startSession(second);
    assert.equal(readFileSync(layoutPath, "utf-8"), STOCK_RAIL, "a package update remains unmodified");
    assert.equal(second.notifications.length, 0, "the runtime fallback does not ask for a restart");
  }, { patched: true });
});

test("the line shows used percent, not remaining", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);

  const visible = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  // Claude 5h is 96% left => 4% used; Antigravity's shortest window is 62% used.
  assert.match(visible, /Claude:\s+○\s+4%/);
  assert.match(visible, /Codex:\s+○\s+19%/);
  assert.match(visible, /Agy:\s+◕\s+62%/);
  assert.match(visible, /OP-Go:\s+!/);
  assert.equal(/left/.test(visible), false, "must not report remaining");
});

test("each provider name is painted with its own brand colour", async () => {
  const prevTerm = process.env.TERM;
  const prevNoColor = process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  try {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);

    const raw = String(renderWidget(harness.widgets.at(-1)).join("\n"));
    assert.match(raw, /\u001b\[38;2;217;119;87m/, "Claude clay");
    assert.match(raw, /\u001b\[38;2;16;163;127m/, "Codex teal");
    assert.match(raw, /\u001b\[38;2;66;133;244m/, "Google blue");
  } finally {
    process.env.TERM = prevTerm;
    if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("the semaphore changes colour and shape with the used band", async () => {
  const prevTerm = process.env.TERM;
  const prevNoColor = process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  try {
    const module = await import(EXTENSION);
    const harness = makeHarness();
    module.default(harness.pi);
    await startSession(harness);
    const raw = String(renderWidget(harness.widgets.at(-1)).join("\n"));

    assert.ok(raw.includes("#3FB950") === false);
    assert.match(raw, /\u001b\[38;2;63;185;80m○/, "green empty circle for low usage");
    assert.match(raw, /\u001b\[38;2;210;153;34m◕/, "amber half circle for mid usage");
  } finally {
    process.env.TERM = prevTerm;
    if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
    else delete process.env.NO_COLOR;
  }
});

test("NO_COLOR is honoured so a mono terminal stays readable", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  const previous = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    await startSession(harness);
    const raw = String(renderWidget(harness.widgets.at(-1)).join("\n"));
    assert.equal(/\u001b\[38;2;/.test(raw), false, "no truecolor when NO_COLOR is set");
    assert.match(raw, /Claude:\s+○\s+4%/);
  } finally {
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});

test("the bare command reveals the full panel and summarises used percent", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("", harness.ctx);

  const widget = harness.widgets.at(-1);
  assert.ok(widget.length > 1, "the panel lists every window");
  const text = plain(widget.join("\n"));
  assert.match(text, /5h window/);
  assert.match(text, /Weekly window/);
  assert.match(text, /Gemini · weekly/);
  assert.match(text, /used %/);

  assert.ok(harness.notifications.some((message) => message.includes("Claude: 4% used")));
  assert.ok(harness.notifications.some((message) => message.includes("OP-Go: unavailable")));
});

test("subcommands toggle the line, the panel, the footer and hide everything", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  const quota = harness.commands.find((command) => command.name === "quota");

  await quota.definition.handler("panel", harness.ctx);
  assert.ok(harness.widgets.at(-1).length > 1);

  await quota.definition.handler("line", harness.ctx);
  assert.equal(renderWidget(harness.widgets.at(-1)).length, 1);

  await quota.definition.handler("box", harness.ctx);
  assert.equal(renderWidget(harness.widgets.at(-1)).length, 7);

  await quota.definition.handler("status", harness.ctx);
  assert.match(plain(harness.statuses.at(-1)), /Claude:○ 4%/);

  await quota.definition.handler("nostatus", harness.ctx);
  assert.equal(harness.statuses.at(-1), undefined);

  await quota.definition.handler("hide", harness.ctx);
  assert.equal(harness.widgets.at(-1), undefined);
});

test("a failing CLI reports an error instead of throwing", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({ fail: true });
  module.default(harness.pi);
  await startSession(harness);

  assert.match(plain(renderWidget(harness.widgets.at(-1)).join("\n")), /quota …/);

  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("", harness.ctx);
  assert.ok(harness.notifications.some((message) => message.startsWith("Quota unavailable")));
});

test("session_shutdown clears both the footer and the widget", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);
  await harness.handlers.get("session_shutdown")({}, harness.ctx);

  assert.equal(harness.statuses.at(-1), undefined);
  assert.equal(harness.widgets.at(-1), undefined);
});

test("the line stays compact enough to fit one row", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);
  await startSession(harness);

  const visible = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.ok(visible.split("\n").every((line) => line.length <= 100), `box too wide: ${visible}`);
});

test("the first paint says loading, not unavailable", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness();
  module.default(harness.pi);

  // Paint before the async refresh resolves.
  await harness.handlers.get("session_start")({}, harness.ctx);
  const first = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(first, /quota …/);
  assert.equal(/unavailable/.test(first), false, "no false error before the first fetch");

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(plain(renderWidget(harness.widgets.at(-1)).join("\n")), /Claude:\s+○\s+4%/);
});

test("unconfigured providers are omitted from the editor line and summary", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: ["/tmp/auth.json"],
      warnings: [],
      providers: [
        {
          family: "claude",
          label: "Claude (Pi)",
          primaryWindowId: "5h",
          account: "fixture@example.com",
          plan: null,
          windows: [{ id: "5h", label: "5h", usedPercent: 10, remainingPercent: 90, resetsAt: null, resetsInSec: 3600, note: null }],
          error: null,
          ok: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: 60,
        },
        {
          family: "codex",
          label: "Codex (Pi)",
          primaryWindowId: "5h",
          account: "fixture@example.com",
          plan: "plus",
          windows: [{ id: "5h", label: "5h", usedPercent: 5, remainingPercent: 95, resetsAt: null, resetsInSec: 3600, note: null }],
          error: null,
          ok: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: 60,
        },
        {
          family: "antigravity",
          label: "Antigravity (Pi)",
          primaryWindowId: null,
          account: "unknown",
          plan: null,
          windows: [],
          error: "no antigravity credential in the Pi store",
          ok: false,
          notConfigured: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: null,
        },
        {
          family: "opencode-go",
          label: "OpenCode Go (Pi)",
          primaryWindowId: null,
          account: "unknown",
          plan: null,
          windows: [],
          error: "no opencode-go credential in the Pi store",
          ok: false,
          notConfigured: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: null,
        },
      ],
    },
  });
  module.default(harness.pi);
  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("line", harness.ctx);

  const visible = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  // When only Claude and Codex are in auth.json, only those two appear!
  assert.match(visible, /Claude:\s*○\s+10%/);
  assert.match(visible, /Codex:\s*○\s+5%/);
  assert.equal(visible.includes("Agy"), false, "unconfigured Antigravity must not appear in the line");
  assert.equal(visible.includes("OP-Go"), false, "unconfigured OpenCode Go must not appear in the line");
});

test("renderLine distinguishes transient / throttle / expired / auth with category-specific glyphs", async () => {
  const module = await import(EXTENSION);
  const providers = [
    ["transient", "HTTP 503 upstream"],
    ["throttle", "HTTP 429 rate limited"],
    ["expired", "token expired"],
    ["auth", "HTTP 401 unauthorized"],
  ].map(([family, error]) => ({
    family,
    label: family,
    primaryWindowId: null,
    account: "fixture@example.com",
    plan: null,
    windows: [],
    error,
    ok: false,
    updatedAt: "2030-01-01T00:00:00.000Z",
    expiresInMin: null,
  }));
  const harness = makeHarness({
    report: { generatedAt: "2030-01-01T00:00:00.000Z", sources: [], warnings: [], providers },
    theme: { fg: (key, text) => `[${key}:${text}]`, bold: (text) => text },
  });
  module.default(harness.pi);
  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("line", harness.ctx);

  const line = plain(renderWidget(harness.widgets.at(-1), harness.ctx.ui.theme).join("\n"));
  assert.match(line, /transient:\[warning:~\]/);
  assert.match(line, /throttle:\[warning:…\]/);
  assert.match(line, /expired:\[error:!\]/);
  assert.match(line, /auth:\[error:!\]/);
});

test("renderLine excludes notConfigured providers using the flag, not the error string", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [
        {
          family: "codex", label: "Codex", primaryWindowId: null, account: "fixture@example.com", plan: null, windows: [],
          error: "no credential in the Pi store", ok: false, updatedAt: "2030-01-01T00:00:00.000Z", expiresInMin: null,
        },
        {
          family: "claude", label: "Claude", primaryWindowId: null, account: "unknown", plan: null, windows: [],
          error: "token expired", ok: false, notConfigured: true, updatedAt: "2030-01-01T00:00:00.000Z", expiresInMin: null,
        },
      ],
    },
  });
  module.default(harness.pi);
  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("line", harness.ctx);

  const line = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(line, /Codex:\?/);
  assert.equal(line.includes("Claude"), false);
});

test("when mergeLastGood restores a transient failure, the line paints the carried value and not !", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-quota-extension-")), "last-good.json");
  const good = structuredClone(REPORT.providers[0]);
  const initial = withFamilies({ generatedAt: "2030-01-01T00:00:00.000Z", sources: [], warnings: [], providers: [good] });
  mergeLastGood(initial, { path, now: 1_000 });
  const failed = withFamilies({
    generatedAt: "2030-01-01T00:01:00.000Z",
    sources: [],
    warnings: [],
    providers: [{ ...good, windows: [], error: "request timed out", ok: false, note: null }],
  });
  const merged = mergeLastGood(failed, { path, now: 61_000 }).report;
  const module = await import(EXTENSION);
  const harness = makeHarness({ report: merged });
  module.default(harness.pi);
  await startSession(harness);

  const line = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.match(line, /Claude:\s+○\s+4%/);
  assert.equal(line.includes("Claude:!"), false);
  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("", harness.ctx);
  assert.match(plain(harness.widgets.at(-1).join("\n")), /last known values, 1 min old/);
});

test("renderPanel footer lists notConfigured providers using the flag", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [
        { ...structuredClone(REPORT.providers[0]), error: "no credential in the Pi store", ok: false, windows: [] },
        { ...structuredClone(REPORT.providers[1]), error: "token expired", ok: false, windows: [], notConfigured: true },
      ],
    },
  });
  module.default(harness.pi);
  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("panel", harness.ctx);

  const panel = plain(harness.widgets.at(-1).join("\n"));
  assert.match(panel, /Codex/);
  assert.match(panel, /not configured in Pi: Codex/);
  assert.equal(/not configured in Pi: Claude/.test(panel), false);
});

test("the bare /quota summary uses category captions, not the word unavailable for everything", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: [],
      warnings: [],
      providers: [{ ...structuredClone(REPORT.providers[0]), error: "token expired", ok: false, windows: [], expiresInMin: -1 }],
    },
  });
  module.default(harness.pi);
  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("", harness.ctx);

  const summary = harness.notifications.at(-1);
  assert.match(summary, /Claude: token expired/);
  assert.equal(summary.includes("unavailable"), false);
});

test("the panel names the Claude store, and the line never does", async () => {
  const module = await import(EXTENSION);
  const harness = makeHarness({
    report: {
      generatedAt: "2030-01-01T00:00:00.000Z",
      sources: ["/tmp/auth.json"],
      warnings: [],
      providers: [
        {
          family: "claude",
          label: "Claude (Pi)",
          primaryWindowId: "5h",
          account: "fixture@example.com",
          plan: "pro",
          sourceKind: "claude-code",
          windows: [{ id: "5h", label: "5h", usedPercent: 10, remainingPercent: 90, resetsAt: null, resetsInSec: 3600, note: null }],
          error: null,
          ok: true,
          updatedAt: "2030-01-01T00:00:00.000Z",
          expiresInMin: 60,
        },
      ],
    },
  });
  module.default(harness.pi);
  await startSession(harness);

  const line = plain(renderWidget(harness.widgets.at(-1)).join("\n"));
  assert.equal(/Claude Code CLI/.test(line), false, "the compact widget must stay short");
  assert.match(line, /Claude:\s+○\s+10%/);

  const quota = harness.commands.find((command) => command.name === "quota");
  await quota.definition.handler("", harness.ctx);
  const panel = plain(harness.widgets.at(-1).join("\n"));
  assert.match(panel, /Claude Code CLI/, "the panel says which store was read");
});

test("agent_end triggers a debounced quota refresh and agent_start cancels pending", async () => {
  const previousDebounce = process.env.PI_QUOTA_EVENT_DEBOUNCE_MS;
  process.env.PI_QUOTA_EVENT_DEBOUNCE_MS = "40";
  try {
    const module = await import(EXTENSION);
    let execCalls = 0;
    const harness = makeHarness();
    const originalExec = harness.pi.exec;
    harness.pi.exec = async (...args) => {
      execCalls++;
      return originalExec(...args);
    };
    module.default(harness.pi);
    await startSession(harness);
    const initialCalls = execCalls;

    const onAgentEnd = harness.handlers.get("agent_end");
    assert.equal(typeof onAgentEnd, "function", "must register agent_end handler");

    // 1. Calling agent_start before debounce cancels it
    await onAgentEnd({}, harness.ctx);
    const onAgentStart = harness.handlers.get("agent_start");
    assert.equal(typeof onAgentStart, "function", "must register agent_start handler");
    onAgentStart({}, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(execCalls, initialCalls, "agent_start must have cancelled the debounced refresh");

    // 2. Calling agent_end without interruption triggers refresh
    await onAgentEnd({}, harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(execCalls > initialCalls, "agent_end must have triggered a quota refresh");
  } finally {
    if (previousDebounce === undefined) delete process.env.PI_QUOTA_EVENT_DEBOUNCE_MS;
    else process.env.PI_QUOTA_EVENT_DEBOUNCE_MS = previousDebounce;
  }
});

