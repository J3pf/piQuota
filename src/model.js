/**
 * Shared quota model.
 *
 * Every provider normalizes its own API response into `QuotaWindow[]` so the
 * terminal renderer, the Pi TUI extension and the Moshi adapter consume exactly
 * one shape.
 */

/**
 * @typedef {Object} QuotaWindow
 * @property {string} id                   Stable id, e.g. "5h", "weekly", "monthly".
 * @property {string} label                Human label, e.g. "5h window".
 * @property {number | null} usedPercent   Percent consumed (0-100).
 * @property {number | null} remainingPercent
 * @property {string | null} resetsAt      ISO timestamp.
 * @property {number | null} resetsInSec   Seconds until reset.
 * @property {number | null} windowSeconds Length of the window when known.
 * @property {string | null} note          Provider-specific extra context.
 */

/**
 * @typedef {Object} QuotaResult
 * @property {string} family
 * @property {string} label
 * @property {string} account              Display identity (email or short id).
 * @property {string | null} plan
 * @property {QuotaWindow[]} windows
 * @property {string | null} error         Degradation message; null when healthy.
 * @property {boolean} ok
 * @property {string} updatedAt            ISO timestamp.
 * @property {string} source               Credential source description.
 * @property {"pi" | "claude-code"} [sourceKind]  Which kind of store produced it.
 * @property {string | null} expiresInMin  Credential freshness, when known.
 */

/**
 * Clamp to the inclusive 0-100 percent range.
 *
 * A missing value stays missing: `Number(null)` is 0, and turning "no data" into
 * "0% used" would render as a full bar.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function clampPercent(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function finiteNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function stringValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Epoch values below this are seconds, above are milliseconds. See the matching
 * constant in auth/pi-auth.js.
 */
const SECONDS_EPOCH_CEILING = 1e11;

/**
 * Parse a reset value into an ISO timestamp plus a countdown.
 *
 * Accepts ISO strings, epoch seconds/ms numbers and explicit second counts.
 *
 * @param {unknown} value
 * @param {number} now
 * @returns {{ resetsAt: string | null, resetsInSec: number | null }}
 */
export function parseReset(value, now = Date.now()) {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    if (numeric > 1e9) {
      const ms = numeric > SECONDS_EPOCH_CEILING ? numeric : numeric * 1000;
      return { resetsAt: new Date(ms).toISOString(), resetsInSec: Math.max(0, Math.round((ms - now) / 1000)) };
    }
    if (numeric >= 0) {
      return parseResetSeconds(numeric, now);
    }
    return { resetsAt: null, resetsInSec: null };
  }
  const text = stringValue(value);
  if (text) {
    if (/^\d+(\.\d+)?$/.test(text)) {
      const num = Number(text);
      if (num >= 0 && num <= 1e9) {
        return parseResetSeconds(num, now);
      }
    }
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) {
      return { resetsAt: new Date(parsed).toISOString(), resetsInSec: Math.max(0, Math.round((parsed - now) / 1000)) };
    }
  }
  return { resetsAt: null, resetsInSec: null };
}

/**
 * Derive a reset timestamp purely from a remaining-seconds count.
 *
 * @param {unknown} seconds
 * @param {number} now
 * @returns {{ resetsAt: string | null, resetsInSec: number | null }}
 */
export function parseResetSeconds(seconds, now = Date.now()) {
  const numeric = finiteNumber(seconds);
  if (numeric === null || numeric < 0) return { resetsAt: null, resetsInSec: null };
  const rounded = Math.round(numeric);
  return { resetsAt: new Date(now + rounded * 1000).toISOString(), resetsInSec: rounded };
}

/**
 * Build a window from a used-percent value.
 *
 * @param {{
 *   id: string,
 *   label: string,
 *   usedPercent?: unknown,
 *   remainingPercent?: unknown,
 *   resetsAt?: unknown,
 *   resetsInSec?: unknown,
 *   windowSeconds?: unknown,
 *   note?: string | null,
 *   now?: number,
 * }} input
 * @returns {QuotaWindow}
 */
export function buildWindow(input) {
  const now = input.now ?? Date.now();
  let used = clampPercent(input.usedPercent);
  let remaining = clampPercent(input.remainingPercent);
  if (used === null && remaining !== null) {
    used = 100 - remaining;
  } else if (remaining === null && used !== null) {
    remaining = 100 - used;
  }

  let resets = { resetsAt: null, resetsInSec: null };
  if (input.resetsAt !== undefined && input.resetsAt !== null) {
    resets = parseReset(input.resetsAt, now);
  } else if (input.resetsInSec !== undefined && input.resetsInSec !== null) {
    resets = parseResetSeconds(input.resetsInSec, now);
  }

  return {
    id: input.id,
    label: input.label,
    usedPercent: used,
    remainingPercent: remaining,
    resetsAt: resets.resetsAt,
    resetsInSec: resets.resetsInSec,
    windowSeconds: finiteNumber(input.windowSeconds),
    note: input.note ?? null,
  };
}

/**
 * Map a window length in seconds onto a canonical id/label pair.
 *
 * @param {number | null} seconds
 * @returns {{ id: string, label: string }}
 */
