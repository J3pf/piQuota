/**
 * Pi quota line — read-only quota for the providers Pi already owns.
 *
 * Surface: one compact line above the editor (its own row, so gentle-pi's shell
 * bar cannot pop it out), plus an optional detailed panel.
 *
 * Design rules:
 *   - the numbers are **used**, not remaining, so the line answers "how much have
 *     I burned" and the bar fills up as you spend;
 *   - each provider name is painted with its own brand colour, which Pi's theme
 *     does not expose, so it is emitted as truecolor ANSI. Widget string arrays
 *     are wrapped in Text components, which are ANSI-aware, so the codes are
 *     measured correctly. `NO_COLOR` / `TERM=dumb` disables them;
 *   - the semaphore is both colour and shape (empty circle = plenty left, filled
 *     circle = nearly spent), so it survives a colourblind or mono terminal;
 *   - the footer status is off by default: gentle-pi already owns that line and
 *     truncates it from the end.
 *
 * Commands: /quota, /usage, /quota refresh | line | panel | hide | status |
 * nostatus | json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// `mergeLastGood` is intentionally NOT imported here: it lives in src/moshi/sticky.js
// and the CLI (`bin/piquota.js`) already applies it on every `--json` run, so the
// extension sees a report whose transiently-failed families already carry the last
// good snapshot in `provider.note`. The classifier below mirrors src/providers/error-kind.js
// so the extension can render category-specific glyphs without depending on the repo.

const STATUS_KEY = "00-quota";
const WIDGET_KEY = "quota-line";
const RAIL_KEY = "quota";
// gentle-pi publishes its rail state on the terminal, so the only way to know the
// rail is painting the card (and the above-editor box would duplicate it) is to read
// it. Every read is guarded: when the rail slot was never patched in, nothing here
// runs and the box stays the only surface.
const SIDEBAR_STATE_KEY = Symbol.for("gentle-pi.experimental-sidebar.state");
const REFRESH_MS = 60_000;
const EXEC_TIMEOUT_MS = 30_000;

type QuotaWindow = {
  id: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  resetsInSec: number | null;
  windowSeconds?: number | null;
  note: string | null;
};

type QuotaProvider = {
  family: string;
  label: string;
  primaryWindowId?: string | null;
  account: string;
  plan: string | null;
  windows: QuotaWindow[];
  error: string | null;
  note?: string | null;
  ok: boolean;
  notConfigured?: boolean;
  sourceKind?: "pi" | "claude-code";
  updatedAt: string;
  expiresInMin: number | null;
};

type QuotaReport = {
  providers: QuotaProvider[];
  generatedAt: string;
  sources: string[];
  warnings: string[];
  byFamily: Record<string, QuotaProvider[]>;
};

type Theme = {
  fg: (key: string, text: string) => string;
  bold: (text: string) => string;
  bg?: (key: string, text: string) => string;
};

/** Only the UI surface this extension uses. */
type UiContext = {
  hasUI: boolean;
  ui: {
    theme: Theme;
    setStatus: (key: string, value: string | undefined) => void;
    setWidget: (key: string, value: any, options?: { placement?: string }) => void;
    notify: (message: string, type?: string) => void;
  };
};

/** Brand accents. Anthropic clay, OpenAI teal, Google blue, OpenCode accent. */
const BRAND: Record<string, string> = {
  claude: "#D97757",
  codex: "#10A37F",
  antigravity: "#4285F4",
  "opencode-go": "#007AFF",
};

/** Short display names that stay legible in one row. */
const SHORT_NAME: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Agy",
  "opencode-go": "OP-Go",
};

/** Semaphore bands, expressed in *used* percent. */
const BANDS = [
  { max: 25, color: "#3FB950", glyph: "○" },
  { max: 50, color: "#3FB950", glyph: "◔" },
  { max: 80, color: "#D29922", glyph: "◕" },
  { max: Infinity, color: "#F85149", glyph: "●" },
];

