/**
 * Moshi usage publisher.
 *
 * Sends the already-normalized Pi quota to the user's own paired host channel:
 *
 *   POST {base}/hosts/{hostId}/usage
 *   Authorization: Bearer secret_<host-secret>
 *   {"snapshots":[{accountId,accountLabel,agent,hostName,capturedAt,
 *                  windows:[{label,usedPercentage,resetsAt}]}]}
 *
 * The wire shape and the endpoint were recovered from moshi-hook itself (the
 * application is closed source), so they are treated as an observed contract:
 * the caller can always fall back to the local artifact.
 *
 * Guarantees:
 *   - only percentages, window labels, reset timestamps and plan labels travel;
 *     no token, cookie, session key or e-mail address;
 *   - the host secret is read from moshi-hook's own store and never logged;
 *   - nothing is sent when moshi-hook's `usage_collection` is off.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { requestJson } from "../http.js";

export const DEFAULT_BASE_URL = "https://api.getmoshi.app/api/v1";

/** Moshi agent id used for the cards produced here. */
export const PI_AGENT = "pi";

/** Agent ids Moshi already knows, used when the caller prefers native logos. */
const NATIVE_AGENT = {
  claude: "claude-code",
  codex: "codex",
  antigravity: "antigravity",
  "opencode-go": "opencode",
};

/** Labels are kept explicit because Moshi's agent union has no GitHub Actions id. */
const FAMILY_LABEL = {
  "github-actions": "GitHub Actions",
};

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, stateDir?: string }} [options]
 * @returns {{ stateDir: string, secretsPath: string }}
 */
export function moshiPaths(options = {}) {
  const env = options.env ?? process.env;
  const stateDir =
    options.stateDir ??
    join(env.XDG_STATE_HOME || join(options.home ?? homedir(), ".local", "state"), "moshi");
  return { stateDir, secretsPath: join(stateDir, "secrets.json") };
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, stateDir?: string, secretsPath?: string }} [options]
 * @returns {{ ok: true, hostId: string, hostSecret: string, hostName: string } | { ok: false, error: string }}
 */
export function readHostCredentials(options = {}) {
  const path = options.secretsPath ?? moshiPaths(options).secretsPath;
  if (!existsSync(path)) {
    return { ok: false, error: `moshi-hook is not paired: ${path} not found` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { ok: false, error: `cannot parse ${path}` };
  }
  const hostId = typeof parsed?.["host-id"] === "string" ? parsed["host-id"] : null;
  const hostSecret = typeof parsed?.["host-secret"] === "string" ? parsed["host-secret"] : null;
  if (!hostId || !hostSecret) {
    return { ok: false, error: `${path} has no host-id/host-secret; run \`moshi-hook pair\`` };
  }
  const name = typeof parsed?.["host-display-name"] === "string" ? parsed["host-display-name"] : hostname();
  return { ok: true, hostId, hostSecret, hostName: name };
}

/**
 * Translate an internal window into Moshi's own vocabulary.
 *
 * moshi-hook's own snapshots use short labels (`"5h"`, `"7d"`, `"weekly"`), so the
 * app recognizes them. Human-facing surfaces keep their longer labels; only the
 * payload is translated, because the app's card summary picks a window by label.
 *
 * @param {import("../model.js").QuotaWindow} window
 * @returns {string}
 */
export function moshiWindowLabel(window) {
  if (window.id === "5h" || window.id === "daily" || window.id === "weekly" || window.id === "monthly") {
    return window.id;
  }
  const match = window.id.match(/^(.+)-(5h|daily|weekly|monthly)$/);
  if (match) {
    const group = match[1]
      .split("-")
      .map((part) => (part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("/");
    return `${group} · ${match[2]}`;
  }
  return window.label;
}

/**
 * Timestamps on this wire use second precision (`2026-09-18T09:59:59Z`).
 *
 * @param {string | null | undefined} iso
 * @returns {string | null}
 */
export function secondPrecision(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build the request body for `POST /hosts/<id>/usage`.
 *
 * The server validates `agent` against a closed union of six values
 * (`claude-code`, `codex`, `opencode`, `kimi`, `grok`, `antigravity`), so a
 * custom "pi" agent cannot be registered from the client. The Pi provenance is
 * carried by `accountLabel` ("Codex (Pi)") and the card keeps Moshi's own logo.
 *
 * @param {import("../engine.js").PiQuotaReport} report
 * @param {{ agentMode?: "native" | "pi", hostName?: string }} [options]
 * @returns {{ snapshots: Array<Record<string, unknown>> }}
 */
export function buildUsagePayload(report, options = {}) {
  const agentMode = options.agentMode ?? "native";
  const seen = new Map();

  const snapshots = [];
  for (const provider of report.providers) {
    if (!provider.ok) continue;
    const windows = provider.windows
      .filter((window) => window.usedPercent !== null)
      .map((window) => {
        const entry = { label: moshiWindowLabel(window), usedPercentage: Math.round(/** @type {number} */ (window.usedPercent) * 100) / 100 };
        const resetsAt = secondPrecision(window.resetsAt);
        if (resetsAt) entry.resetsAt = resetsAt;
        return entry;
      });
    if (windows.length === 0) continue;

    const count = (seen.get(provider.family) ?? 0) + 1;
    seen.set(provider.family, count);
    snapshots.push({
      accountId: count === 1 ? `pi:${provider.family}` : `pi:${provider.family}:${count}`,
      accountLabel: FAMILY_LABEL[provider.family] ?? provider.label,
      agent: agentMode === "native" ? NATIVE_AGENT[provider.family] ?? PI_AGENT : PI_AGENT,
      hostName: options.hostName ?? hostname(),
      capturedAt: secondPrecision(report.generatedAt),
      windows,
    });
  }

  return { snapshots };
}

/**
 * @param {{ snapshots: Array<Record<string, unknown>> }} payload
 * @param {{
 *   baseUrl?: string,
 *   hostId?: string,
 *   hostSecret?: string,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   stateDir?: string,
 * }} [options]
 * @returns {Promise<{ ok: boolean, status: number, pushed: number, error?: string }>}
 */
export async function pushUsage(payload, options = {}) {
  if (payload.snapshots.length === 0) {
    return { ok: true, status: 0, pushed: 0 };
  }

  let hostId = options.hostId;
  let hostSecret = options.hostSecret;
  if (!hostId || !hostSecret) {
    const credentials = readHostCredentials(options);
    if (!credentials.ok) return { ok: false, status: 0, pushed: 0, error: credentials.error };
    hostId = credentials.hostId;
    hostSecret = credentials.hostSecret;
  }

  const baseUrl = (options.baseUrl ?? options.env?.MOSHI_API_BASE ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/hosts/${encodeURIComponent(hostId)}/usage`;

  const response = await requestJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${hostSecret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      pushed: 0,
      error: response.authError
        ? `Moshi rejected the host secret (HTTP ${response.status}); re-run \`moshi-hook pair\``
        : `usage upload failed: ${response.error}`,
    };
  }
  return { ok: true, status: response.status, pushed: payload.snapshots.length };
}

/**
 * Read the base URL moshi-hook itself is paired against, when discoverable.
 *
 * @param {{ configPath?: string, home?: string }} [options]
 * @returns {string | null}
 */
export function discoverBaseUrl(options = {}) {
  const path = options.configPath ?? join(options.home ?? homedir(), ".local", "state", "moshi", "host-pairings.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.pairings ?? [];
    const first = list.find((entry) => typeof entry?.baseUrl === "string" || typeof entry?.base_url === "string");
    return first?.baseUrl ?? first?.base_url ?? null;
  } catch {
    return null;
  }
}
