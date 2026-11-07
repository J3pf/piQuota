/**
 * Claude (Anthropic) quota from a Pi OAuth access token.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Required: the OAuth beta header; a plain Bearer token is rejected without it.
 * Windows: `five_hour` and `seven_day`, each `{ utilization, resets_at }`.
 *
 * Two sources feed this provider, and the caller picks one:
 *
 *   - Pi's own `anthropic` entry in auth.json;
 *   - the Claude Code CLI store (`~/.claude/.credentials.json`), which the
 *     `pi-claude-code-provider` package drives. On a subscription whose usage
 *     credits are disabled, Pi's own entry can answer HTTP 400 for every request,
 *     and this is the source that still works.
 *
 * Either way no refresh is attempted. Anthropic rotates refresh tokens, so
 * refreshing here would invalidate the copy the owning tool has stored — and for
 * Claude Code that tool is the installed CLI, which keeps its own token fresh.
 */

import { degradedResult, buildWindow, clampPercent, displayIdentity, finiteNumber, parseReset, stringValue } from "../model.js";
import { requestJson } from "../http.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {Record<string, unknown>} window
 * @param {string} id
 * @param {string} label
 * @param {string | null} note
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow | null}
 */
function windowFromObject(window, id, label, note, now) {
  const used = clampPercent(window.utilization ?? window.percent ?? window.used_percent);
  if (used === null) return null;
  const resets = parseReset(window.resets_at, now);
  return buildWindow({
    id,
    label,
    usedPercent: used,
    resetsAt: resets.resetsAt,
    note,
    now,
  });
}

/**
 * Some accounts report windows only through the newer `limits[]` array.
 *
 * @param {unknown} limits
 * @param {string} id
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow | null}
 */
function windowFromLimits(limits, id, now, extraNote = null) {
  if (!Array.isArray(limits)) return null;
  for (const entry of limits) {
    const limit = record(entry);
    if (!limit || limit.is_active === false) continue;
    const kind = `${stringValue(limit.kind) ?? ""} ${stringValue(limit.group) ?? ""}`.toLowerCase();
    const matches =
      id === "5h"
        ? kind.includes("session") || kind.includes("five") || kind.includes("5h")
        : kind.includes("week") || kind.includes("7d");
    if (!matches) continue;
    const used = clampPercent(limit.percent);
    if (used === null) continue;
    const resets = parseReset(limit.resets_at, now);
    const severityNote = stringValue(limit.severity) ? `severity ${stringValue(limit.severity)}` : null;
    const note = [severityNote, extraNote].filter(Boolean).join(" · ") || null;
    return buildWindow({
      id,
      label: id === "5h" ? "5h window" : "Weekly window",
      usedPercent: used,
      resetsAt: resets.resetsAt,
      note,
      now,
    });
  }
  return null;
}

/**
 * Render the extra-usage (overage) figure using the provider's own decimal
 * scale, so 2908 credits with decimal_places=2 reads as "29.08 USD".
 *
 * @param {Record<string, unknown>} extra
 * @returns {string | null}
 */
function formatOverage(extra) {
  if (extra.is_enabled !== true) return null;
  const credits = finiteNumber(extra.used_credits);
  if (credits === null) return null;
  const rawDecimals = finiteNumber(extra.decimal_places);
  const decimals =
    rawDecimals !== null && Number.isInteger(rawDecimals) && rawDecimals >= 0 && rawDecimals <= 20
      ? rawDecimals
      : null;
  const amount = decimals === null ? credits : credits / Math.pow(10, decimals);
  const currency = stringValue(extra.currency);
  return `extra usage ${amount.toFixed(decimals ?? 0)}${currency ? ` ${currency}` : ""}`;
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{ now?: number, fetchFn?: typeof fetch, timeoutMs?: number, expiresInMin?: number | null }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const fromClaudeCode = credential.sourceKind === "claude-code";
  const base = {
    family: "claude",
    // The label stays stable across both stores; which store was read is
    // reported by `sourceKind` instead, where it is diagnostic.
    label: credential.label ?? "Claude (Pi)",
    account: displayIdentity(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };

  if (!credential.access) {
    return degradedResult({
      ...base,
      error: fromClaudeCode
        ? `Claude Code store has no access token; run \`claude\` once to sign in (${credential.source})`
        : "Pi store has no anthropic access token; run /login anthropic in Pi",
    });
  }

  const response = await requestJson(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${credential.access}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
    },
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  if (!response.ok) {
    const error = response.authError
      ? fromClaudeCode
        ? "Claude Code token expired or rejected; run `claude` once to refresh it"
        : "Claude token expired or rejected; use any Claude model in Pi to refresh it"
      : `Claude usage request failed: ${response.error}`;
    return degradedResult({ ...base, error });
  }

  const body = record(response.body) ?? {};
  const extra = record(body.extra_usage);
  const overageNote = extra ? formatOverage(extra) : null;

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  const fiveHour = record(body.five_hour);
  const sevenDay = record(body.seven_day);
  const fromFiveHour = fiveHour ? windowFromObject(fiveHour, "5h", "5h window", null, now) : null;
  const fromSevenDay = sevenDay ? windowFromObject(sevenDay, "weekly", "Weekly window", overageNote, now) : null;
  if (fromFiveHour) windows.push(fromFiveHour);
  if (fromSevenDay) windows.push(fromSevenDay);
  if (!fromFiveHour) {
    const fallback = windowFromLimits(body.limits, "5h", now);
    if (fallback) windows.push(fallback);
  }
  if (!fromSevenDay) {
    const fallback = windowFromLimits(body.limits, "weekly", now, overageNote);
    if (fallback) windows.push(fallback);
  }

  if (windows.length === 0) {
    return degradedResult({
      ...base,
      error: "Claude usage response had no recognizable rate-limit windows (API shape may have changed)",
    });
  }

  return {
    ...base,
    // Claude Code reports the subscription tier it signed in with; Pi's own entry
    // carries no plan field at all.
    plan: credential.planType ?? null,
    windows,
    error: null,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  };
}
