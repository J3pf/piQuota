/**
 * Shared renderers: a compact single line for status bars and a boxed panel for
 * terminals and TUI widgets.
 *
 * Both take a `Paint` function so the terminal can use ANSI while the Pi TUI
 * can paint through its own theme.
 */

import { bar, percentText, ringGlyph, thresholdKey } from "./theme.js";
import { errorCaption, errorKind } from "../providers/error-kind.js";
import { humanReset, selectPrimaryWindow } from "../model.js";

const FAMILY_SHORT = {
  claude: "C",
  codex: "X",
  antigravity: "A",
  "opencode-go": "G",
};

const FAMILY_TITLE = {
  claude: "Claude (Pi)",
  codex: "Codex (Pi)",
  antigravity: "Antigravity (Pi)",
  "opencode-go": "OpenCode Go (Pi)",
};

const MIN_WIDTH = 52;
const MAX_WIDTH = 104;
const NOTE_MAX = 44;
/** Visible width reserved by `│ ` + ` │` on box content lines. */
const BOX_PADDING = 4;

/**
 * The window that represents a provider at a glance: the shortest one, so a
 * status line answers "can I keep working right now".
 *
 * @param {import("../model.js").QuotaResult} provider
 * @returns {import("../model.js").QuotaWindow | null}
 */
export function headlineWindow(provider) {
  const byId = (provider.windows ?? []).find((window) => window.id === provider.primaryWindowId);
  return byId ?? selectPrimaryWindow(provider.windows ?? []);
}

/** @param {string} kind @returns {string} */
function statusGlyphForKind(kind) {
  switch (kind) {
    case "transient":
      return "~";
    case "throttle":
      return "…";
    case "expired":
    case "auth":
      return "!";
    case "missing":
      return "·";
    default:
      return "?";
  }
}

/** @param {string} kind @returns {string} */
function statusPaintKeyForKind(kind) {
  if (kind === "transient" || kind === "throttle") return "warn";
  if (kind === "missing") return "dim";
  if (kind === "unknown") return "unknown";
  return "danger";
}

/**
 * Compact status-line text, e.g. `C ●  78%  ·  X ◑  44%  ·  A ○   8%  ·  G ! n/a`.
 *
 * @param {import("../model.js").QuotaResult[]} providers
 * @param {import("./theme.js").Paint} paint
 * @returns {string}
 */
export function renderStatusLine(providers, paint) {
  const active = providers.filter((provider) => !provider.notConfigured);
  if (active.length === 0) return paint("dim", "quota: no configured providers");

  const parts = [];
  for (const provider of active) {
    const short = FAMILY_SHORT[provider.family] ?? provider.family.slice(0, 1).toUpperCase();
    const window = headlineWindow(provider);
    const remaining = window?.remainingPercent ?? null;

    if (!provider.ok) {
      const kind = errorKind(provider.error);
      parts.push(paint(statusPaintKeyForKind(kind), `${short} ${statusGlyphForKind(kind)} ${errorCaption(provider.error)}`));
      continue;
    }

    if (remaining === null) {
      parts.push(paint("unknown", `${short} ? n/a`));
      continue;
    }

    parts.push(paint(thresholdKey(remaining), `${short} ${ringGlyph(remaining)} ${`${Math.round(remaining)}%`.padStart(4)}`));
  }
  return parts.join(paint("dim", "  ·  "));
}

/**
 * Truncate plain text to a visible width, appending an ellipsis when cut.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
function clip(text, width) {
  if (text.length <= width) return text;
  return text.slice(0, Math.max(0, width - 1)).trimEnd() + "…";
}

/**
 * Wrap plain text on word boundaries.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function wrapPlain(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  /** @type {string[]} */
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    current = word.length > width ? clip(word, width) : word;
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/**
 * Per-provider detail lines, without box decoration.
 *
 * @param {import("../model.js").QuotaResult} provider
 * @param {import("./theme.js").Paint} paint
 * @param {number} contentWidth
 * @returns {string[]}
 */
export function renderProviderLines(provider, paint, contentWidth = MAX_WIDTH) {
  const title = FAMILY_TITLE[provider.family] ?? provider.label;
  /** @type {string[]} */
  const lines = [];

  const meta = [provider.account];
  if (provider.plan) meta.push(`plan ${provider.plan}`);
  // Claude has two stores, and a broken one is the first thing to rule out when
  // the percentage looks wrong, so the panel names the store it actually read.
  if (provider.sourceKind === "claude-code") meta.push("Claude Code CLI");
  if (provider.expiresInMin !== null && provider.expiresInMin <= 120) {
    meta.push(provider.expiresInMin < 0 ? "token EXPIRED" : `token ${provider.expiresInMin}m`);
  }
  lines.push(clip(`${paint("bold", title)} ${paint("dim", `· ${meta.join(" · ")}`)}`, contentWidth));

  if (!provider.ok) {
    const wrapped = wrapPlain(provider.error ?? "unavailable", contentWidth - 6);
    lines.push(`  ${paint("danger", "!")} ${paint("warning", wrapped[0])}`);
    for (const extra of wrapped.slice(1)) lines.push(`    ${paint("warning", extra)}`);
    for (const window of provider.windows ?? []) {
      lines.push(`  ${paint("dim", window.label)} ${renderWindow(window, paint, contentWidth)}`);
    }
    return lines;
  }

  if ((provider.windows ?? []).length === 0) {
    lines.push(`  ${paint("dim", "no rate-limit windows reported")}`);
    return lines;
  }

  const labelWidth = Math.max(...provider.windows.map((window) => window.label.length));
  for (const window of provider.windows) {
    lines.push(`  ${paint("dim", window.label.padEnd(labelWidth))}  ${renderWindow(window, paint, contentWidth)}`);
  }
  return lines;
}

