/**
 * Parser for the authenticated OpenCode Go dashboard.
 *
 * opencode.ai is a SolidJS/SSR app: there is no public REST endpoint for usage
 * (every `/api/*` guess returns 404), so the numbers have to be read out of the
 * rendered page for `/workspace/<id>/go`.
 *
 * Because that page cannot be inspected without a session cookie, the parser is
 * deliberately multi-strategy and never throws:
 *   1. `data-slot="usage-item"` blocks (rendered markup);
 *   2. hydration JSON objects keyed `rollingUsage` / `weeklyUsage` /
 *      `monthlyUsage` (SolidJS serialized state);
 *   3. a generic scan pairing `usagePercent`/`usedPercent` with
 *      `resetInSec`/`resetSeconds` next to a recognizable window keyword.
 */

import { buildWindow, clampPercent, finiteNumber, stringValue } from "../model.js";

/**
 * Convert Console API meter values into canonical quota windows.
 *
 * @param {unknown} meters
 * @param {{ now?: number }} [options]
 * @returns {import("../model.js").QuotaWindow[]}
 */
export function parseGoMeters(meters, options = {}) {
  const source = record(meters);
  if (!source) return [];

  const definitions = [
    ["fiveHour", "5h", "5h window", 18000],
    ["week", "weekly", "Weekly window", 604800],
    ["month", "monthly", "Monthly window", 2592000],
  ];

  return definitions.flatMap(([field, id, label, windowSeconds]) => {
    const meter = record(source[field]);
    if (!meter) return [];
    const limit = Number(meter.limitMicroCents);
    const used = Number(meter.usedMicroCents);
    const usedPercent = Number.isFinite(limit) && limit > 0 && Number.isFinite(used)
      ? Math.min(100, Math.max(0, (used / limit) * 100))
      : null;
    return [buildWindow({ id, label, usedPercent, resetsAt: meter.resetsAt, windowSeconds, now: options.now })];
  });
}

/**
 * Canonical window ids in the order the Go plan presents them.
 *
 * The label separators matter: the live page renders "5-hour Usage" (hyphenated),
 * so a `\s*` separator silently dropped the 5h window. The aliases therefore
 * accept a space, a hyphen or nothing at all.
 */
export const GO_WINDOWS = [
  {
    field: "rollingUsage",
    id: "5h",
    label: "5h window",
    aliases: /\b(?:rolling|session|hourly)\b|\b5[\s-]*(?:h|hours?|hrs?)\b|\bfive[\s-]*hours?\b/i,
  },
  {
    field: "weeklyUsage",
    id: "weekly",
    label: "Weekly window",
    aliases: /\bweekly\b|\bweek\b|\b7[\s-]*d(?:ay)?s?\b|\bseven[\s-]*days?\b/i,
  },
  {
    field: "monthlyUsage",
    id: "monthly",
    label: "Monthly window",
    aliases: /\bmonthly\b|\bmonth\b|\b30[\s-]*d(?:ay)?s?\b/i,
  },
];

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * Decode the HTML entities and drop tags for a fragment.
 *
 * @param {string} value
 * @returns {string}
 */
export function htmlToText(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (match, dec, hex, named) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      const table = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      return table[String(named).toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a percentage out of arbitrary text.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parsePercent(value) {
  if (typeof value === "number") return clampPercent(value);
  const text = stringValue(value);
  if (!text) return null;
  const match = text.match(/(-?(?:\d+(?:\.\d*)?|\.\d+))\s*%/);
  return match ? clampPercent(Number(match[1])) : null;
}

/**
 * Parse a reset phrase such as "Resets in 5 hours 10 minutes" into seconds.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseResetSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const text = htmlToText(stringValue(value) ?? "").toLowerCase();
  if (!text) return null;
  if (/\b(?:resets?|resetting)(?:\s+right)?\s+now\b|^now$/.test(text)) return 0;
  const unitSeconds = { d: 86400, day: 86400, days: 86400, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };
  const pattern = /(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
  let matched = false;
  let seconds = 0;
  for (const match of text.matchAll(pattern)) {
    matched = true;
    seconds += Number(match[1]) * (unitSeconds[match[2].toLowerCase()] ?? 0);
  }
  return matched ? Math.max(0, Math.round(seconds)) : null;
}

/**
 * Read `data-slot="<name>"` text from a fragment.
 *
 * @param {string} segment
 * @param {string} slot
 * @returns {string}
 */
function readSlot(segment, slot) {
  const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z][\\w:-]*)\\b[^>]*\\bdata-slot\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped}\\b)[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`,
    "i",
  );
  const match = segment.match(pattern);
  return match ? htmlToText(match[2]) : "";
}

/**
 * @param {string} label
 * @returns {{ id: string, label: string } | null}
 */
function windowForLabel(label) {
  for (const window of GO_WINDOWS) {
    if (window.aliases.test(label)) return { id: window.id, label: window.label };
  }
  return null;
}

/**
 * Extract balanced JSON objects that contain a given key.
 *
 * @param {string} text
 * @param {string} key
 * @returns {string[]}
 */
function objectsWithKey(text, key) {
  /** @type {string[]} */
  const out = [];
  const pattern = new RegExp(`(?:"|')?${key}(?:"|')?\\s*:\\s*\\{`, "g");
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + match[0].lastIndexOf("{");
    const object = balancedObject(text, start);
    if (object) out.push(object);
  }
  return out;
}

