/**
 * `piquota omarchy`: publish the quota as Omarchy agent usage records.
 *
 * One shot, opt-in, never throws: a provider that fails becomes a record that
 * says so, and a write failure is reported with a non-zero exit code.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redact } from "../../http.js";
import { publishRecords, resolveOmarchyDir } from "../../omarchy/publish.js";
import { buildRecords } from "../../omarchy/record.js";
import { err, out } from "../output.js";

/**
 * Inspect Omarchy's usage directory once for native `claude.json` and `codex.json`
 * files and whether each carries non-empty rate-limit windows.
 *
 * @param {string} targetDir
 * @returns {{ native: Set<string>, hasLimits: Set<string>, emptyLimits: Set<string> }}
 */
function inspectNativeRecords(targetDir) {
  const native = new Set();
  const hasLimits = new Set();
  const emptyLimits = new Set();
  try {
    for (const family of ["claude", "codex"]) {
      const filePath = join(targetDir, `${family}.json`);
      if (!existsSync(filePath)) continue;
      native.add(family);
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
        if (Array.isArray(parsed?.limits)) {
          if (parsed.limits.length > 0) {
            hasLimits.add(family);
          } else {
            emptyLimits.add(family);
          }
        }
      } catch {}
    }
  } catch {}
  return { native, hasLimits, emptyLimits };
}

/**
 * Check whether `~/.pi/agent/auth.json` (or `PI_QUOTA_AUTH_PATH`) contains a distinct
 * `anthropic` entry that Omarchy's native Claude collector does not inspect.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function hasPiAnthropicCredential(env = process.env) {
  try {
    const authPath = env.PI_QUOTA_AUTH_PATH || join(env.HOME || homedir(), ".pi", "agent", "auth.json");
    if (!existsSync(authPath)) return false;
    const parsed = JSON.parse(readFileSync(authPath, { encoding: "utf-8", flag: "r" }));
    return Boolean(parsed && typeof parsed === "object" && parsed.anthropic);
  } catch {
    return false;
  }
}

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
  const targetDir = dir ?? resolveOmarchyDir({ env });
  return inspectNativeRecords(targetDir).native;
}

/**
 * Resolve families that can be skipped BEFORE network collection in `piquota omarchy`
 * so `collectQuota()` never makes redundant HTTP requests for providers Omarchy already covers.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [dir]
 * @returns {Set<string>}
 */
export function preSkippedFamilies(env = process.env, dir) {
  if (env.PI_QUOTA_OMARCHY_SKIP !== undefined) {
    return new Set(
      String(env.PI_QUOTA_OMARCHY_SKIP)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  const targetDir = dir ?? resolveOmarchyDir({ env });
  const { native, hasLimits, emptyLimits } = inspectNativeRecords(targetDir);
  const skip = new Set();
  if (hasLimits.has("codex")) {
    skip.add("codex");
  }
  if (native.has("claude")) {
    if (!emptyLimits.has("claude") || !hasPiAnthropicCredential(env)) {
      skip.add("claude");
    }
  }
  return skip;
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
 * @param {{ native: Set<string>, hasLimits: Set<string>, emptyLimits: Set<string> }} [inspected]
 * @returns {Set<string>}
 */
export function skippedFamilies(env, dir, providers, inspected) {
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
  const { native, hasLimits, emptyLimits } = inspected ?? inspectNativeRecords(targetDir);
  if (native.has("claude")) {
    const piClaudeHealthy =
      Array.isArray(providers) &&
      providers.some((p) => p?.family === "claude" && p.ok && Array.isArray(p.windows) && p.windows.length > 0);
    if (!emptyLimits.has("claude") || !piClaudeHealthy) {
      skip.add("claude");
    }
  }
  if (hasLimits.has("codex")) {
    skip.add("codex");
  }
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
  const targetDir = options.dir ?? resolveOmarchyDir({ env });
  const inspected = inspectNativeRecords(targetDir);
  const skip = skippedFamilies(env, options.dir, report.providers, inspected);
  const records = buildRecords(
    skip.size > 0 ? { ...report, providers: (report.providers ?? []).filter((p) => !skip.has(p?.family)) } : report,
    { nativeFamilies: inspected.native },
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
