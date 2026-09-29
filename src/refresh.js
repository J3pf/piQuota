/**
 * Per-family refresh cadence.
 *
 * The watcher used to run on a single clock: refetch every provider every 300 s and
 * re-push the same numbers five times in between, so a card could show a value up to
 * five minutes old while looking freshly published.
 *
 * The slow clock exists for one reason, and it only applies to one provider:
 * Anthropic's usage endpoint answers `429` when it is polled every minute. Every
 * other provider is happy at a minute, and a throttle is already handled by
 * `backoff.js` (that family pauses for at least five minutes) plus `sticky.js`
 * (the card keeps its last real reading), so a short clock cannot hammer anything.
 *
 * This module gives each family its own clock, fetches only what is stale, and
 * merges the result back into the one canonical report every other surface reads.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { FAMILIES } from "./engine.js";
import { readCache, resolveCachePath, writeCache } from "./cache.js";

/** Claude pays for the slow clock; everything else is happy at a minute. */
export const CLAUDE_TTL_SEC = 300;
export const DEFAULT_FAMILY_TTL_SEC = 60;

/**
 * @param {{ claudeTtlSec?: number, defaultTtlSec?: number, families?: string[] }} [options]
 * @returns {Record<string, number>}
 */
export function resolveFamilyTtls(options = {}) {
  const defaultTtl = options.defaultTtlSec ?? DEFAULT_FAMILY_TTL_SEC;
  const claudeTtl = options.claudeTtlSec ?? CLAUDE_TTL_SEC;
  /** @type {Record<string, number>} */
  const ttls = {};
  for (const family of options.families ?? FAMILIES) {
    ttls[family] = family === "claude" ? claudeTtl : defaultTtl;
  }
  return ttls;
}

/**
 * @param {{
 *   fetchedAtMs: Record<string, number>,
 *   ttls: Record<string, number>,
 *   families?: string[],
 *   now?: number,
 * }} options
 * @returns {string[]}
 */
export function staleFamilies(options) {
  const now = options.now ?? Date.now();
  const families = options.families ?? FAMILIES;
  return families.filter((family) => {
    const fetchedAt = options.fetchedAtMs[family];
    // Never fetched is always stale: a missing clock is not a fresh one.
    if (typeof fetchedAt !== "number") return true;
    const ttlSec = options.ttls[family] ?? DEFAULT_FAMILY_TTL_SEC;
    return now - fetchedAt >= ttlSec * 1000;
  });
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, statePath?: string }} [options]
 * @returns {string}
 */
export function resolveRefreshStatePath(options = {}) {
  if (options.statePath) return options.statePath;
  const env = options.env ?? process.env;
  const cacheHome = options.home ? join(options.home, ".cache") : (env.XDG_CACHE_HOME || join(homedir(), ".cache"));
  return join(cacheHome, "pi-quota", "refresh-state.json");
}

/**
 * @param {{ statePath?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ fetchedAtMs: Record<string, number>, path: string, error?: string }}
 */
export function readRefreshState(options = {}) {
  const path = resolveRefreshStatePath(options);
  if (!existsSync(path)) return { fetchedAtMs: {}, path };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, { encoding: "utf-8", flag: "r" }));
  } catch {
    // A half-written clock is not evidence that anything is fresh.
    return { fetchedAtMs: {}, path, error: `cannot parse ${path}` };
  }

  /** @type {Record<string, number>} */
  const fetchedAtMs = {};
  const raw = parsed?.fetchedAtMs;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [family, value] of Object.entries(raw)) {
      if (typeof value === "number" && Number.isFinite(value)) fetchedAtMs[family] = value;
    }
  }
  return { fetchedAtMs, path };
}

/**
 * @param {{ fetchedAtMs: Record<string, number> }} state
 * @param {{ statePath?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function writeRefreshState(state, options = {}) {
  const path = resolveRefreshStatePath(options);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ fetchedAtMs: state.fetchedAtMs }, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temporary, path);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, path, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }
}

/**
 * Fold several partial reports into the one canonical report.
 *
 * Every surface reads `providers` in family order, so the merge must not leak the
 * order in which the pieces happened to be fetched.
 *
 * @param {Array<import("./engine.js").PiQuotaReport | null | undefined>} parts
 * @param {{ families?: string[], now?: number, reused?: string[] }} [options]
 * @returns {import("./engine.js").PiQuotaReport}
 */
