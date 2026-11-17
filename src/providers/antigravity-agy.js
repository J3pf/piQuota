/**
 * Antigravity quota from the `agy` CLI.
 *
 * `agy` has no `usage` subcommand, but the `/usage` slash command inside print
 * mode answers with the account's own quota report and burns zero tokens:
 *
 *   agy --print /usage --output-format json --print-timeout 30s
 *
 * The payload mirrors `v1internal:retrieveUserQuotaSummary` (the endpoint
 * `antigravity.js` uses for Pi's own credential), so both sources feed the same
 * window model: `command.data.groups[].buckets[]` with
 * `{ id, name, window, remaining_fraction, reset_time }`.
 *
 * The print-mode round trip takes seconds, so this provider is never on the
 * hot path: `collectQuota` falls back to it only when the Pi store has no
 * `antigravity` entry, and the report cache absorbs repeated polls.
 */

import { runCommand as defaultRunCommand } from "../exec.js";
import { degradedResult } from "../model.js";
import { windowFromBucket } from "./antigravity.js";

export const AGY_USAGE_ARGS = ["--print", "/usage", "--output-format", "json", "--print-timeout", "30s"];
/** agy's own print timeout is 30 s; the watchdog only needs to outlive it. */
export const AGY_TIMEOUT_MS = 45_000;

const AUTH_FAILURE = /not logged in|not signed in|unauthor|unauthoriz|forbidden|401|403|login|sign in|consent/i;

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
 * @param {Record<string, unknown>} source
 * @param {string[]} keys
 * @returns {string | null}
 */
