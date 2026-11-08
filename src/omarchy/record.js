/**
 * Map piQuota's normalized report onto Omarchy's agent usage records.
 *
 * Omarchy's "Agents" bar panel draws whatever `*.json` record it finds in its
 * usage directory. This module is pure: it turns a `PiQuotaReport` into the
 * minimal valid record per provider and never touches the disk, the network or
 * credentials. Only plan names, window labels, percentages and reset times can
 * reach a record; accounts and e-mail addresses are never copied, and every free
 * text field goes through `redact()` first.
 *
 * Record contract (see Omarchy's plugins/agents/Main.qml):
 *   id, name, ready, updatedAt, schemaVersion, tierLabel, usageStatusText,
 *   authHelpText and `limits[{label, title, percent, resetsAt}]`. The local
 *   token statistics are optional and are deliberately left out; the panel
 *   treats their absence as "no local stats".
 *
 * `percent` is a FRACTION in 0..1 (the panel multiplies it by 100), so 40.3% used
 * is written as 0.403.
 */

import { redact } from "../http.js";
import { errorKind } from "../providers/error-kind.js";

export const RECORD_PREFIX = "pi-";
export const SCHEMA_VERSION = 1;

/**
 * Pi's own provider name per family, for the "sign in again" hint.
 */
const LOGIN_HINT = {
  claude: "Run `claude` once, or `/login anthropic` in Pi, to restore usage.",
  codex: "Run `/login openai-codex` in Pi (or `codex` CLI) to restore usage.",
  antigravity: "Run `/login antigravity` in Pi to restore usage.",
  "opencode-go": "Reconnect OpenCode in Pi (`/login opencode-go`) or run `piquota auth opencode`.",
  copilot: "Run `/login github-copilot` in Pi to restore usage.",
  openrouter: "Update your OpenRouter API key in Pi (`/login openrouter`).",
};

const HELP_MAX = 200;

/**
 * The panel hides a provider that has no limits and no local stats. An error
 * record has neither, so it carries one placeholder window with a negative
 * percent: the panel's own filter (`percent >= 0`) never draws it, but its
 * presence keeps the provider's tab, and the status card, on screen.
 */
const PLACEHOLDER_LIMIT = Object.freeze({ label: "Unavailable", title: "Unavailable", percent: -1, resetsAt: "" });

/**
 * @param {string} family
 * @returns {string}
 */
export function recordId(family) {
  return `${RECORD_PREFIX}${family}`;
}

/**
 * @param {string | null | undefined} id
 * @returns {boolean}
 */
export function isPiRecordId(id) {
  return typeof id === "string" && /^pi-[a-z0-9][a-z0-9-]*$/.test(id);
}

/**
 * @param {import("../model.js").QuotaWindow} window
 * @param {import("../model.js").QuotaResult} [provider]
 * @returns {string}
 */
function windowTitle(window, provider) {
  if (provider?.family === "github-actions") {
    const match = typeof window.note === "string"
      ? window.note.match(/(\d+(?:\.\d+)?)\s+of\s+(\d+(?:\.\d+)?)\s+min/i)
      : null;
    const minutesLabel = match ? `${match[1]} / ${match[2]} min` : null;

    let org = "";
    if (window.label && window.label !== "Monthly window" && window.label !== "monthly") {
      org = window.label.replace(/\s+(?:monthly.*|\(monthly.*\))$/i, "").trim();
    }
    if (!org && provider.account) {
      org = provider.account;
    }

    if (minutesLabel) {
      return org ? `${org} (${minutesLabel})` : `Monthly (${minutesLabel})`;
    }
    if (org && org !== "GitHub Actions") {
      return org;
    }
    return "Monthly";
  }

  switch (window.id) {
    case "5h":
      return "Session";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    default:
      return window.label || window.id || "Limit";
  }
}

/**
 * @param {import("../model.js").QuotaWindow[]} windows
 * @param {import("../model.js").QuotaResult} [provider]
 * @returns {Array<{ label: string, title: string, percent: number, resetsAt: string }>}
 */
function mapLimits(windows, provider) {
  const limits = [];
  for (const window of windows ?? []) {
    // A window without a percentage would otherwise read as "0% used".
    if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    limits.push({
      label: redact(window.label || window.id || "Limit"),
      title: redact(windowTitle(window, provider)),
      percent: Math.min(1, Math.max(0, window.usedPercent / 100)),
      resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : "",
    });
  }
  return limits;
}

/**
 * @param {string} family
 * @param {string | null | undefined} error
 * @returns {{ usageStatusText: string, authHelpText: string }}
 */
export function describeError(family, error) {
  const kind = errorKind(error);
  const login = LOGIN_HINT[family] ?? "Sign in again to restore usage.";
  switch (kind) {
    case "expired":
      return { usageStatusText: "Sign-in expired", authHelpText: login };
    case "auth":
      return { usageStatusText: "Credential rejected", authHelpText: login };
    case "throttle":
      return { usageStatusText: "Rate limited", authHelpText: "The provider throttled the usage endpoint; piQuota retries on its next run." };
    case "transient":
      return { usageStatusText: "Temporarily unavailable", authHelpText: "The provider did not answer; piQuota retries on its next run." };
    case "missing":
      return { usageStatusText: "Not configured", authHelpText: login };
    default:
      return { usageStatusText: "Quota unavailable", authHelpText: redact(error ?? "no data").slice(0, HELP_MAX) };
  }
}