/**
 * @param {string} text
 * @param {number} start
 * @returns {string | null}
 */
function balancedObject(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * @param {string} object
 * @param {string} key
 * @returns {number | null}
 */
function numberField(object, key) {
  const pattern = new RegExp(`(?:"|')?${key}(?:"|')?\\s*:\\s*(?:"|')?(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))`);
  const match = object.match(pattern);
  return match ? Number(match[1]) : null;
}

/**
 * Parse the dashboard HTML into quota windows.
 *
 * @param {unknown} html
 * @param {{ now?: number }} [options]
 * @returns {{ windows: import("../model.js").QuotaWindow[], strategies: string[], planHint: string | null }}
 */
export function parseGoDashboard(html, options = {}) {
  const now = options.now ?? Date.now();
  const text = typeof html === "string" ? html : "";
  if (text.trim() === "") return { windows: [], strategies: [], planHint: null };

  /** @type {Map<string, { usagePercent: number | null, resetInSec: number | null }>} */
  const collected = new Map();
  /** @type {string[]} */
  const strategies = [];

  // Strategy 1: rendered markup.
  const itemPattern = /<[a-z][\w:-]*\b[^>]*\bdata-slot\s*=\s*(?:"usage-item"|'usage-item'|usage-item\b)[^>]*>/gi;
  const starts = [...text.matchAll(itemPattern)].map((match) => match.index ?? 0);
  for (let index = 0; index < starts.length; index += 1) {
    const segment = text.slice(starts[index], starts[index + 1] ?? text.length);
    const label = readSlot(segment, "usage-label");
    const value = readSlot(segment, "usage-value");
    const reset = readSlot(segment, "reset-time");
    const window = windowForLabel(label);
    const usagePercent = parsePercent(value);
    if (!window || usagePercent === null) continue;
    if (!collected.has(window.id)) {
      collected.set(window.id, { usagePercent, resetInSec: parseResetSeconds(reset) });
      if (!strategies.includes("usage-item")) strategies.push("usage-item");
    }
  }

  // Strategy 2: hydration state. Complementary, so a partial render cannot hide
  // a window that only exists in the serialized state.
  if (collected.size < GO_WINDOWS.length) {
    const decoded = text.replace(/\\u0022/gi, '"').replace(/\\"/g, '"');
    for (const window of GO_WINDOWS) {
      if (collected.has(window.id)) continue;
      for (const object of objectsWithKey(decoded, window.field)) {
        const usagePercent = numberField(object, "usagePercent") ?? numberField(object, "usedPercent");
        if (usagePercent === null) continue;
        const resetInSec = numberField(object, "resetInSec") ?? numberField(object, "resetSeconds");
        collected.set(window.id, { usagePercent, resetInSec });
        if (!strategies.includes("hydration")) strategies.push("hydration");
        break;
      }
    }
  }

  // Strategy 3: generic scan around recognizable labels. Also complementary.
  if (collected.size < GO_WINDOWS.length) {
    const decoded = text.replace(/\\u0022/gi, '"').replace(/\\"/g, '"');
    for (const window of GO_WINDOWS) {
      if (collected.has(window.id)) continue;
      const labelIndex = decoded.search(window.aliases);
      if (labelIndex < 0) continue;
      const vicinity = decoded.slice(labelIndex, labelIndex + 600);
      const usagePercent =
        numberField(vicinity, "usagePercent") ??
        numberField(vicinity, "usedPercent") ??
        parsePercent(stringValue(vicinity.match(/(-?[\d.]+)\s*%/)?.[0]) ?? "");
      if (usagePercent === null) continue;
      const resetInSec = numberField(vicinity, "resetInSec") ?? parseResetSeconds(vicinity);
      if (!collected.has(window.id)) {
        collected.set(window.id, { usagePercent, resetInSec });
        if (!strategies.includes("generic")) strategies.push("generic");
      }
    }
  }

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  for (const window of GO_WINDOWS) {
    const found = collected.get(window.id);
    if (!found) continue;
    windows.push(
      buildWindow({
        id: window.id,
        label: window.label,
        usedPercent: found.usagePercent,
        resetsInSec: found.resetInSec,
        now,
      }),
    );
  }

  const planMatch = text.match(/\$\s?(\d+(?:\.\d+)?)\s*(?:\/|per\s*)?\s*month/i);
  return { windows, strategies, planHint: planMatch ? `$${planMatch[1]}/month` : null };
}

/**
 * Find workspace ids referenced by a page.
 *
 * @param {unknown} html
 * @returns {string[]}
 */
export function findWorkspaceIds(html) {
  const text = typeof html === "string" ? html : "";
  /** @type {Set<string>} */
  const ids = new Set();
  for (const match of text.matchAll(/\/workspace\/([A-Za-z0-9_-]{4,})/g)) ids.add(match[1]);
  for (const match of text.matchAll(/"(?:workspaceId|workspace_id|id)"\s*:\s*"([A-Za-z0-9_-]{4,})"/g)) ids.add(match[1]);
  return [...ids].filter((id) => id !== "settings" && id !== "usage" && id !== "go" && id !== "keys" && id !== "members" && id !== "billing");
}

export { finiteNumber };
