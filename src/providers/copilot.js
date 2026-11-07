/**
 * GitHub Copilot quota from Pi's `github-copilot` OAuth store entry.
 *
 * Endpoint: GET https://api.github.com/copilot_internal/user
 * Note: Pi stores the long-lived GitHub OAuth token (`ghu_...` / `gho_...`) in
 * `credential.refresh` and the short-lived Copilot completion token in
 * `credential.access`. The internal user endpoint expects the GitHub OAuth token
 * (`Authorization: token <gh_token>`). This read-only GET never rotates or mutates
 * any token.
 */

import { buildWindow, clampPercent, degradedResult, displayIdentity, finiteNumber, parseReset, stringValue } from "../model.js";
import { requestJson } from "../http.js";

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const THIRTY_DAYS_SEC = 30 * 86_400;

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
 * @param {Record<string, unknown>} snapshot
 * @param {string} id
 * @param {string} label
 * @param {string | null} resetIso
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow | null}
 */
function windowFromSnapshot(snapshot, id, label, resetIso, now) {
  if (snapshot.unlimited === true) {
    return buildWindow({
      id,
      label,
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: resetIso,
      windowSeconds: THIRTY_DAYS_SEC,
      note: "unlimited",
      now,
    });
  }
  const entitlement = finiteNumber(snapshot.entitlement);
  const remaining = finiteNumber(snapshot.remaining);
  let remainingPct = clampPercent(snapshot.percent_remaining);
  if (remainingPct === null && entitlement !== null && entitlement > 0 && remaining !== null) {
    remainingPct = clampPercent((remaining / entitlement) * 100);
  }
  if (remainingPct === null) return null;

  const usedPct = clampPercent(100 - remainingPct);
  let note = null;
  if (entitlement !== null && remaining !== null) {
    const usedCount = Math.max(0, entitlement - remaining);
    note = `${usedCount}/${entitlement} requests`;
  }
  return buildWindow({
    id,
    label,
    usedPercent: usedPct,
    remainingPercent: remainingPct,
    resetsAt: resetIso,
    windowSeconds: THIRTY_DAYS_SEC,
    note,
    now,
  });
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{ now?: number, fetchFn?: typeof fetch, timeoutMs?: number, expiresInMin?: number | null }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const base = {
    family: "copilot",
    label: credential.label ?? "GitHub Copilot (Pi)",
    account: displayIdentity(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    // When `credential.refresh` holds the long-lived GitHub OAuth token, the 30m
    // completion token expiry in `expiresInMin` does not affect quota reads.
    expiresInMin: credential.refresh ? null : (options.expiresInMin ?? null),
  };

  const ghToken = stringValue(credential.refresh ?? credential.access ?? credential.key);
  if (!ghToken) {
    return degradedResult({
      ...base,
      error: "Pi store has no github-copilot token; run /login github-copilot in Pi",
      now,
    });
  }

  const response = await requestJson(COPILOT_USER_URL, {
    headers: {
      Authorization: `token ${ghToken}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.96.0",
      "User-Agent": "GitHubCopilotChat/0.24.0",
    },
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  if (!response.ok) {
    const error = response.authError
      ? "GitHub Copilot token expired or rejected; run /login github-copilot in Pi"
      : `GitHub Copilot usage request failed: ${response.error}`;
    return degradedResult({ ...base, error, now });
  }

  const body = record(response.body) ?? {};
  const plan = stringValue(body.copilot_plan) ?? stringValue(body.sku) ?? credential.planType ?? null;
  const resetRaw = body.quota_reset_date ?? body.quota_reset_date_utc ?? null;
  const resets = parseReset(resetRaw, now);
  const snapshots = record(body.quota_snapshots) ?? {};

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  const premium = record(snapshots.premium_interactions);
  if (premium) {
    const win = windowFromSnapshot(premium, "monthly", "Premium requests", resets.resetsAt, now);
    if (win) windows.push(win);
  }
  const chat = record(snapshots.chat);
  if (chat && (windows.length === 0 || chat.unlimited !== true)) {
    const win = windowFromSnapshot(chat, "chat", "Chat", resets.resetsAt, now);
    if (win) windows.push(win);
  }

  if (windows.length === 0) {
    return degradedResult({
      ...base,
      error: "GitHub Copilot response had no recognizable quota_snapshots",
      now,
    });
  }

  return {
    ...base,
    plan,
    windows,
    error: null,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  };
}
