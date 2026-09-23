/**
 * Antigravity (Google AI Pro / Cloud Code) quota from a Pi OAuth access token.
 *
 * Endpoint: POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 * Body:     { "project": "<cloudaicompanionProject>" }
 *
 * The CLI `User-Agent` is mandatory: without it the Cloud Code backend answers
 * 403 "You do not have a valid license of this product" even for a healthy
 * token. Verbose but verified.
 *
 * Response shape: `groups[].buckets[]` with
 * `{ bucketId, displayName, window, resetTime, remainingFraction, description }`.
 *
 * Google does not rotate this refresh token, but Pi owns the credential and this
 * project is read-only, so no refresh is performed here either.
 */

import { buildWindow, clampPercent, degradedResult, displayIdentity, finiteNumber, stringValue, windowFromName } from "../model.js";
import { requestJson } from "../http.js";
import { describeOAuthClient, ensureFreshAccessToken } from "./antigravity-oauth.js";

const CLOUD_CODE_BASES = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
const CLI_USER_AGENT =
  "antigravity/cli/1.1.13 (aidev_client; os_type=linux; arch=amd64; cl=964361259; auth_method=consumer)";

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
 * Resolve a Cloud Code project id through loadCodeAssist.
 *
 * @param {string} access
 * @param {string} base
 * @param {typeof fetch | undefined} fetchFn
 * @param {number | undefined} timeoutMs
 * @returns {Promise<string | null>}
 */
async function resolveProjectId(access, base, fetchFn, timeoutMs) {
  const response = await requestJson(`${base}/v1internal:loadCodeAssist`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": CLI_USER_AGENT,
    },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
    fetchFn,
    timeoutMs,
  });
  if (!response.ok) return null;
  const body = record(response.body);
  const project = body?.cloudaicompanionProject;
  if (typeof project === "string" && project) return project;
  const projectRecord = record(project);
  return stringValue(projectRecord?.id) ?? stringValue(projectRecord?.name);
}

/**
 * Short group tag so multi-group accounts read as "Gemini · 5h window" and
 * "Claude/GPT · 5h window" instead of two identical rows.
 *
 * @param {string} groupName
 * @returns {string}
 */
function shortGroup(groupName) {
  const text = groupName.toLowerCase();
  if (text.includes("gemini")) return "Gemini";
  if (text.includes("claude") || text.includes("gpt")) return "Claude/GPT";
  return groupName.split(/\s+/)[0] || "Models";
}

/**
 * @param {Record<string, unknown>} bucket
 * @param {{ groupName: string, multiGroup: boolean }} context
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow | null}
 */
function windowFromBucket(bucket, context, now) {
  const remainingFraction = finiteNumber(bucket.remainingFraction ?? bucket.remaining_fraction);
  if (remainingFraction === null) return null;

  const windowName = stringValue(bucket.window) ?? stringValue(bucket.bucketId) ?? "";
  const mapped = windowFromName(windowName.replace(/^[a-z]+-/, ""));
  const displayName = stringValue(bucket.displayName);
  const description = stringValue(bucket.description);
  const tag = context.multiGroup ? `${shortGroup(context.groupName)} · ` : "";
  // Short, uniform vocabulary so Antigravity's windows read like the other
  // providers'; the API's own wording is preserved in the note.
  const kind = mapped.id === "5h" || mapped.id === "weekly" || mapped.id === "monthly" ? mapped.id : mapped.label;

  return buildWindow({
    id: context.multiGroup ? `${shortGroup(context.groupName).toLowerCase().replace(/[^a-z]+/g, "-")}-${mapped.id}` : mapped.id,
    label: `${tag}${kind}`,
    remainingPercent: clampPercent(remainingFraction * 100),
    resetsAt: stringValue(bucket.resetTime),
    note: [displayName, description].filter(Boolean).join(" — ") || null,
    now,
  });
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{ now?: number, fetchFn?: typeof fetch, timeoutMs?: number, expiresInMin?: number | null, env?: Record<string, string | undefined>, refresh?: boolean }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const base = {
    family: "antigravity",
    label: "Antigravity (Pi)",
    account: displayIdentity(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };

  if (!credential.access && !credential.refresh) {
    return degradedResult({ ...base, error: "Pi store has no antigravity credential; run /login antigravity in Pi" });
  }

  const fetchFn = options.fetchFn;
  const account = { access: credential.access, refresh: credential.refresh, expiresAtMs: credential.expiresAtMs ?? null };

  // In-memory refresh only: Google does not rotate this refresh token, so the
  // copy Pi stores stays valid and nothing is written back.
  const freshness = await ensureFreshAccessToken(account, {
    fetchFn,
    timeoutMs: options.timeoutMs,
    now,
    enabled: options.refresh,
  });
  let projectId = credential.projectId ?? null;

  /** @type {string | null} */
  let lastError = null;
  let authFailed = false;

  for (const cloudBase of CLOUD_CODE_BASES) {
    if (!projectId && account.access) {
      projectId = await resolveProjectId(account.access, cloudBase, fetchFn, options.timeoutMs);
    }
    if (!projectId) {
      lastError = "Antigravity credential has no Cloud Code project id and loadCodeAssist did not return one";
      continue;
    }
    if (!account.access) {
      lastError = freshness.error
        ? `Antigravity access token unusable: ${freshness.error}`
        : "Antigravity access token is missing from the Pi store";
      continue;
    }

    const response = await requestJson(`${cloudBase}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.access}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CLI_USER_AGENT,
      },
      body: JSON.stringify({ project: projectId }),
      fetchFn,
      timeoutMs: options.timeoutMs,
    });

    if (!response.ok) {
      authFailed = Boolean(response.authError);
      lastError = response.authError
        ? "Antigravity token rejected; run /login antigravity in Pi"
        : `Antigravity quota request failed: ${response.error}`;
      continue;
    }

    authFailed = false;

    const body = record(response.body) ?? {};
    const groups = (Array.isArray(body.groups) ? body.groups : [])
      .map((rawGroup) => record(rawGroup))
      .filter((group) => Array.isArray(group?.buckets) && group.buckets.length > 0);
    const multiGroup = groups.length > 1;

    /** @type {import("../model.js").QuotaWindow[]} */
    const windows = [];
    for (const group of groups) {
      if (!group) continue;
      const groupName = stringValue(group.displayName) ?? "Models";
      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      for (const rawBucket of buckets) {
        const bucket = record(rawBucket);
        if (!bucket) continue;
        const window = windowFromBucket(bucket, { groupName, multiGroup }, now);
        if (window) windows.push(window);
      }
    }

    if (windows.length === 0) {
      lastError = "Antigravity quota response contained no buckets (free tier may expose none for this account)";
      continue;
    }

    return {
      ...base,
      account: projectId ? `${displayIdentity(credential)} · ${projectId.slice(0, 8)}…` : displayIdentity(credential),
      plan: stringValue(body.paidTier) ?? stringValue(body.currentTier),
      windows,
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  }

  const suffix = authFailed ? ` (${describeOAuthClient({ env: options.env })})` : "";
  return degradedResult({ ...base, error: `${lastError ?? "Antigravity quota unavailable"}${suffix}` });
}
