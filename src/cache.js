/**
 * Local response cache.
 *
 * Holds only the already-normalized report (percentages, windows, labels): no
 * access token, refresh token, API key, cookie or account e-mail beyond the
 * display identity the renderers already print.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_TTL_MS = 60_000;

/**
 * Merge a partial report into an existing cached report so partial family queries
 * do not clobber other cached providers.
 *
 * @param {import("./engine.js").PiQuotaReport | null | undefined} existingReport
 * @param {import("./engine.js").PiQuotaReport} newReport
 * @returns {import("./engine.js").PiQuotaReport}
 */
export function mergeReportIntoCache(existingReport, newReport) {
  if (!existingReport || !existingReport.byFamily) return newReport;
  const mergedByFamily = { ...existingReport.byFamily, ...newReport.byFamily };
  const existingFamilies = Object.keys(existingReport.byFamily);
  const newFamilies = Object.keys(newReport.byFamily || {});
  const allFamilies = Array.from(new Set([...existingFamilies, ...newFamilies]));
  const providers = allFamilies.flatMap((family) => mergedByFamily[family] || []);

  const keptExistingWarnings = (existingReport.warnings || []).filter((w) => {
    const family = String(w).split(":")[0];
    return !newFamilies.includes(family);
  });
  const seenPatterns = new Set();
  const warnings = [];
  for (const w of [...(newReport.warnings || []), ...keptExistingWarnings]) {
    const pattern = w.replace(/\d+m ago/, "Xm ago").replace(/\d+s old/, "Xs old").replace(/\d+s\b/, "Xs");
    if (!seenPatterns.has(pattern)) {
      seenPatterns.add(pattern);
      warnings.push(w);
    }
  }

  return {
    ...existingReport,
    ...newReport,
    providers,
    byFamily: mergedByFamily,
    warnings,
  };
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {string}
 */
export function resolveCachePath(options = {}) {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  const cacheHome = options.home ? join(options.home, ".cache") : (env.XDG_CACHE_HOME || join(homedir(), ".cache"));
  return join(cacheHome, "pi-quota", "usage.json");
}

/**
 * @param {{
 *   path?: string,
 *   ttlMs?: number,
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 * }} [options]
 * @returns {{ report: import("./engine.js").PiQuotaReport, ageMs: number, path: string } | null}
 */
export function readCache(options = {}) {
  const path = options.path ?? resolveCachePath(options);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now();

  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const report = /** @type {{ report?: import("./engine.js").PiQuotaReport }} */ (parsed).report;
  if (!report || !Array.isArray(report.providers)) return null;

  const savedAt = typeof /** @type {{ savedAt?: unknown }} */ (parsed).savedAt === "number"
    ? /** @type {number} */ (/** @type {{ savedAt?: number }} */ (parsed).savedAt)
    : null;
  if (savedAt === null) return null;
  const ageMs = now - savedAt;
  if (ageMs > ttlMs) return null;

  return { report, ageMs, path };
}

/**
 * @param {import("./engine.js").PiQuotaReport} report
 * @param {{
 *   path?: string,
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 * }} [options]
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function writeCache(report, options = {}) {
  const path = options.path ?? resolveCachePath(options);
  const now = options.now ?? Date.now();
  let finalReport = report;
  if (options.merge) {
    const existing = readCache({ ...options, path, ttlMs: Number.POSITIVE_INFINITY });
    if (existing?.report) {
      finalReport = mergeReportIntoCache(existing.report, report);
    }
  }
  const payload = JSON.stringify({ savedAt: now, report: finalReport }, null, 2);

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, payload, { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Best-effort in environments where chmod is not supported.
    }
    renameSync(temporary, path);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, path, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }
}

/**
 * @param {{ path?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ removed: boolean, path: string }}
 */
export function clearCache(options = {}) {
  const path = options.path ?? resolveCachePath(options);
  try {
    rmSync(path, { force: true });
    return { removed: true, path };
  } catch {
    return { removed: false, path };
  }
}

/**
 * @param {{ path?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ exists: boolean, path: string, sizeBytes: number | null }}
 */
export function describeCache(options = {}) {
  const path = options.path ?? resolveCachePath(options);
  try {
    const stats = statSync(path);
    return { exists: true, path, sizeBytes: stats.size };
  } catch {
    return { exists: false, path, sizeBytes: null };
  }
}

/**
 * Read-through helper: return a fresh cached report or refresh it.
 *
 * @param {{
 *   ttlMs?: number,
 *   now?: number,
 *   force?: boolean,
 *   path?: string,
 *   families?: string[],
 *   merge?: boolean,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 * }} options
 * @param {() => Promise<import("./engine.js").PiQuotaReport>} loader
 * @returns {Promise<{ report: import("./engine.js").PiQuotaReport, cached: boolean, ageMs: number }>}
 */
export async function withCache(options, loader) {
  const requested = options.families;
  if (!options.force) {
    const hit = readCache(options);
    if (hit) {
      const allPresent = !requested || requested.every((fam) => fam in hit.report.byFamily);
      if (allPresent) {
        const filteredReport = requested
          ? {
              ...hit.report,
              providers: hit.report.providers.filter((p) => requested.includes(p.family)),
              byFamily: Object.fromEntries(
                Object.entries(hit.report.byFamily).filter(([fam]) => requested.includes(fam)),
              ),
            }
          : hit.report;
        return { report: filteredReport, cached: true, ageMs: hit.ageMs };
      }
    }
  }
  const report = await loader();
  const isPartial = Array.isArray(requested) && requested.length > 0;
  writeCache(report, { ...options, merge: isPartial || options.merge });
  return { report, cached: false, ageMs: 0 };
}