export function mergeReports(parts, options = {}) {
  const now = options.now ?? Date.now();
  const families = options.families ?? FAMILIES;
  const reused = new Set(options.reused ?? []);
  const usable = parts.filter((part) => part && Array.isArray(part.providers));

  /** @type {Map<string, import("./model.js").QuotaResult>} */
  const byFamily = new Map();
  // Later parts win, so the caller can pass the cached copy first and the fresh one
  // last without having to think about precedence.
  for (const part of usable) {
    for (const provider of part.providers) {
      if (!byFamily.has(provider.family) || options.overwrite !== false) byFamily.set(provider.family, provider);
    }
  }

  const ordered = families
    .map((family) => byFamily.get(family))
    .filter((provider) => provider !== undefined)
    .map((provider) => {
      if (!reused.has(provider.family)) return provider;
      return {
        ...provider,
        windows: (provider.windows ?? []).map((win) => {
          if (!win.resetsAt) return win;
          const parsedMs = Date.parse(win.resetsAt);
          if (Number.isNaN(parsedMs)) return win;
          return { ...win, resetsInSec: Math.max(0, Math.round((parsedMs - now) / 1000)) };
        }),
      };
    });

  /** @type {string[]} */
  const sources = [];
  for (const part of usable) {
    for (const source of part.sources ?? []) {
      if (!sources.includes(source)) sources.push(source);
    }
  }

  // A warning is prefixed with its family, so it can be kept only while that family
  // is actually the cached copy. A warning about a family we just refetched is stale
  // by definition.
  /** @type {string[]} */
  const warnings = [];
  const freshParts = usable.filter((part) => !reused.has(part.providers[0]?.family));
  for (const part of freshParts) {
    for (const warning of part.warnings ?? []) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }
  for (const part of usable) {
    for (const warning of part.warnings ?? []) {
      const family = String(warning).split(":")[0];
      if (!reused.has(family)) continue;
      if (!warnings.includes(warning)) warnings.push(warning);
    }
  }

  const newest = usable
    .map((part) => part.generatedAt)
    .filter((value) => typeof value === "string")
    .sort()
    .at(-1);

  const withClaude = usable.find((part) => part.claudeSource);

  return {
    engine: "pi-quota",
    schemaVersion: 1,
    readOnly: true,
    generatedAt: newest ?? new Date(now).toISOString(),
    sources,
    ...(withClaude ? { claudeSource: withClaude.claudeSource } : {}),
    warnings,
    providers: ordered,
    byFamily: Object.fromEntries(
      ordered.map((provider) => [provider.family, ordered.filter((other) => other.family === provider.family)]),
    ),
  };
}

/**
 * Refresh only the families that are past their own clock.
 *
 * @param {{
 *   families?: string[],
 *   ttls?: Record<string, number>,
 *   cachePath?: string,
 *   statePath?: string,
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   loader: (families: string[]) => Promise<import("./engine.js").PiQuotaReport>,
 * }} options
 * @returns {Promise<{
 *   report: import("./engine.js").PiQuotaReport,
 *   fetched: string[],
 *   reused: string[],
 *   ageMs: Record<string, number>,
 * }>}
 */
export async function collectWithCadence(options) {
  const now = options.now ?? Date.now();
  const families = options.families ?? FAMILIES;
  const ttls = options.ttls ?? resolveFamilyTtls({ families });
  const cachePath = options.cachePath ?? resolveCachePath(options);
  const statePath = options.statePath ?? resolveRefreshStatePath(options);

  // Read the report with no TTL: this layer decides freshness per family, and a
  // null here only means there is nothing to reuse.
  const cached = readCache({ path: cachePath, now, ttlMs: Number.POSITIVE_INFINITY });
  const state = readRefreshState({ statePath });
  const fetchedAtMs = { ...state.fetchedAtMs };
  // Unknown families in the state file are dropped, so a removed provider cannot
  // keep a clock alive forever.
  for (const family of Object.keys(fetchedAtMs)) {
    if (!families.includes(family)) delete fetchedAtMs[family];
  }

  const cachedFamilies = cached?.report?.byFamily ? Object.keys(cached.report.byFamily) : [];
  const stale = families.filter((family) => {
    if (!cachedFamilies.includes(family)) return true;
    const fetchedAt = fetchedAtMs[family];
    if (typeof fetchedAt !== "number") return true;
    const ttlSec = ttls[family] ?? DEFAULT_FAMILY_TTL_SEC;
    return now - fetchedAt >= ttlSec * 1000;
  });
  const reusable = cached
    ? cached.report.providers.filter((provider) => !stale.includes(provider.family)).map((provider) => provider.family)
    : [];
  const reused = families.filter((family) => reusable.includes(family));

  let fresh = null;
  if (stale.length > 0) {
    fresh = await options.loader(stale);
    for (const family of stale) fetchedAtMs[family] = now;
  }

  // The cached part is filtered to the families we are actually keeping: the stale
  // ones are about to be replaced, and dragging them in would let a stale window
  // win if the fresh report ever omitted a family.
  const cachedPart = cached
    ? { ...cached.report, providers: cached.report.providers.filter((provider) => reused.includes(provider.family)) }
    : null;

  const report = mergeReports([cachedPart, fresh], { families, now, reused });
  writeCache(report, { path: cachePath, now });
  writeRefreshState({ fetchedAtMs }, { statePath });

  /** @type {Record<string, number>} */
  const ageMs = {};
  for (const family of families) {
    const at = fetchedAtMs[family];
    ageMs[family] = typeof at === "number" ? Math.max(0, now - at) : 0;
  }

  return { report, fetched: stale, reused, ageMs };
}
