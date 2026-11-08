/**
 * `piquota omarchy`: publish the quota as Omarchy agent usage records.
 *
 * One shot, opt-in, never throws: a provider that fails becomes a record that
 * says so, and a write failure is reported with a non-zero exit code.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { redact } from "../../http.js";
import { publishRecords, resolveOmarchyDir } from "../../omarchy/publish.js";
import { buildRecords } from "../../omarchy/record.js";
import { err, out } from "../output.js";

/**
 * Detect which families (`claude`, `codex`) already have a native `<family>.json`
 * record in Omarchy's usage directory so any coexisting `pi-<family>.json` tab
 * can be disambiguated with a `(Pi)` suffix (`Codex (Pi)`, `Claude (Pi)`).
 *
 * @param {string} [dir]
 * @param {Record<string, string | undefined>} [env]
 * @returns {Set<string>}
 */
export function nativeFamilies(dir, env = process.env) {
  const native = new Set();
  const targetDir = dir ?? resolveOmarchyDir({ env });
  try {
    for (const family of ["claude", "codex"]) {
      if (existsSync(join(targetDir, `${family}.json`))) {
        native.add(family);
      }
    }
  } catch {}
  return native;
}

/**
 * Families to leave out, e.g. PI_QUOTA_OMARCHY_SKIP=claude when Omarchy's own
 * collector already covers that provider. Their stale pi-*.json is removed.
 *
 * Defaults to skipping `claude` when Omarchy's native `claude.json` exists in
 * the destination directory (unless `claude.json` has an empty `limits` array
 * and Pi's `claude` provider has live quota windows), and skipping `codex` when
 * native `codex.json` already carries non-empty `limits`.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} [dir]
 * @param {import("../../model.js").QuotaResult[]} [providers]
 * @returns {Set<string>}
 */
export function skippedFamilies(env, dir, providers) {
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
    const claudePath = join(targetDir, "claude.json");
    if (existsSync(claudePath)) {
      let emptyNativeLimits = false;
      try {
        const parsed = JSON.parse(readFileSync(claudePath, "utf-8"));
        emptyNativeLimits = Array.isArray(parsed?.limits) && parsed.limits.length === 0;
      } catch {}
      const piClaudeHealthy =
        Array.isArray(providers) &&
        providers.some((p) => p?.family === "claude" && p.ok && Array.isArray(p.windows) && p.windows.length > 0);
      if (!emptyNativeLimits || !piClaudeHealthy) {
        skip.add("claude");
      }
    }
    const codexPath = join(targetDir, "codex.json");
    if (existsSync(codexPath)) {
      const parsed = JSON.parse(readFileSync(codexPath, "utf-8"));
      if (Array.isArray(parsed?.limits) && parsed.limits.length > 0) {
        skip.add("codex");
      }
    }
  } catch {}
  return skip;
}

/**
 * @param {{ load: () => Promise<import("../../engine.js").PiQuotaReport>, dir?: string, env?: Record<string, string | undefined>, quiet?: boolean, notify?: boolean }} options
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

  const env = options.env ?? process.env;
  const skip = skippedFamilies(env, options.dir, report.providers);
  const native = nativeFamilies(options.dir, env);
  const records = buildRecords(
    skip.size > 0 ? { ...report, providers: (report.providers ?? []).filter((p) => !skip.has(p?.family)) } : report,
    { nativeFamilies: native },
  );
  let result;
  try {
    result = publishRecords(records, {
      dir: options.dir,
      env: options.env,
      notify: options.notify ?? (!options.dir && !env.PI_QUOTA_OMARCHY_DIR),
    });
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