const SHORT_NAMES = {
  "github-actions": "GH Actions",
  antigravity: "Agy",
  "opencode-go": "OP-Go",
  copilot: "Copilot",
  openrouter: "OpenRouter",
};

/**
 * @param {import("../model.js").QuotaResult} provider
 * @param {{ nativeFamilies?: Set<string> }} [options]
 * @returns {string}
 */
function recordName(provider, options = {}) {
  if (SHORT_NAMES[provider.family]) {
    return SHORT_NAMES[provider.family];
  }
  const base = redact(String(provider.label || provider.family).replace(/\s*\(Pi\)\s*$/i, ""));
  if (options.nativeFamilies?.has?.(provider.family)) {
    return `${base} (Pi)`;
  }
  return base;
}

/**
 * Extract an Omarchy prepaid `balance` ledger (`{ remaining, funded, spent, currency }`)
 * when a provider reports USD credit usage in its window notes (e.g. OpenRouter `"$4.25 / $20.00"`).
 *
 * @param {import("../model.js").QuotaResult} provider
 * @returns {{ remaining: number, funded: number, spent: number, currency: string } | undefined}
 */
function extractBalance(provider) {
  if (provider?.family !== "openrouter" || !provider.ok) return undefined;
  for (const window of provider.windows ?? []) {
    if (typeof window?.note !== "string") continue;
    const match = window.note.match(/^\$(\d+(?:\.\d+)?)\s*\/\s*\$(\d+(?:\.\d+)?)$/);
    if (!match) continue;
    const spent = Number(match[1]);
    const funded = Number(match[2]);
    if (!Number.isFinite(spent) || !Number.isFinite(funded) || funded <= 0) continue;
    const remaining = Math.max(0, Number((funded - spent).toFixed(2)));
    return {
      remaining,
      funded,
      spent,
      currency: "USD",
    };
  }
  return undefined;
}

/**
 * @param {import("../model.js").QuotaResult} provider
 * @returns {string}
 */
function recordTierLabel(provider) {
  if (provider.family === "github-actions") {
    const account = provider.account ? redact(provider.account) : "";
    const plan = provider.plan ? redact(provider.plan) : "";
    if (account && plan) return `${account} · ${plan}`;
    return account || plan || "";
  }
  return provider.plan ? redact(provider.plan) : "";
}

/**
 * Build the record for one provider, or `null` when the provider is simply not
 * configured: a tab that only says "not configured" is noise, so it is omitted
 * (and any record from an earlier run is removed by the publisher).
 *
 * @param {import("../model.js").QuotaResult} provider
 * @param {{ now?: number, nativeFamilies?: Set<string> }} [options]
 * @returns {{ id: string, record: Record<string, unknown> } | null}
 */
export function buildRecord(provider, options = {}) {
  const now = options.now ?? Date.now();
  const limits = mapLimits(provider.windows, provider);
  const failed = !provider.ok || limits.length === 0;

  if (failed && errorKind(provider.error) === "missing") return null;

  const status = failed
    ? describeError(provider.family, provider.error ?? "no usage windows")
    : { usageStatusText: "", authHelpText: "" };

  const id = recordId(provider.family);
  const balance = extractBalance(provider);
  /** @type {Record<string, unknown>} */
  const record = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: recordName(provider, options),
    ready: !failed,
    tierLabel: recordTierLabel(provider),
    limits: failed && limits.length === 0 ? [{ ...PLACEHOLDER_LIMIT }] : limits,
    usageStatusText: status.usageStatusText,
    authHelpText: status.authHelpText,
    hasLocalStats: false,
    hasPromptStats: false,
    updatedAt:
      typeof provider.updatedAt === "string" && provider.updatedAt
        ? provider.updatedAt
        : new Date(now).toISOString(),
  };
  if (balance) {
    record.balance = balance;
  }
  return {
    id,
    record,
  };
}

/**
 * One record per family (the first result wins, matching the other renderers).
 * Never throws: a malformed provider entry is skipped.
 *
 * @param {import("../engine.js").PiQuotaReport} report
 * @param {{ now?: number, nativeFamilies?: Set<string> }} [options]
 * @returns {Array<{ id: string, record: Record<string, unknown> }>}
 */
export function buildRecords(report, options = {}) {
  const seen = new Set();
  const records = [];
  for (const provider of report?.providers ?? []) {
    if (!provider || typeof provider.family !== "string" || seen.has(provider.family)) continue;
    seen.add(provider.family);
    try {
      const built = buildRecord(provider, options);
      if (built) records.push(built);
    } catch {
      // A broken entry must not take the other providers' records down with it.
    }
  }
  return records;
}