function colorEnabled(): boolean {
  return process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

/** 24-bit foreground colour; a no-op when colours are disabled. */
function paint(hex: string, text: string): string {
  if (!colorEnabled() || !/^#[0-9a-fA-F]{6}$/.test(hex)) return text;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
}

function bandFor(usedPercent: number) {
  return BANDS.find((band) => usedPercent < band.max) ?? BANDS[BANDS.length - 1];
}

function usedOf(window: QuotaWindow | null): number | null {
  if (!window) return null;
  if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) return window.usedPercent;
  if (typeof window.remainingPercent === "number" && Number.isFinite(window.remainingPercent)) {
    return 100 - window.remainingPercent;
  }
  return null;
}

function resolveCliPath(): string | null {
  const override = process.env.PI_QUOTA_BIN;
  if (override && existsSync(override)) return override;
  const installed = join(homedir(), ".local", "share", "pi-quota", "bin", "piquota.js");
  return existsSync(installed) ? installed : null;
}

/**
 * Rank by how soon a window constrains you: 5h/session first, then daily,
 * weekly, monthly. Kept in sync with windowRank() in src/model.js.
 */
function windowRank(window: QuotaWindow): number {
  const seconds = window.windowSeconds;
  if (typeof seconds === "number" && seconds > 0) {
    if (seconds <= 6 * 3600) return 0;
    if (seconds <= 36 * 3600) return 1;
    if (seconds <= 8 * 86400) return 2;
    if (seconds <= 31 * 86400) return 3;
  }
  const id = (window.id ?? "").toLowerCase();
  if (/5h|session|hour|rolling/.test(id)) return 0;
  if (/daily|day/.test(id)) return 1;
  if (/weekly|week|7d/.test(id)) return 2;
  if (/monthly|month|30d/.test(id)) return 3;
  return 4;
}

/**
 * The window that represents a provider: the shortest one, so the row answers
 * "can I keep working right now". Prefers the window the CLI already chose.
 */
function headline(provider: QuotaProvider): QuotaWindow | null {
  const chosen = provider.windows.find((window) => window.id === provider.primaryWindowId);
  if (chosen) return chosen;

  const scored = provider.windows.filter((window) => usedOf(window) !== null);
  if (scored.length === 0) return provider.windows[0] ?? null;
  return scored.reduce((best, window) => {
    const bestRank = windowRank(best);
    const rank = windowRank(window);
    if (rank !== bestRank) return rank < bestRank ? window : best;
    return (usedOf(window) as number) > (usedOf(best) as number) ? window : best;
  });
}

function bar(usedPercent: number | null, width = 10): string {
  if (usedPercent === null) return "·".repeat(width);
  const filled = Math.round((Math.max(0, Math.min(100, usedPercent)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function humanDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown";
  if (seconds <= 0) return "now";
  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

type ErrorKind = "transient" | "throttle" | "expired" | "auth" | "missing" | "unknown";

/**
 * Classify a provider error so the renderer can paint a distinct glyph and
 * caption per cause. Mirrors src/providers/error-kind.js so the extension is
 * self-contained: the file lives in ~/.pi/agent/extensions and has no access
 * to the repo's `src/` tree.
 */
function errorKind(error: string | null | undefined): ErrorKind {
  if (!error || typeof error !== "string") return "unknown";
  if (
    /no [a-z-]+ credential|has no (anthropic|openai-codex|antigravity|opencode-go) (access )?token|no key stored|no "auth" cookie|no opencode\.ai session/i.test(
      error,
    )
  ) {
    return "missing";
  }
  if (
    /token expired|token EXPIRED|token -?\d+m|expires in -\d+|sign-in expired|re-authenticate|expired or rejected|rejected by .* zen|rejected; run \/login|reconnect OpenCode in Pi/i.test(
      error,
    )
  ) {
    return "expired";
  }
  if (/HTTP 401|HTTP 403|401|403|unauthorized|forbidden|invalid_grant|token rejected/i.test(error)) {
    return "auth";
  }
  if (/HTTP 429|rate limited|backing off|throttle/i.test(error)) {
    return "throttle";
  }
  if (/HTTP 5\d\d|timed out|timeout|ECONNRESET|socket|network|fetch failed|ENOTFOUND|ETIMEDOUT|EPIPE|ECONNREFUSED|aborted|hang up/i.test(error)) {
    return "transient";
  }
  return "unknown";
}

function isRecoverableError(error: string | null | undefined): boolean {
  const kind = errorKind(error);
  return kind === "transient" || kind === "throttle";
}

function errorGlyph(error: string | null | undefined): string {
  switch (errorKind(error)) {
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

function errorCaption(error: string | null | undefined): string {
  switch (errorKind(error)) {
    case "throttle":
      return "rate-limited upstream";
    case "transient":
      return "upstream temporarily unavailable";
    case "expired":
      return "token expired";
    case "auth":
      return "credential rejected";
    case "missing":
      return "not configured";
    default:
      return "unavailable";
  }
}

/**
 * The one-row line: brand-coloured name plus a semaphore and the used percent.
 *
 *   Claude:○ 0%   Codex:○ 8%   Agy:○ 4%   Agy C/G:○ 4%   OP-Go:○ 3%
 */
function renderLine(report: QuotaReport, theme: Theme): string {
  // Only display providers that are configured in Pi.
  // A provider that is simply not configured does not belong in the editor line.
  const active = report.providers.filter((provider) => provider.notConfigured !== true);
  if (active.length === 0) return theme.fg("dim", "quota: no providers configured in Pi");

  const renderToken = (provider: QuotaProvider, label: string, window: QuotaWindow | null, color = BRAND[provider.family] ?? "#8B949E"): string => {
    const name = paint(color, `${label}:`);
    if (!provider.ok) {
      const kind = errorKind(provider.error);
      const glyph = errorGlyph(provider.error);
      const tone = kind === "transient" || kind === "throttle" ? "warning" : kind === "expired" || kind === "auth" ? "error" : "dim";
      return `${name}${theme.fg(tone, glyph)}`;
    }

    const used = usedOf(window);
    if (used === null) return `${name}${theme.fg("dim", "?")}`;

    const band = bandFor(used);
    return `${name}${paint(band.color, band.glyph)} ${paint(band.color, `${Math.round(used)}%`)}`;
  };
  const tokens = active.flatMap((provider) => {
    if (provider.family !== "antigravity") {
      return [renderToken(provider, SHORT_NAME[provider.family] ?? provider.family, headline(provider))];
    }
    return [
      renderToken(provider, "Agy", provider.windows.find((window) => window.id === "gemini-5h" || (/gemini/i.test(window.id) && isFiveHour(window)))),
      renderToken(provider, "Agy C/G", provider.windows.find((window) => window.id === "claude-gpt-5h" || (/(claude|gpt|3p)/i.test(window.id) && isFiveHour(window))), "#7AA2F7"),
    ];
  });
  return tokens.join("  ");
}

function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/**
 * Clip themed text to a visible width without cutting an ANSI sequence in half.
 * gentle-pi drops the entire rail when one card line overflows its column, so a
 * long error caption must shorten the line instead of widening it.
 */
function clipVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const tokens = text.match(/\u001b\[[0-9;]*m|[\s\S]/g) ?? [];
  let out = "";
  let used = 0;
  for (const token of tokens) {
    if (token.startsWith("\u001b")) {
      out += token;
      continue;
    }
    if (used >= width - 1) break;
    out += token;
    used += 1;
  }
  return `${out}\u2026\u001b[0m`;
}

function isFiveHour(window: QuotaWindow): boolean {
  return (
    window.id === "5h" ||
    /5h|session|hour/i.test(`${window.id} ${window.label}`) ||
    (typeof window.windowSeconds === "number" && window.windowSeconds <= 6 * 3600)
  );
}

/** Compact five-row quota widget aligned to the right edge of the editor. */
export function renderBox(report: QuotaReport, theme: Theme, totalWidth?: number): string[] {
  const providerFor = (family: string): QuotaProvider | undefined => report.providers.find((provider) => provider.family === family);
  const windowFor = (family: string, matches: (window: QuotaWindow) => boolean) => {
    const provider = providerFor(family);
    return { provider, window: provider?.windows.find(matches) ?? null };
  };
  const rows = [
    { label: "Claude: ", color: "#D97757", ...windowFor("claude", isFiveHour) },
    { label: "Codex:  ", color: "#10A37F", ...windowFor("codex", isFiveHour) },
    { label: "Agy:    ", color: "#4285F4", ...windowFor("antigravity", (window) => window.id === "gemini-5h" || (/gemini/i.test(window.id) && isFiveHour(window))) },
    { label: "Agy C/G:", color: "#7AA2F7", ...windowFor("antigravity", (window) => window.id === "claude-gpt-5h" || (/(claude|gpt|3p)/i.test(window.id) && isFiveHour(window))) },
    { label: "OP-Go:  ", color: "#007AFF", ...windowFor("opencode-go", isFiveHour) },
  ];
  const content = rows.map(({ label, color, provider, window }) => {
    const name = paint(color, label);
    if (!provider || !provider.ok) {
      return { left: `${name} ${theme.fg("error", `! ${provider ? errorCaption(provider.error) : "not configured"}`)}`, right: "" };
    }
    const used = usedOf(window);
    let mid = theme.fg("dim", "? n/a");
    if (used !== null) {
      const band = bandFor(used);
      mid = paint(band.color, `${band.glyph} ${`${Math.round(used)}%`.padStart(4)}`);
    }
    return {
      left: `${name} ${mid}`,
      right: `${theme.fg("dim", "R:")}${paint("#E0AF68", humanDuration(window?.resetsInSec ?? null))}`,
    };
  });
  const innerWidth = Math.max(25, ...content.map(({ left, right }) => visibleLength(left) + (right ? 2 + visibleLength(right) : 0)));
  const box = [
    `╭─ Quota ${"─".repeat(Math.max(0, innerWidth - 6))}╮`,
    ...content.map(({ left, right }) => {
      const padding = right
        ? " ".repeat(Math.max(1, innerWidth - visibleLength(left) - visibleLength(right)))
        : " ".repeat(Math.max(0, innerWidth - visibleLength(left)));
      return `│ ${left}${padding}${right} │`;
    }),
    `╰${"─".repeat(innerWidth + 2)}╯`,
  ];
  const width = totalWidth ?? (process.stdout.columns || 80);
  return box.map((line) => `${" ".repeat(Math.max(0, width - visibleLength(line)))}${line}`);
}

function renderSidebarCard(report: QuotaReport | null, theme: Theme, width: number): string[] {
  const cardWidth = Math.max(4, width);
  const innerWidth = cardWidth - 4;
  const providerFor = (family: string): QuotaProvider | undefined => report?.providers.find((provider) => provider.family === family);
  const windowFor = (family: string, matches: (window: QuotaWindow) => boolean) => {
    const provider = providerFor(family);
    return { provider, window: provider?.windows.find(matches) ?? null };
  };
  const rows = report
    ? [
        { label: "Claude: ", color: "#D97757", ...windowFor("claude", isFiveHour) },
        { label: "Codex:  ", color: "#10A37F", ...windowFor("codex", isFiveHour) },
        { label: "Agy:    ", color: "#4285F4", ...windowFor("antigravity", (window) => window.id === "gemini-5h" || (/gemini/i.test(window.id) && isFiveHour(window))) },
        { label: "Agy C/G:", color: "#7AA2F7", ...windowFor("antigravity", (window) => window.id === "claude-gpt-5h" || (/(claude|gpt|3p)/i.test(window.id) && isFiveHour(window))) },
        { label: "OP-Go:  ", color: "#007AFF", ...windowFor("opencode-go", isFiveHour) },
      ]
    : [];
  const content = rows.length > 0
    ? rows.map(({ label, color, provider, window }) => {
        const name = paint(color, label);
        const showingLastKnownValues = Boolean(provider?.note && /last known values/i.test(provider.note));
        if (!provider || (!provider.ok && !showingLastKnownValues)) {
          return { left: `${name} ! ${provider ? errorCaption(provider.error) : "not configured"}`, right: "" };
        }
        const used = usedOf(window);
        if (used === null) return { left: `${name} ? n/a`, right: "" };
        const band = bandFor(used);
        const indicator = showingLastKnownValues ? `${theme.fg("warning", "~")} ` : "";
        return {
          left: `${name} ${indicator}${paint(band.color, `${band.glyph} ${`${Math.round(used)}%`.padStart(4)}`)}`,
          right: `${theme.fg("dim", "R:")}${paint("#E0AF68", humanDuration(window?.resetsInSec ?? null))}`,
        };
      })
    : [{ left: theme.fg("dim", "loading quota …"), right: "" }];
  return [
    `╭─ Quota ${"─".repeat(Math.max(0, cardWidth - 10))}╮`,
    ...content.map(({ left, right }) => {
      // The right column is dropped before the left one is clipped: a reset countdown
      // matters less than the provider name and its percentage.
      const fits = right !== "" && 2 + visibleLength(left) + 2 + visibleLength(right) + 2 <= cardWidth;
      const rightText = fits ? right : "";
      const leftRoom = innerWidth - (rightText === "" ? 0 : visibleLength(rightText) + 1);
      const leftText = clipVisible(left, Math.max(1, leftRoom));
      const padding = " ".repeat(Math.max(0, innerWidth - visibleLength(leftText) - visibleLength(rightText)));
      return `│ ${leftText}${padding}${rightText} │`;
    }),
    `╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`,
  ];
}

/** The detailed panel: every window, with a used-fraction bar. */
function renderPanel(report: QuotaReport, theme: Theme): string[] {
  const lines: string[] = [];
  const active = report.providers.filter((provider) => provider.notConfigured !== true);
  const unconfigured = report.providers.filter((provider) => provider.notConfigured === true);

  for (const provider of active) {
    const name = paint(BRAND[provider.family] ?? "#8B949E", provider.label);
    const meta = [provider.account];
    if (provider.plan) meta.push(`plan ${provider.plan}`);
    // Two stores can back Claude, and this is the one place that says which.
    if (provider.sourceKind === "claude-code") meta.push("Claude Code CLI");
    if (provider.expiresInMin !== null && provider.expiresInMin <= 120) {
      meta.push(
        provider.expiresInMin < 0
          ? theme.fg("error", "token expired")
          : theme.fg("dim", `token ${provider.expiresInMin}m`),
      );
    }
    lines.push(`${name} ${theme.fg("dim", `· ${meta.join(" · ")}`)}`);

    if (!provider.ok) {
      const kind = errorKind(provider.error);
      const glyph = errorGlyph(provider.error);
      const color = kind === "transient" || kind === "throttle" ? "warning" : kind === "expired" || kind === "auth" ? "error" : "dim";
      lines.push(`  ${theme.fg(color, glyph)} ${theme.fg("warning", provider.note ?? errorCaption(provider.error))}`);
      if (isRecoverableError(provider.error) && provider.note) lines.push(`  ${theme.fg("warning", provider.note)}`);
      continue;
    }
    if (provider.note) lines.push(`  ${theme.fg("warning", `~ ${provider.note}`)}`);
    if (provider.windows.length === 0) {
      lines.push(`  ${theme.fg("dim", "no rate-limit windows reported")}`);
      continue;
    }

    const width = Math.max(...provider.windows.map((window) => window.label.length));
    for (const window of provider.windows) {
      const used = usedOf(window);
      const label = theme.fg("dim", window.label.padEnd(width));
      if (used === null) {
        lines.push(`  ${label}  ${theme.fg("dim", window.note ?? "no percentage reported")}`);
        continue;
      }
      const band = bandFor(used);
      const reset = window.resetsInSec === null ? "" : theme.fg("dim", ` · reset in ${humanDuration(window.resetsInSec)}`);
      lines.push(
        `  ${label}  ${paint(band.color, band.glyph)} ${paint(band.color, bar(used))} ` +
          `${paint(band.color, `${used.toFixed(used < 10 ? 1 : 0)}%`.padStart(5))} ` +
          `${theme.fg("dim", "used")}${reset}`,
      );
    }
  }
  lines.push(theme.fg("dim", `used % · read-only · ${report.generatedAt}`));
  if (unconfigured.length > 0) {
    const names = unconfigured.map((p) => SHORT_NAME[p.family] ?? p.family).join(", ");
    lines.push(theme.fg("dim", `not configured in Pi: ${names}`));
  }
  for (const warning of report.warnings.slice(0, 3)) {
    lines.push(theme.fg("warning", `warn: ${warning}`));
  }
  return lines;
}

export default function quotaPanelExtension(pi: ExtensionAPI): void {
  let report: QuotaReport | null = null;
  let refreshing = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let panelVisible = false;
  /** The compact box is the default surface: its own row, nothing competes for it. */
  let lineVisible = true;
  let boxVisible = true;
  /** gentle-pi owns the footer and truncates it from the end, so start off. */
  let statusVisible = false;
  let lastError: string | null = null;
  let disposed = false;
  /** True once the installed gentle-pi is known to paint a rail slot for this card. */
  let railMode = false;

  /**
   * The rail patcher lives in the installed CLI tree, which is the only copy the
   * extension can reach: it is loaded from ~/.pi/agent/extensions and has no access
   * to the repository's src/. A missing tree is not an error, it just means the
   * native box stays the only surface.
   */
  async function loadRailPatcher(): Promise<{
    resolveGentlePiLayout: (options?: { dir?: string }) => { layoutPath: string; present: boolean };
    ensureRailPatch: (options: { layoutPath: string }) => { repaired: boolean; ok: boolean; state: string; detail: string };
  } | null> {
    const cli = resolveCliPath();
    if (!cli) return null;
    const modulePath = join(dirname(cli), "..", "src", "gentle-pi", "rail-patch.js");
    if (!existsSync(modulePath)) return null;
    try {
      return await import(pathToFileURL(modulePath).href);
    } catch {
      return null;
    }
  }

  /**
   * Validate the gentle-pi rail slot on every session start and repair it when a
   * gentle-pi update replaced the patched file with the stock revision.
   */
  async function syncRailPatch(ctx: UiContext): Promise<void> {
    railMode = false;
    const patcher = await loadRailPatcher();
    if (!patcher) return;
    const layout = patcher.resolveGentlePiLayout();
    if (!layout.present) return;
    const result = patcher.ensureRailPatch({ layoutPath: layout.layoutPath });
    railMode = result.ok && result.state === "patched";
    if (result.repaired) {
      ctx.ui.notify(`gentle-pi lost the quota rail slot (${result.detail}); it has been re-applied. Restart Pi to load it.`, "info");
    }
  }

  async function runCli(args: string[]): Promise<QuotaReport | null> {
    const cli = resolveCliPath();
    if (!cli) {
      lastError = "piquota not installed: run install.sh from the pi-quota repo";
      return null;
    }
    try {
      const runner = /node(\.exe)?$/i.test(process.execPath) ? process.execPath : "node";
      const result = await pi.exec(runner, [cli, ...args], { timeout: EXEC_TIMEOUT_MS });
      if (!result.stdout || result.stdout.trim() === "") {
        lastError = result.stderr?.trim() || "piquota produced no output";
        return null;
      }
      const parsed = JSON.parse(result.stdout) as QuotaReport;
      if (!parsed || !Array.isArray(parsed.providers)) {
        lastError = "piquota output was not a quota report";
        return null;
      }
      lastError = null;
      return parsed;
    } catch (error) {
      lastError = (error as { message?: string })?.message ?? String(error);
      return null;
    }
  }

  function paintUi(ctx: UiContext): void {
    if (disposed) return;
    const theme = ctx.ui.theme;

    if (statusVisible) {
      ctx.ui.setStatus(STATUS_KEY, report ? renderLine(report, theme) : theme.fg("dim", "quota …"));
    } else {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    if (panelVisible && report) {
      ctx.ui.setWidget(WIDGET_KEY, renderPanel(report, theme), { placement: "aboveEditor" });
      return;
    }

    if (!boxVisible && !lineVisible) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui: any, widgetTheme: Theme) => {
        const state = railMode ? tui?.terminal?.[SIDEBAR_STATE_KEY] : undefined;
        const activeTheme = widgetTheme || theme;
        const digest = () =>
          report
            ? `${report.generatedAt}:${report.providers
                .map((provider) =>
                  provider.windows
                    .map((window) => [window.id, window.usedPercent, window.remainingPercent, window.resetsAt, window.resetsInSec].join(","))
                    .join(";"),
                )
                .join("|")}`
            : "loading";
        const rail = {
          digest,
          render: (w: number) => renderSidebarCard(report, activeTheme, w),
          invalidate() {},
        };
        if (state?.parts) state.parts.set(RAIL_KEY, rail);
        return {
          render: (w: number) => {
            // The rail is painting the card in its own column, so an above-editor box
            // would show the same numbers twice.
            if (state?.active && state?.ownsHost?.()) return [];
            if (!report) return [activeTheme.fg("dim", "quota …")];
            if (boxVisible) return renderBox(report, activeTheme, w);
            if (lineVisible) return [renderLine(report, activeTheme)];
            return [];
          },
          dispose: () => {
            if (state?.parts?.get(RAIL_KEY) === rail) state.parts.delete(RAIL_KEY);
          },
        };
      },
      { placement: "aboveEditor" },
    );
  }

  async function refresh(ctx: UiContext, force: boolean): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await runCli(force ? ["--json", "--force"] : ["--json"]);
      if (disposed) return;
      if (next) report = next;
      paintUi(ctx);
    } finally {
      refreshing = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const ui = ctx as unknown as UiContext;
    if (!ui.hasUI) return;
    disposed = false;
    // The rail decision must be made before the first paint, so a repaired slot is
    // used immediately instead of after one frame of the above-editor box.
    await syncRailPatch(ui);
    if (disposed) return;
    paintUi(ui);
    void refresh(ui, false);
    if (timer) clearInterval(timer);
    if (disposed) return;
    timer = setInterval(() => {
      if (!ui.hasUI || disposed) return;
      void refresh(ui, false);
    }, REFRESH_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const ui = ctx as unknown as UiContext;
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (ui.hasUI) {
      ui.ui.setStatus(STATUS_KEY, undefined);
      ui.ui.setWidget(WIDGET_KEY, undefined);
    }
  });

  const handler = async (args: string, ctx: UiContext): Promise<void> => {
    if (!ctx.hasUI) return;
    const action = args.trim().toLowerCase();

    switch (action) {
      case "refresh":
        await refresh(ctx, true);
        ctx.ui.notify(
          report
            ? `Quota refreshed (${report.providers.filter((provider) => provider.ok).length}/${report.providers.length} providers)`
            : `Quota refresh failed: ${lastError}`,
          report ? "info" : "error",
        );
        return;
      case "line":
      case "widget":
        lineVisible = true;
        boxVisible = false;
        panelVisible = false;
        if (!report) await refresh(ctx, false);
        paintUi(ctx);
        ctx.ui.notify("Quota line pinned above the editor", "info");
        return;
      case "panel":
        panelVisible = true;
        lineVisible = false;
        boxVisible = false;
        if (!report) await refresh(ctx, false);
        paintUi(ctx);
        ctx.ui.notify("Quota panel shown above the editor", "info");
        return;
      case "box":
        lineVisible = true;
        boxVisible = true;
        panelVisible = false;
        if (!report) await refresh(ctx, false);
        paintUi(ctx);
        ctx.ui.notify("Quota box pinned above the editor", "info");
        return;
      case "hide":
      case "off":
        panelVisible = false;
        lineVisible = false;
        boxVisible = false;
        paintUi(ctx);
        ctx.ui.notify("Quota line hidden", "info");
        return;
      case "status":
        statusVisible = true;
        paintUi(ctx);
        ctx.ui.notify("Also showing quota in the footer (may be truncated when the bar is full)", "info");
        return;
      case "nostatus":
        statusVisible = false;
        paintUi(ctx);
        return;
      case "json":
        ctx.ui.notify(`${resolveCliPath() ?? "piquota"} --json   (cached at ~/.cache/pi-quota/usage.json)`, "info");
        return;
      default:
        break;
    }

    // Bare /quota: refresh, show the panel, and report the used percentages.
    panelVisible = true;
    lineVisible = false;
    boxVisible = false;
    await refresh(ctx, true);
    paintUi(ctx);
    if (!report) {
      ctx.ui.notify(`Quota unavailable: ${lastError}`, "error");
      return;
    }
    const active = report.providers.filter((provider) => provider.notConfigured !== true);
    const summary = active
      .map((provider) => {
        const name = SHORT_NAME[provider.family] ?? provider.family;
        if (!provider.ok) return `${name}: ${errorCaption(provider.error)}`;
        const used = usedOf(headline(provider));
        return `${name}: ${used === null ? "n/a" : `${Math.round(used)}% used`}`;
      })
      .join(" · ");
    ctx.ui.notify(summary || "No active providers configured in Pi", "info");
  };

  pi.registerCommand("quota", {
    description: "Show read-only provider quota (used %, shortest window)",
    getArgumentCompletions: (prefix: string) => {
      const options = ["refresh", "line", "box", "panel", "hide", "status", "nostatus", "json"];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler,
  });

  pi.registerCommand("usage", {
    description: "Alias of /quota (read-only provider quota)",
    handler,
  });
}