function firstString(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/**
 * @param {Record<string, unknown>} source
 * @param {string[]} keys
 * @returns {number | null}
 */
function firstNumber(source, keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

/**
 * @typedef {Object} AgyBucket
 * @property {string | null} id
 * @property {string} name
 * @property {string} window
 * @property {number} remainingFraction
 * @property {string | null} resetTime
 * @property {string | null} description
 */

/**
 * @typedef {Object} AgyGroup
 * @property {string} name
 * @property {string | null} description
 * @property {AgyBucket[]} buckets
 */

/**
 * Parse the `/usage` JSON payload.
 *
 * Tolerant in the same places the CLI is loose (snake_case or camelCase
 * aliases, a stream-json result envelope, clamped fractions) and strict about
 * the shape that matters: a usage command result carrying quota groups.
 *
 * @param {string} text
 * @returns {{ groups: AgyGroup[] }}
 */
export function parseAgyUsage(text) {
  let payload;
  try {
    payload = record(JSON.parse(text));
  } catch {
    throw new Error("response was not JSON");
  }
  if (!payload) throw new Error("response was not a JSON object");

  // Print mode answers at the top level; if some future agy shells the command
  // through its stream instead, the wrapper is `{ event: "result", result }`.
  const inner = payload.event !== undefined ? record(payload.result) : payload;
  if (!inner) throw new Error("result envelope carried no result object");

  const status = (firstString(inner, ["status"]) ?? "").toUpperCase();
  if (status !== "" && status !== "SUCCESS" && status !== "OK") {
    throw new Error(`agy reported status ${status}`);
  }

  const command = record(inner.command);
  if (!command || command.name !== "usage") throw new Error("payload is not a /usage command result");
  const data = record(command.data) ?? record(inner.data);
  const rawGroups = data && Array.isArray(data.groups) ? data.groups : null;
  if (!rawGroups) throw new Error("no quota groups in payload");

  /** @type {AgyGroup[]} */
  const groups = [];
  for (const rawGroup of rawGroups) {
    const group = record(rawGroup);
    const name = group ? firstString(group, ["name", "displayName"]) : null;
    if (!group || !name) continue;
    /** @type {AgyBucket[]} */
    const buckets = [];
    for (const rawBucket of Array.isArray(group.buckets) ? group.buckets : []) {
      const bucket = record(rawBucket);
      if (!bucket) continue;
      const remaining = firstNumber(bucket, ["remaining_fraction", "remainingFraction", "remaining"]);
      const label = firstString(bucket, ["name", "displayName", "id"]);
      if (remaining === null || !label) continue;
      buckets.push({
        id: firstString(bucket, ["id", "bucketId"]),
        name: label,
        window: firstString(bucket, ["window"]) ?? "unknown",
        remainingFraction: Math.min(1, Math.max(0, remaining)),
        resetTime: firstString(bucket, ["reset_time", "resetTime"]),
        description: firstString(bucket, ["description"]),
      });
    }
    groups.push({ name, description: firstString(group, ["description"]), buckets });
  }

  if (!groups.some((group) => group.buckets.length > 0)) throw new Error("no quota groups in payload");
  return { groups };
}

/**
 * Map one parsed bucket onto the shared window model, honoring the same
 * multi-group labelling as the HTTP provider.
 *
 * @param {AgyGroup[]} groups
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow[]}
 */
function windowsFromGroups(groups, now) {
  const multiGroup = groups.length > 1;
  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  for (const group of groups) {
    for (const bucket of group.buckets) {
      const window = windowFromBucket(
        {
          bucketId: bucket.id,
          displayName: bucket.name,
          description: bucket.description,
          window: bucket.window,
          remainingFraction: bucket.remainingFraction,
          resetTime: bucket.resetTime,
        },
        { groupName: group.name, multiGroup },
        now,
      );
      if (window) windows.push(window);
    }
  }
  return windows;
}

/**
 * @param {string} stderr
 * @returns {string}
 */
function firstLine(stderr) {
  return (stderr.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim().slice(0, 200);
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{ now?: number, runCommand?: typeof import("../exec.js").runCommand, env?: Record<string, string | undefined> }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const binary = credential.source || "agy";
  const base = {
    family: "antigravity",
    label: "Antigravity (agy CLI)",
    account: "agy CLI",
    source: binary,
    sourceKind: "agy-cli",
    expiresInMin: null,
  };
  const run = options.runCommand ?? defaultRunCommand;

  let outcome;
  try {
    outcome = run(binary, AGY_USAGE_ARGS, { timeoutMs: AGY_TIMEOUT_MS });
  } catch (error) {
    return degradedResult({ ...base, error: `agy CLI could not be started: ${error instanceof Error ? error.message : String(error)}`, now });
  }

  if (outcome.error) {
    return degradedResult({
      ...base,
      error: /ENOENT|not found/i.test(outcome.error)
        ? `agy CLI was not found at ${binary}; install the Antigravity CLI or set PI_QUOTA_AGY_BIN`
        : `agy CLI failed: ${outcome.error}`,
      now,
    });
  }
  if (outcome.status !== 0) {
    const detail = firstLine(outcome.stderr);
    return degradedResult({
      ...base,
      error: AUTH_FAILURE.test(`${outcome.stderr} ${outcome.stdout}`)
        ? `agy is not signed in${detail ? ` (${detail})` : ""}; run \`agy\` once in a terminal to authenticate`
        : `agy --print /usage exited with status ${outcome.status}${detail ? `: ${detail}` : ""}`,
      now,
    });
  }
  if (outcome.stdout.trim() === "") {
    return degradedResult({ ...base, error: "agy --print /usage returned no output", now });
  }

  /** @type {{ groups: AgyGroup[] }} */
  let report;
  try {
    report = parseAgyUsage(outcome.stdout);
  } catch (error) {
    return degradedResult({
      ...base,
      error: `agy --print /usage returned unparsable quota data: ${error instanceof Error ? error.message : String(error)}`,
      now,
    });
  }

  const windows = windowsFromGroups(report.groups, now);
  if (windows.length === 0) {
    return degradedResult({ ...base, error: "agy reported no quota buckets for this account", now });
  }

  return {
    ...base,
    plan: null,
    windows,
    error: null,
    ok: true,
    updatedAt: new Date(now).toISOString(),
  };
}
