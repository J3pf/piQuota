/**
 * Antigravity quota through Google's own `agy` CLI.
 *
 * `@estebanforge/pi-antigravity-bridge` (and any other provider that drives
 * Antigravity over ACP) never stores a Google token: the bridge spawns `agy`
 * and `agy` owns the OAuth identity. Those installs therefore have no
 * `antigravity` entry in `~/.pi/agent/auth.json`, and quota has to come from
 * the CLI that already holds the account.
 *
 * This module only locates the binary. Nothing is read from agy's credential
 * store and nothing is written anywhere: the quota provider runs
 * `agy --print /usage`, which reports the same account buckets for free.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Absolute path to an `agy` binary; skips PATH discovery when set. */
export const AGY_BIN_ENV = "PI_QUOTA_AGY_BIN";
/** `auto` (default), `pi` (never use the CLI) or `agy` (always prefer it). */
export const AGY_SOURCE_ENV = "PI_QUOTA_ANTIGRAVITY_SOURCE";

const HOME_BIN_DIRS = [".local/bin", "bin", ".gemini/bin"];
const SYSTEM_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * @param {string} path
 * @param {string | undefined} platform
 * @returns {boolean}
 */
function isExecutableFile(path, platform) {
  try {
    if (!existsSync(path)) return false;
    const stats = statSync(path);
    if (!stats.isFile()) return false;
    return platform === "win32" || (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Which source Antigravity quota may use.
 *
 * @param {{ env?: Record<string, string | undefined> }} [options]
 * @returns {"auto" | "pi" | "agy"}
 */
export function resolveAgySource(options = {}) {
  const env = options.env ?? process.env;
  const value = text(env[AGY_SOURCE_ENV])?.toLowerCase();
  return value === "pi" || value === "agy" ? value : "auto";
}

/**
 * Locate the `agy` binary: explicit override first, then PATH, then the usual
 * install directories (Pi runs from GUI shells that do not always inherit a
 * login PATH).
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: string }} [options]
 * @returns {string | null}
 */
export function resolveAgyBinary(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicit = text(env[AGY_BIN_ENV]);
  // An explicit path is trusted as written: a typo has to surface as its own
  // spawn failure instead of silently falling back to another install.
  if (explicit) return explicit;

  /** @type {Set<string>} */
  const dirs = new Set();
  for (const dir of String(env.PATH ?? "").split(delimiter)) {
    if (dir) dirs.add(dir);
  }
  const home = options.home ?? homedir();
  for (const relative of HOME_BIN_DIRS) dirs.add(join(home, relative));
  for (const dir of SYSTEM_BIN_DIRS) dirs.add(dir);

  const names = platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

/**
 * Build the synthetic credential that routes Antigravity quota through `agy`.
 *
 * The shape matches a Pi credential minus every secret: there is no token to
 * leak, and `expiresAtMs: null` keeps the freshness check quiet because the
 * CLI owns the session lifetime.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   paths?: string[] | null,
 *   binary?: string | null,
 * }} [options]
 * @returns {import("./pi-auth.js").PiCredential | null}
 */
export function loadAgyCredential(options = {}) {
  const env = options.env ?? process.env;
  if (resolveAgySource({ env }) === "pi") return null;
  const explicit = text(options.binary) ?? text(env[AGY_BIN_ENV]);
  // Keep unit tests hermetic: overriding Pi's store paths is an explicit
  // "no ambient hosts" signal unless a binary was named as well.
  if (!explicit && Array.isArray(options.paths)) return null;
  const binary = explicit ?? resolveAgyBinary({ env, home: options.home, platform: options.platform });
  if (!binary) return null;

  return {
    provider: "antigravity",
    family: "antigravity",
    label: "Antigravity (agy CLI)",
    source: binary,
    sourceKind: "agy-cli",
    identity: "agy",
    expiresAtMs: null,
    accountId: null,
    projectId: null,
    email: null,
    planType: null,
    kind: "oauth",
  };
}
