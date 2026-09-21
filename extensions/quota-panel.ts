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
import { join } from "node:path";

import { errorCaption, errorKind, errorGlyph, isRecoverableError } from "../src/providers/error-kind.js";
import { mergeLastGood } from "../src/moshi/sticky.js";

const STATUS_KEY = "00-quota";
const WIDGET_KEY = "quota-line";
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
    setWidget: (key: string, value: string[] | undefined, options?: { placement?: string }) => void;
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

function humanDuration(seconds: number): string {
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * The one-row line: brand-coloured name plus a semaphore and the used percent.
 *
 *   Claude:○ 0%   Codex:○ 8%   Agy:○ 4%   OP-Go:○ 3%
 */
function renderLine(report: QuotaReport, theme: Theme): string {
  // Only display providers that are configured in Pi.
  // A provider that is simply not configured does not belong in the editor line.
  const active = report.providers.filter((provider) => provider.notConfigured !== true);
  if (active.length === 0) return theme.fg("dim", "quota: no providers configured in Pi");

  const tokens = active.map((provider) => {
    const name = paint(BRAND[provider.family] ?? "#8B949E", `${SHORT_NAME[provider.family] ?? provider.family}:`);
    if (!provider.ok) {
      const kind = errorKind(provider.error);
      const glyph = errorGlyph(provider.error);
      const color = kind === "transient" || kind === "throttle" ? "warning" : kind === "expired" || kind === "auth" ? "error" : "dim";
      return `${name}${theme.fg(color, glyph)}`;
    }

    const used = usedOf(headline(provider));
    if (used === null) return `${name}${theme.fg("dim", "?")}`;

    const band = bandFor(used);
    return `${name}${paint(band.color, band.glyph)} ${paint(band.color, `${Math.round(used)}%`)}`;
  });
  return tokens.join("  ");
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
  /** The line is the default surface: its own row, nothing competes for it. */
  let lineVisible = true;
  /** gentle-pi owns the footer and truncates it from the end, so start off. */
  let statusVisible = false;
  let lastError: string | null = null;
  let disposed = false;

  async function runCli(args: string[]): Promise<QuotaReport | null> {
    const cli = resolveCliPath();
    if (!cli) {
      lastError = "piquota not installed: run install.sh from the pi-quota repo";
      return null;
    }
    try {
      const result = await pi.exec(process.execPath, [cli, ...args], { timeout: EXEC_TIMEOUT_MS });
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

    // Before the first refresh there is no data and no error: say "loading", not
    // "unavailable". A false error flashing on every session start looks broken.
    const pending = lastError
      ? theme.fg("warning", lastError)
      : theme.fg("dim", "quota …");
    const fallback = [pending];
    if (panelVisible && report) {
      ctx.ui.setWidget(WIDGET_KEY, renderPanel(report, theme), { placement: "aboveEditor" });
    } else if (lineVisible && report) {
      ctx.ui.setWidget(WIDGET_KEY, [renderLine(report, theme)], { placement: "aboveEditor" });
    } else if (panelVisible || lineVisible) {
      ctx.ui.setWidget(WIDGET_KEY, fallback, { placement: "aboveEditor" });
    } else {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
  }

  async function refresh(ctx: UiContext, force: boolean): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      const next = await runCli(force ? ["--json", "--force"] : ["--json"]);
      if (disposed) return;
      if (next) report = mergeLastGood(next).report;
      paintUi(ctx);
    } finally {
      refreshing = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const ui = ctx as unknown as UiContext;
    if (!ui.hasUI) return;
    disposed = false;
    paintUi(ui);
    void refresh(ui, false);
    if (timer) clearInterval(timer);
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
        panelVisible = false;
        if (!report) await refresh(ctx, false);
        paintUi(ctx);
        ctx.ui.notify("Quota line pinned above the editor", "info");
        return;
      case "panel":
      case "box":
        panelVisible = true;
        lineVisible = false;
        if (!report) await refresh(ctx, false);
        paintUi(ctx);
        ctx.ui.notify("Quota panel shown above the editor", "info");
        return;
      case "hide":
      case "off":
        panelVisible = false;
        lineVisible = false;
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
      const options = ["refresh", "line", "panel", "hide", "status", "nostatus", "json"];
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