/**
 * @param {import("../model.js").QuotaWindow} window
 * @param {import("./theme.js").Paint} paint
 * @param {number} contentWidth
 * @returns {string}
 */
function renderWindow(window, paint, contentWidth) {
  if (window.remainingPercent === null) {
    return paint("dim", clip(window.note ?? "no percentage reported", NOTE_MAX));
  }
  const key = thresholdKey(window.remainingPercent);
  const parts = [
    paint(key, ringGlyph(window.remainingPercent)),
    paint(key, bar(window.remainingPercent)),
    paint(key, percentText(window.remainingPercent)),
    paint("dim", "left"),
  ];
  if (window.resetsInSec !== null) {
    parts.push(paint("dim", `· ${humanReset(window.resetsInSec)}`));
  }
  if (window.note) {
    parts.push(paint("dim", `· ${clip(window.note, NOTE_MAX)}`));
  }
  return clip(parts.join(" "), contentWidth);
}

/**
 * Boxed panel for the terminal.
 *
 * @param {import("../model.js").QuotaResult[]} providers
 * @param {import("./theme.js").Paint} paint
 * @param {{ generatedAt?: string, warnings?: string[], maxWidth?: number }} [meta]
 * @returns {string[]}
 */
export function renderPanel(providers, paint, meta = {}) {
  const terminalWidth = typeof process?.stdout?.columns === "number" ? process.stdout.columns : MAX_WIDTH;
  const hardMax = Math.max(MIN_WIDTH, Math.min(meta.maxWidth ?? MAX_WIDTH, terminalWidth - 2, MAX_WIDTH));

  // Render once at the hard maximum, then settle on the natural width of the
  // content so long degradation messages cannot stretch every other row.
  const firstPass = providers.flatMap((provider) => renderProviderLines(provider, paint, hardMax - BOX_PADDING));
  const natural = Math.max(...firstPass.map((line) => visibleLength(line)), MIN_WIDTH - BOX_PADDING);
  const contentWidth = Math.max(MIN_WIDTH - BOX_PADDING, Math.min(natural, hardMax - BOX_PADDING));

  /** @type {string[]} */
  const out = [];
  const title = " pi quota ";
  // Top border: "╭─" + title + dashes + "╮" must equal the content lines' width.
  out.push(paint("accent", `╭─${title}${"─".repeat(Math.max(0, contentWidth - 9))}╮`));

  for (const provider of providers) {
    for (const line of renderProviderLines(provider, paint, contentWidth)) {
      out.push(`${paint("accent", "│")} ${padVisible(clip(line, contentWidth), contentWidth)} ${paint("accent", "│")}`);
    }
  }

  out.push(paint("accent", `├${"─".repeat(contentWidth + 2)}┤`));
  const footer = `read-only · ${meta.generatedAt ?? ""}`.trim();
  out.push(`${paint("accent", "│")} ${padVisible(clip(paint("dim", footer), contentWidth), contentWidth)} ${paint("accent", "│")}`);
  for (const warning of meta.warnings ?? []) {
    for (const piece of wrapPlain(warning, contentWidth - 7)) {
      out.push(
        `${paint("accent", "│")} ${padVisible(clip(paint("warn", `warn: ${piece}`), contentWidth), contentWidth)} ${paint("accent", "│")}`,
      );
    }
  }
  out.push(paint("accent", `╰${"─".repeat(contentWidth + 2)}╯`));
  return out;
}

/**
 * Length of a string ignoring ANSI SGR sequences.
 *
 * @param {string} text
 * @returns {number}
 */
export function visibleLength(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/**
 * Pad to a visible width while preserving embedded ANSI sequences.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function padVisible(text, width) {
  const missing = width - visibleLength(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/**
 * One-line-per-provider summary used when `--compact` is requested.
 *
 * @param {import("../model.js").QuotaResult[]} providers
 * @param {import("./theme.js").Paint} paint
 * @returns {string[]}
 */
export function renderCompact(providers, paint) {
  return providers.map((provider) => {
    const window = headlineWindow(provider);
    const remaining = window?.remainingPercent ?? null;
    const key = provider.ok ? thresholdKey(remaining) : "unknown";
    let status;
    if (!provider.ok) {
      status = `! ${provider.error}`;
    } else if (remaining === null) {
      status = "no percentage reported";
    } else {
      const reset = window?.resetsInSec !== null && window ? ` · ${humanReset(window.resetsInSec)}` : "";
      status = `${ringGlyph(remaining)} ${Math.round(remaining)}% left${reset}`;
    }
    return `${paint("bold", provider.label.padEnd(20))} ${paint(key, status)}`;
  });
}

export { clip as truncateVisibleText, wrapPlain as wrapVisibleText };