export function windowFromSeconds(seconds) {
  if (seconds === null) return { id: "window", label: "Window" };
  if (seconds <= 6 * 3600) return { id: "5h", label: "5h window" };
  if (seconds <= 8 * 86400) return { id: "weekly", label: "Weekly window" };
  if (seconds <= 31 * 86400) return { id: "monthly", label: "Monthly window" };
  return { id: "window", label: "Window" };
}

/**
 * Map a provider-supplied window name onto a canonical id/label pair.
 *
 * @param {unknown} name
 * @returns {{ id: string, label: string }}
 */
export function windowFromName(name) {
  const text = (stringValue(name) ?? "").toLowerCase();
  if (text.includes("week")) return { id: "weekly", label: "Weekly window" };
  if (text.includes("month")) return { id: "monthly", label: "Monthly window" };
  if (text.includes("day") && !text.includes("week")) return { id: "daily", label: "Daily window" };
  if (text.includes("5h") || text.includes("five") || text.includes("session") || text.includes("hour")) {
    return { id: "5h", label: "5h window" };
  }
  return { id: text || "window", label: text || "Window" };
}

/**
 * Format a second count as a short human duration, e.g. "3h 12m".
 *
 * @param {number | null} seconds
 * @returns {string}
 */
export function humanDuration(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return "unknown";
  if (seconds <= 0) return "now";
  const total = Math.round(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/**
 * Format a reset countdown for a UI string.
 *
 * @param {number | null} seconds
 * @returns {string}
 */
export function humanReset(seconds) {
  if (seconds === null) return "reset unknown";
  if (seconds <= 0) return "resetting now";
  return `reset in ${humanDuration(seconds)}`;
}

/**
 * Build a complete degraded result for one family.
 *
 * @param {{
 *   family: string,
 *   label: string,
 *   account?: string | null,
 *   plan?: string | null,
 *   error: string,
 *   source: string,
 *   now?: number,
 *   expiresInMin?: number | null,
 *   windows?: QuotaWindow[],
 * }} input
 * @returns {QuotaResult}
 */
export function degradedResult(input) {
  const notConfigured = Boolean(
    input.notConfigured ??
      (typeof input.error === "string" && input.error.startsWith("no ") && input.error.includes("credential in the Pi store")),
  );
  return {
    family: input.family,
    label: input.label,
    account: input.account ?? "unknown",
    plan: input.plan ?? null,
    windows: input.windows ?? [],
    error: input.error,
    ok: false,
    notConfigured,
    updatedAt: new Date(input.now ?? Date.now()).toISOString(),
    source: input.source,
    sourceKind: input.sourceKind,
    expiresInMin: input.expiresInMin ?? null,
  };
}

/**
 * Pick a display identity without leaking full secrets.
 *
 * @param {{ email?: string | null, accountId?: string | null, projectId?: string | null, identity?: string }} credential
 * @returns {string}
 */
export function displayIdentity(credential) {
  if (credential.email) return credential.email;
  if (credential.accountId) return `${credential.accountId.slice(0, 8)}…`;
  if (credential.projectId) return `project ${credential.projectId.slice(0, 8)}…`;
  return credential.identity ? `id ${credential.identity.slice(0, 8)}…` : "unknown";
}

/**
 * Rank a window by how soon it constrains you: 0 = shortest (5h/session),
 * then daily, weekly, monthly, and finally anything unrecognized.
 *
 * @param {QuotaWindow} window
 * @returns {number}
 */
export function windowRank(window) {
  const seconds = finiteNumber(window?.windowSeconds);
  if (seconds !== null && seconds > 0) {
    if (seconds <= 6 * 3600) return 0;
    if (seconds <= 36 * 3600) return 1;
    if (seconds <= 8 * 86400) return 2;
    if (seconds <= 31 * 86400) return 3;
  }
  const id = String(window?.id ?? "").toLowerCase();
  if (id.includes("5h") || id.includes("session") || id.includes("hour") || id.includes("rolling")) return 0;
  if (id.includes("daily") || id.includes("day")) return 1;
  if (id.includes("weekly") || id.includes("week") || id.includes("7d")) return 2;
  if (id.includes("monthly") || id.includes("month") || id.includes("30d")) return 3;
  return 4;
}

/**
 * The window that represents a provider at a glance.
 *
 * Shortest first, because that is the limit you hit first: a 5h window at 3%
 * used tells you far more about "can I keep working" than a weekly window at
 * 69%. Ties inside the same rank go to the tightest one, so Antigravity's two
 * 5h groups resolve to whichever is more consumed.
 *
 * @param {QuotaWindow[]} windows
 * @returns {QuotaWindow | null}
 */
export function selectPrimaryWindow(windows) {
  const list = Array.isArray(windows) ? windows : [];
  const scored = list.filter((window) => window?.remainingPercent !== null && window?.remainingPercent !== undefined);
  if (scored.length === 0) return list[0] ?? null;
  return scored.reduce((best, window) => {
    const bestRank = windowRank(best);
    const rank = windowRank(window);
    if (rank !== bestRank) return rank < bestRank ? window : best;
    return /** @type {number} */ (window.remainingPercent) < /** @type {number} */ (best.remainingPercent) ? window : best;
  });
}
