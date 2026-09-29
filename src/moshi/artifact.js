/**
 * Local Moshi-shaped artifact.
 *
 * A file-based fallback for when the caller does not want to use the paired
 * host channel, plus a diagnostic record of what Pi contributes. Identities are
 * redacted: everything that could leave the machine is at most percentages,
 * window labels, reset timestamps and plan names.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ARTIFACT_VERSION = 2;

/**
 * @param {string} value
 * @returns {string}
 */
export function redactIdentity(value) {
  if (typeof value !== "string" || value === "") return "unavailable";
  const at = value.indexOf("@");
  if (at < 0) return value;
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, stateDir?: string }} [options]
 * @returns {string}
 */
export function resolveArtifactPath(options = {}) {
  const env = options.env ?? process.env;
  const stateDir =
    options.stateDir ?? join(env.XDG_STATE_HOME || join(options.home ?? homedir(), ".local", "state"), "pi-quota");
  return join(stateDir, "moshi-usage.json");
}

/**
 * @param {import("../engine.js").PiQuotaReport} report
 * @returns {Record<string, unknown>}
 */
export function buildArtifact(report) {
  return {
    artifactVersion: ARTIFACT_VERSION,
    producer: "pi-quota",
    note: "Read-only snapshot of Pi credentials. Local artifact; the paired push goes to the Moshi host channel.",
    generatedAt: report.generatedAt,
    readOnly: true,
    sources: report.sources,
    warnings: report.warnings.map(redactIdentity),
    snapshots: report.providers.map((provider) => ({
      agent: "pi",
      family: provider.family,
      accountLabel: provider.label,
      account: redactIdentity(provider.account),
      capturedAt: report.generatedAt,
      available: provider.ok,
      authoritative: false,
      error: provider.error,
      plan: provider.plan,
      windows: provider.windows.map((window) => ({
        kind: window.id,
        label: window.label,
        usedPercent: window.usedPercent,
        usedPercentage: window.usedPercent,
        resetsAt: window.resetsAt,
        windowSeconds: window.windowSeconds,
      })),
    })),
  };
}

/**
 * @param {Record<string, unknown>} artifact
 * @param {string} path
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function writeArtifact(artifact, path) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(artifact, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Best-effort in environments without chmod.
    }
    renameSync(temporary, path);
    return { ok: true, path };
  } catch (error) {
    return { ok: false, path, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }
}
