
/**
 * Rebuild the provider list in the report's own order, falling back to the
 * byFamily grouping when a caller passed an inconsistent report (empty
 * `providers`). A silent empty publish would mean zero cards, so the fallback
 * matters more than the tidy ordering.
 *
 * @param {import("../engine.js").PiQuotaReport} report
 * @param {Map<string, import("../model.js").QuotaResult>} replacements
 * @param {Record<string, import("../model.js").QuotaResult[]>} byFamily
 * @returns {import("../model.js").QuotaResult[]}
 */
function orderedProviders(report, replacements, byFamily) {
  if (report.providers.length === 0) {
    return Object.values(byFamily).flat();
  }
  return report.providers.map((provider) => replacements.get(provider.family) ?? provider);
}

/**
 * Keep the last good snapshot when a refresh fails transiently.
 *
 * The Usages screen should not lose a card because one provider happened to
 * answer 429 while the daemon was polling. This merges a fresh report over the
 * previous one: a family that is still healthy wins, and a family that failed
 * for a *transient* reason keeps its previous windows instead of degrading.
 *
 * Permanent failures (expired sign-in, missing credential, rejected session)
 * are passed through, because hiding them would be misleading.
 */

/**
 * Failures that are expected to clear on their own.
 *
 * `backing off` matters: that is the message this project's own backoff layer
 * emits, and leaving it out made the "keep the last good values" path decline to
 * act exactly while a provider was throttled — the one case it exists for.
 */
const TRANSIENT =
  /HTTP 5\d\d|429|rate limited|throttle|backing off|timed out|timeout|ECONNRESET|socket|network|fetch failed/i;

/**
 * @param {string | null} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  if (!error) return false;
  if (isAuthFailure(error)) return false;
  return TRANSIENT.test(error);
}

/**
 * @param {import("../engine.js").PiQuotaReport | null} previous
 * @param {import("../engine.js").PiQuotaReport} next
 * @param {{ now?: number, maxAgeMs?: number }} [options]
 * @returns {{ report: import("../engine.js").PiQuotaReport, reused: string[] }}
 */
export function mergeSticky(previous, next, options = {}) {
  if (!previous) return { report: next, reused: [] };
  const nextTime = next.generatedAt ? Date.parse(next.generatedAt) : NaN;
  const now = options.now ?? (!Number.isNaN(nextTime) ? nextTime : Date.now());
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_STICKY_AGE_MS;

  /** @type {string[]} */
  const reused = [];
  /** @type {Record<string, import("../model.js").QuotaResult[]>} */
  const byFamily = {};
  /** @type {Map<string, import("../model.js").QuotaResult>} */
  const replacements = new Map();

  for (const [family, results] of Object.entries(next.byFamily)) {
    const fresh = results[0];
    const prior = previous.byFamily[family]?.[0];
    const priorTimestamp = prior?.updatedAt ? Date.parse(prior.updatedAt) : NaN;
    const isPriorFresh = Number.isNaN(priorTimestamp) || now - priorTimestamp <= maxAgeMs;
    const hasExpiredToken = fresh?.expiresInMin !== null && fresh?.expiresInMin !== undefined && fresh.expiresInMin <= 0;
    const keepPrior =
      fresh &&
      prior &&
      !fresh.ok &&
      prior.ok &&
      prior.windows.length > 0 &&
      !hasExpiredToken &&
      !isAuthFailure(fresh.error) &&
      isPriorFresh &&
      isTransientError(fresh.error);

    if (!keepPrior) {
      byFamily[family] = results;
      continue;
    }

    reused.push(family);
    const carried = {
      ...prior,
      // Keep the stale data but say how fresh it really is.
      account: prior.account,
      updatedAt: prior.updatedAt,
    };
    byFamily[family] = [carried];
    replacements.set(family, carried);
  }

  // Rebuild in the report's own order so the rings never jump position between
  // refreshes; the map is only a lookup.
  const providers = orderedProviders(next, replacements, byFamily);

  return {
    report: {
      ...next,
      providers,
      byFamily,
      warnings: reused.length > 0
        ? [...next.warnings, `reused the previous snapshot for: ${reused.join(", ")} (transient upstream error)`]
        : next.warnings,
    },
    reused,
  };
}

/**
 * Persist the last published report so the sticky behaviour survives a process
 * restart. Without this, a `systemctl restart` (or a one-shot push) has no
 * "previous" to fall back on and a single 429 would drop a card.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isAuthFailure } from "../providers/backoff.js";

/** Maximum age for a sticky / last-good snapshot before it is considered stale (4 hours). */
export const DEFAULT_MAX_STICKY_AGE_MS = 4 * 60 * 60 * 1000;

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {string}
 */
