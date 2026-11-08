/**
 * Per-provider backoff for throttled usage endpoints.
 *
 * The lesson this encodes: polling Anthropic's usage endpoint once a minute
 * gets it rate-limited, and the `retry-after` header is not always honest
 * (`retry in 0s` while still answering 429). Without a persisted backoff, every
 * process restart resumes hammering and the card stays degraded for longer than
 * it needs to.
 *
 * A throttled family is skipped entirely until its backoff expires; the sticky
 * layer then republishes the previous good snapshot, so the card survives.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

/** @type {Map<string, { mtimeMs: number, size: number, state: Record<string, number> }>} */
const backoffMemCache = new Map();

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {string}
 */
export function resolveBackoffPath(options = {}) {
  if (options.path) return options.path;
  const env = options.env ?? process.env;
  const cacheHome = options.home ? join(options.home, ".cache") : (env.XDG_CACHE_HOME || join(homedir(), ".cache"));
  return join(cacheHome, "pi-quota", "backoff.json");
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {Record<string, number>}
 */
export function readBackoff(options = {}) {
  const path = resolveBackoffPath(options);
  try {
    const stat = statSync(path);
    const cached = backoffMemCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { ...cached.state };
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    const state = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    backoffMemCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, state: { ...state } });
    return state;
  } catch {
    backoffMemCache.delete(path);
    return {};
  }
}

/**
 * @param {Record<string, number>} state
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {boolean}
 */
function writeBackoff(state, options = {}) {
  const path = resolveBackoffPath(options);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Best-effort in environments where chmod is not supported.
    }
    renameSync(temporary, path);
    try {
      const stat = statSync(path);
      backoffMemCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, state: { ...state } });
    } catch {
      backoffMemCache.delete(path);
    }
    return true;
  } catch {
    backoffMemCache.delete(path);
    try {
      rmSync(temporary, { force: true });
    } catch {}
    return false;
  }
}

/**
 * @param {string} family
 * @param {{ now?: number, env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {{ active: boolean, untilMs: number | null, secondsLeft: number | null }}
 */
export function backoffState(family, options = {}) {
  const now = options.now ?? Date.now();
  const untilMs = readBackoff(options)[family] ?? null;
  if (untilMs === null || untilMs <= now) {
    return { active: false, untilMs, secondsLeft: null };
  }
  return { active: true, untilMs, secondsLeft: Math.round((untilMs - now) / 1000) };
}

/**
 * Record a throttle for a family.
 *
 * @param {string} family
 * @param {{ retryAfterSec?: number | null, now?: number, env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {{ untilMs: number, seconds: number }}
 */
export function recordBackoff(family, options = {}) {
  const now = options.now ?? Date.now();
  const retryAfterMs =
    typeof options.retryAfterSec === "number" && options.retryAfterSec > 0
      ? options.retryAfterSec * 1000
      : DEFAULT_BACKOFF_MS;
  const duration = Math.min(Math.max(retryAfterMs, DEFAULT_BACKOFF_MS), MAX_BACKOFF_MS);
  const state = readBackoff(options);
  state[family] = now + duration;
  writeBackoff(state, options);
  return { untilMs: state[family], seconds: Math.round(duration / 1000) };
}

/**
 * @param {string} family
 * @param {{ env?: Record<string, string | undefined>, home?: string, path?: string }} [options]
 * @returns {boolean}
 */
export function clearBackoff(family, options = {}) {
  const state = readBackoff(options);
  if (!(family in state)) return false;
  delete state[family];
  return writeBackoff(state, options);
}

/**
 * True when an error is a throttle worth backing off from.
 *
 * @param {string | null} error
 * @returns {boolean}
 */
export function isThrottled(error) {
  return typeof error === "string" && /HTTP 429|rate limited/i.test(error);
}

/**
 * True when an error represents an authentication or credential failure rather than
 * a rate-limiting throttle. Authentication failures supersede throttling because
 * waiting out a backoff window cannot fix an expired or invalid credential.
 *
 * @param {string | null} error
 * @returns {boolean}
 */
export function isAuthFailure(error) {
  if (!error || typeof error !== "string") return false;
  if (isThrottled(error)) return false;
  return /\bHTTP 40[13]\b|\bstatus 40[13]\b|\b40[13]\s+(?:unauthorized|forbidden)\b|unauthorized|forbidden|token expired|sign-in expired|expired or rejected|re-authenticate|invalid_grant|token rejected|no .*access token/i.test(error);
}

/**
 * Extract a retry hint from an error string such as "retry in 212s".
 *
 * @param {string | null} error
 * @returns {number | null}
 */
export function retryAfterFromError(error) {
  const match = typeof error === "string" ? error.match(/retry in (\d+)s/) : null;
  return match ? Number(match[1]) : null;
}
