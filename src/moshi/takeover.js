/**
 * `piquota moshi takeover` — making piQuota the only publisher on the host.
 *
 * moshi-hook ships its own background usage poller, which reads each agent's own
 * credential file. Installing Claude Code is enough to make that poller publish a
 * second, differently-attributed Claude card next to the one piQuota publishes.
 *
 * The intent is recorded in piQuota's own state rather than inferred, so that
 * turning moshi-hook's collection off does not read as "stop publishing" for us.
 * moshi-hook's setting is flipped through moshi-hook's own CLI and never by
 * editing its config file, so its comments and unknown keys stay intact.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { runCommand } from "../exec.js";

export const TAKEOVER_VERSION = 1;
export const PUBLISHER = "pi-quota";

/** Values moshi-hook's own `set usage-collection` accepts. */
const USAGE_COLLECTION_VALUES = new Set(["on", "off", "true", "false"]);

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, stateDir?: string }} [options]
 * @returns {string}
 */
export function resolveTakeoverPath(options = {}) {
  const env = options.env ?? process.env;
  const stateDir =
    options.stateDir ?? join(env.XDG_STATE_HOME || join(options.home ?? homedir(), ".local", "state"), "pi-quota");
  return join(stateDir, "moshi-takeover.json");
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, stateDir?: string }} [options]
 * @returns {{ active: boolean, previous: string | null, takenAt: string | null, path: string, error?: string }}
 */
export function readTakeover(options = {}) {
  const path = resolveTakeoverPath(options);
  if (!existsSync(path)) return { active: false, previous: null, takenAt: null, path };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, { encoding: "utf-8", flag: "r" }));
  } catch {
    // A half-written marker is not a licence to stop respecting moshi-hook's own
    // switch, so it degrades to inactive and says why.
    return { active: false, previous: null, takenAt: null, path, error: `cannot parse ${path}` };
  }

  const active = parsed?.publisher === PUBLISHER && parsed?.active !== false;
  return {
    active,
    previous: typeof parsed?.previous === "string" ? parsed.previous : null,
    takenAt: typeof parsed?.takenAt === "string" ? parsed.takenAt : null,
    path,
  };
}

/**
 * Record the takeover intent, remembering the setting to restore later.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, stateDir?: string, previous?: string | null, takenAt?: string }} [options]
 * @returns {{ ok: boolean, path: string, error?: string }}
 */
export function writeTakeover(options = {}) {
  const path = resolveTakeoverPath(options);
  const body = {
    takeoverVersion: TAKEOVER_VERSION,
    publisher: PUBLISHER,
    previous: options.previous ?? null,
    takenAt: options.takenAt ?? new Date().toISOString(),
    note: "piQuota is the only usage publisher for the paired Moshi host; `piquota moshi release` restores moshi-hook's own poller.",
  };

  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(body, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
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

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, stateDir?: string }} [options]
 * @returns {{ ok: boolean, removed: boolean, path: string, error?: string }}
 */
export function clearTakeover(options = {}) {
  const path = resolveTakeoverPath(options);
  if (!existsSync(path)) return { ok: true, removed: false, path };
  try {
    rmSync(path);
    return { ok: true, removed: true, path };
  } catch (error) {
    return { ok: false, removed: false, path, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }
}

/**
 * Change moshi-hook's own usage-collection setting through moshi-hook's CLI.
 *
 * The value is whitelisted rather than shell-quoted: it comes from our own code,
 * and a value that is not one moshi-hook documents is a bug, not something to
 * hand to a subprocess.
 *
 * @param {string} value
 * @param {{ run?: typeof runCommand }} [options]
 * @returns {{ ok: boolean, argv: string[], error?: string }}
 */
export function setMoshiUsageCollection(value, options = {}) {
  const run = options.run ?? runCommand;
  const argv = ["moshi-hook", "set", "usage-collection", value];
  if (!USAGE_COLLECTION_VALUES.has(value) && !/^\d+\s*(ms|s|m|h)$/.test(value)) {
    return { ok: false, argv, error: `refusing to pass an unrecognized usage-collection value: ${JSON.stringify(value)}` };
  }

  let result;
  try {
    result = run(argv[0], argv.slice(1));
  } catch (error) {
    return { ok: false, argv, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }

  // A missing binary has a null status, and treating that as success would report
  // a setting change that never happened.
  const status = typeof result?.status === "number" ? result.status : null;
  if (status !== 0) {
    const detail =
      String(result?.stderr ?? "").trim() ||
      String(result?.stdout ?? "").trim() ||
      String(result?.error ?? "").trim() ||
      (status === null ? "moshi-hook could not be executed" : `exit status ${status}`);
    return { ok: false, argv, error: detail };
  }
  return { ok: true, argv };
}
