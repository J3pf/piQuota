/**
 * The one place that spawns foreign binaries.
 *
 * piQuota delegates GitHub API requests to the user's authenticated `gh` CLI and
 * uses moshi-hook's own CLI to change its usage-collection setting through the
 * supported interface rather than editing its config file. Callers must degrade
 * on missing binaries, non-zero exits and timeouts; external commands must never
 * make quota collection throw.
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ timeoutMs?: number, env?: Record<string, string | undefined> }} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string, error: string | null }}
 */
export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: options.env ?? process.env,
  });
  return {
    status: typeof result.status === "number" ? result.status : null,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error ? result.error.message : null,
  };
}