export function resolveLastPublishedPath(options = {}) {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  const cacheHome = env.XDG_CACHE_HOME || join(options.home ?? homedir(), ".cache");
  return join(cacheHome, "pi-quota", "last-published.json");
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {import("../engine.js").PiQuotaReport | null}
 */
export function loadLastPublished(options = {}) {
  try {
    const parsed = JSON.parse(readFileSync(resolveLastPublishedPath(options), "utf-8"));
    return parsed?.report && Array.isArray(parsed.report.providers) ? parsed.report : null;
  } catch {
    return null;
  }
}

/**
 * @param {import("../engine.js").PiQuotaReport} report
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {{ ok: boolean, error?: string }}
 */
export function saveLastPublished(report, options = {}) {
  const path = resolveLastPublishedPath(options);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ savedAt: Date.now(), report }, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }
}

/**
 * Per-family "last good" store.
 *
 * `mergeSticky` can only carry what was last *published*. If a provider is
 * throttled before any good snapshot was ever stored, or the throttle outlives
 * the previous report, the card would simply disappear — and the user would be
 * blind to real usage precisely while a transient upstream problem is happening.
 *
 * This keeps the last *healthy* snapshot per family and restores it when that
 * family fails transiently. Permanent failures (expired sign-in, missing
 * credential) are never masked, and every restore is labelled with the age of
 * the data so nothing is presented as fresher than it is.
 */

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {string}
 */
export function resolveLastGoodPath(options = {}) {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  const cacheHome = env.XDG_CACHE_HOME || join(options.home ?? homedir(), ".cache");
  return join(cacheHome, "pi-quota", "last-good.json");
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {Record<string, { result: import("../model.js").QuotaResult, savedAt: number }>}
 */
export function readLastGood(options = {}) {
  try {
    const parsed = JSON.parse(readFileSync(resolveLastGoodPath(options), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, { result: import("../model.js").QuotaResult, savedAt: number }>} state
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {boolean}
 */
function writeLastGood(state, options = {}) {
  const path = resolveLastGoodPath(options);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Update the store from a report and restore transiently-failed families.
 *
 * @param {import("../engine.js").PiQuotaReport} report
 * @param {{
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   path?: string,
 * }} [options]
 * @returns {{ report: import("../engine.js").PiQuotaReport, restored: string[], saved: string[] }}
 */
export function mergeLastGood(report, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_STICKY_AGE_MS;
  const state = readLastGood(options);

  /** @type {string[]} */
  const restored = [];
  /** @type {string[]} */
  const saved = [];
  /** @type {Record<string, import("../model.js").QuotaResult[]>} */
  const byFamily = {};
  /** @type {Map<string, import("../model.js").QuotaResult>} */
  const replacements = new Map();
  /** @type {string[]} */
  const warnings = [...report.warnings];

  for (const [family, results] of Object.entries(report.byFamily)) {
    const fresh = results[0];
    if (fresh?.ok && fresh.windows.length > 0) {
      state[family] = { result: fresh, savedAt: now };
      saved.push(family);
      byFamily[family] = results;
      continue;
    }

    const stored = state[family];
    const ageMs = stored ? now - stored.savedAt : Infinity;
    const isStoredFresh = ageMs <= maxAgeMs;
    const hasExpiredToken = fresh?.expiresInMin !== null && fresh?.expiresInMin !== undefined && fresh.expiresInMin <= 0;
    const canRestore =
      stored?.result?.ok &&
      stored.result.windows.length > 0 &&
      !hasExpiredToken &&
      !isAuthFailure(fresh?.error ?? null) &&
      isStoredFresh &&
      isTransientError(fresh?.error ?? null);
    if (!canRestore) {
      if (stored?.result?.ok && !isStoredFresh && isTransientError(fresh?.error ?? null)) {
        warnings.push(
          `${family}: discarded last known values because they are stale (${Math.round(ageMs / 60000)} min old, limit ${Math.round(maxAgeMs / 60000)} min)`,
        );
      }
      byFamily[family] = results;
      continue;
    }

    const ageMinutes = Math.max(0, Math.round((now - stored.savedAt) / 60000));
    const carried = {
      ...stored.result,
      error: null,
      note: `last known values, ${ageMinutes} min old (upstream temporarily unavailable)`,
    };
    restored.push(family);
    warnings.push(
      `${family}: showing the last known values (${ageMinutes} min old) because the upstream call failed transiently`,
    );
    byFamily[family] = [carried];
    replacements.set(family, carried);
  }

  if (saved.length > 0) writeLastGood(state, options);

  // Same reason as above: keep the canonical order.
  const providers = orderedProviders(report, replacements, byFamily);

  return {
    report: { ...report, providers, byFamily, warnings },
    restored,
    saved,
  };
}
