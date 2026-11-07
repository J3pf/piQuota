/**
 * OpenRouter quota from a Pi API key (`openrouter` in `auth.json` or `$OPENROUTER_API_KEY`).
 *
 * Endpoint: GET https://openrouter.ai/api/v1/key
 * Optional fallback: GET https://openrouter.ai/api/v1/credits (when no per-key limit is set
 * and the key has credit-read permissions).
 */

import { buildWindow, clampPercent, degradedResult, displayIdentity, finiteNumber, parseReset, stringValue } from "../model.js";
import { requestJson } from "../http.js";

const KEY_URL = "https://openrouter.ai/api/v1/key";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

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
 * Format a USD figure cleanly (e.g. "$4.25").
 *
 * @param {number} amount
 * @returns {string}
 */
function usd(amount) {
  return `$${amount.toFixed(2)}`;
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{ now?: number, fetchFn?: typeof fetch, timeoutMs?: number, expiresInMin?: number | null }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const base = {
    family: "openrouter",
    label: credential.label ?? "OpenRouter (Pi)",
    account: displayIdentity(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };

  const token = stringValue(credential.key ?? credential.access);
  if (!token) {
    return degradedResult({
      ...base,
      error: "Pi store has no openrouter API key; configure openrouter in Pi",
      now,
    });
  }

  const headers = { Authorization: `Bearer ${token}` };
  const keyResp = await requestJson(KEY_URL, {
    headers,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  if (!keyResp.ok) {
    const error = keyResp.authError
      ? "OpenRouter API key rejected; check your openrouter key in Pi"
      : `OpenRouter key request failed: ${keyResp.error}`;
    return degradedResult({ ...base, error, now });
  }

  const keyBody = record(keyResp.body) ?? {};
  const data = record(keyBody.data) ?? keyBody;
  const limit = finiteNumber(data.limit);
  const limitRemaining = finiteNumber(data.limit_remaining);
  const usage = finiteNumber(data.usage);
  const usageMonthly = finiteNumber(data.usage_monthly);
  const usageWeekly = finiteNumber(data.usage_weekly);
  const usageDaily = finiteNumber(data.usage_daily);
  const isFreeTier = data.is_free_tier === true;
  const keyLabel = stringValue(data.label);
  const limitReset = stringValue(data.limit_reset);

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];

  if (limit !== null && limit > 0) {
    const usedAmount = limitRemaining !== null ? Math.max(0, limit - limitRemaining) : (usage ?? 0);
    const usedPct = clampPercent((usedAmount / limit) * 100);
    const resets = limitReset ? parseReset(limitReset, now) : { resetsAt: null, resetsInSec: null };
    windows.push(
      buildWindow({
        id: "5h",
        label: "Key limit",
        usedPercent: usedPct,
        resetsAt: resets.resetsAt,
        note: `${usd(usedAmount)} / ${usd(limit)}`,
        now,
      }),
    );
  } else {
    // When no per-key limit is set, try reading account-level credits.
    const creditsResp = await requestJson(CREDITS_URL, {
      headers,
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
    });
    const creditsData = creditsResp.ok ? record(record(creditsResp.body)?.data) : null;
    const totalCredits = creditsData ? finiteNumber(creditsData.total_credits) : null;
    const totalUsage = creditsData ? finiteNumber(creditsData.total_usage) : null;

    if (totalCredits !== null && totalCredits > 0 && totalUsage !== null) {
      const usedPct = clampPercent((totalUsage / totalCredits) * 100);
      windows.push(
        buildWindow({
          id: "5h",
          label: "Credits",
          usedPercent: usedPct,
          note: `${usd(totalUsage)} / ${usd(totalCredits)}`,
          now,
        }),
      );
    } else if (usageMonthly !== null || usage !== null || usageDaily !== null) {
      const parts = [];
      if (usageDaily !== null) parts.push(`today ${usd(usageDaily)}`);
      if (usageWeekly !== null) parts.push(`7d ${usd(usageWeekly)}`);
      if (usageMonthly !== null) parts.push(`30d ${usd(usageMonthly)}`);
      else if (usage !== null) parts.push(`total ${usd(usage)}`);
      windows.push(
        buildWindow({
          id: "5h",
          label: "Spend (no cap)",
          usedPercent: 0,
          note: parts.join(" · ") || "unlimited key",
          now,
        }),
      );
    }
  }

  if (windows.length === 0) {
    return degradedResult({
      ...base,
      error: "OpenRouter response had no recognizable key limit or usage fields",
      now,
    });
  }

  return {
    ...base,
    account: keyLabel ?? base.account,
    plan: isFreeTier ? "free" : "paid",
    windows,
    error: null,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  };
}
