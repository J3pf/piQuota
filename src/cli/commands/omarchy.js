/**
 * `piquota omarchy`: publish the quota as Omarchy agent usage records.
 *
 * One shot, opt-in, never throws: a provider that fails becomes a record that
 * says so, and a write failure is reported with a non-zero exit code.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { redact } from "../../http.js";
import { publishRecords, resolveOmarchyDir } from "../../omarchy/publish.js";
import { buildRecords } from "../../omarchy/record.js";
import { err, out } from "../output.js";

/**
 * Families to leave out, e.g. PI_QUOTA_OMARCHY_SKIP=claude when Omarchy's own
 * collector already covers that provider. Their stale pi-*.json is removed.
 *
 * Defaults to skipping `claude` when Omarchy's native `claude.json` exists in
 * the destination directory, avoiding duplicate Claude cards in the bar panel.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} [dir]
 * @returns {Set<string>}
 */
export function skippedFamilies(env, dir) {
  if (env.PI_QUOTA_OMARCHY_SKIP !== undefined) {
    return new Set(
      String(env.PI_QUOTA_OMARCHY_SKIP)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  const skip = new Set();
  const targetDir = dir ?? resolveOmarchyDir({ env });
  try {
    if (existsSync(join(targetDir, "claude.json"))) {
      skip.add("claude");
    }
  } catch {}
  return skip;
}

/**
 * @param {{ load: () => Promise<import("../../engine.js").PiQuotaReport>, dir?: string, env?: Record<string, string | undefined>, quiet?: boolean }} options
 * @returns {Promise<number>}
 */
export async function runOmarchyCommand(options) {
  let report;
  try {
    report = await options.load();
  } catch (error) {
    err(`omarchy: could not collect quota: ${redact(/** @type {{ message?: string }} */ (error)?.message ?? error)}`);
    return 1;
  }

  const skip = skippedFamilies(options.env ?? process.env, options.dir);
  const records = buildRecords(skip.size > 0 ? { ...report, providers: (report.providers ?? []).filter((p) => !skip.has(p?.family)) } : report);
  let result;
  try {
    result = publishRecords(records, { dir: options.dir, env: options.env });
  } catch (error) {
    err(`omarchy: could not write records: ${redact(/** @type {{ message?: string }} */ (error)?.message ?? error)}`);
    return 1;
  }

  if (!options.quiet) {
    out(`omarchy: wrote ${result.written.length} record(s) to ${result.dir}`);
    for (const path of result.written) out(`  ${path}`);
    for (const path of result.removed) out(`  removed stale ${path}`);
  }
  return 0;
}
