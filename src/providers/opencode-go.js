/**
 * OpenCode Go quota.
 *
 * Primary path (zero-browser):
 *   GET https://opencode.ai/zen/go/v1/usage  (Authorization: Bearer <API_KEY>)
 *   Uses the `opencode-go` API key Pi already stores in `~/.pi/agent/auth.json`
 *   (or `~/.local/share/opencode/auth.json` / `$OPENCODE_API_KEY`) to read the
 *   5h, weekly, and monthly Go quota windows directly, with no browser cookies.
 *
 * Fallback path (web console / dashboard):
 *   When the API usage endpoint is unavailable or no API key is configured,
 *   resolves the `opencode.ai` session cookie via `src/opencode/session.js`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildWindow, clampPercent, degradedResult, displayIdentity, finiteNumber, stringValue } from "../model.js";
import { requestJson } from "../http.js";
import { readGoPlan, resolveCookie } from "../opencode/session.js";

const ZEN_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";

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
 * Resolve an OpenCode Go API key from Pi's credential, `$OPENCODE_API_KEY`, or
 * the native OpenCode CLI store (`~/.local/share/opencode/auth.json`).
 *
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string | null}
 */
function resolveOpenCodeApiKey(credential, options = {}) {
  const fromPi = stringValue(credential?.key ?? credential?.access);
  if (fromPi) return fromPi;

  const env = options.env ?? process.env;
  const fromEnv = stringValue(env.OPENCODE_API_KEY);
  if (fromEnv) return fromEnv;

  const home = options.home ?? homedir();
  const cliAuthPath = join(home, ".local", "share", "opencode", "auth.json");
  if (!existsSync(cliAuthPath)) return null;
  try {
    const parsed = record(JSON.parse(readFileSync(cliAuthPath, { encoding: "utf-8", flag: "r" })));
    for (const keyName of ["opencode-go", "opencode", "zen"]) {
      const entry = record(parsed?.[keyName]);
      const token = stringValue(entry?.key ?? entry?.access ?? entry?.apiKey);
      if (token) return token;
    }
  } catch {
    // Ignore malformed CLI store; read-only best effort.
  }
  return null;
}

/**
 * Parse one window from `GET https://opencode.ai/zen/go/v1/usage`.
 *
 * @param {unknown} rawWindow
 * @param {string} id
 * @param {string} label
 * @param {number} windowSeconds
 * @param {unknown} fallbackResetAt
 * @param {number} now
 * @returns {import("../model.js").QuotaWindow | null}
 */
function parseGoApiWindow(rawWindow, id, label, windowSeconds, fallbackResetAt, now) {
  const win = record(rawWindow);
  if (!win) return null;

  let usedPct = clampPercent(win.usagePercent ?? win.usedPercent ?? win.percent ?? win.utilization);
  const usedDollars = finiteNumber(win.usageDollars ?? win.usedDollars);
  const limitDollars = finiteNumber(win.limitDollars);

  if (usedPct === null) {
    const used =
      usedDollars ??
      finiteNumber(win.usedMicroCents ?? win.used ?? win.usage ?? win.consumed ?? win.count ?? win.usedTokens);
    const limit =
      limitDollars ??
      finiteNumber(win.limitMicroCents ?? win.limit ?? win.total ?? win.quota ?? win.max ?? win.cap ?? win.tokenLimit);
    if (used !== null && limit !== null && limit > 0) {
      usedPct = clampPercent((used / limit) * 100);
    }
  }
  if (usedPct === null) return null;

  const resetsInSec = finiteNumber(win.resetInSec ?? win.resetsInSec ?? win.resetSeconds);
  const resetsAt = win.resetsAt ?? win.resetAt ?? fallbackResetAt ?? null;
  const note =
    usedDollars !== null && limitDollars !== null && limitDollars > 0
      ? `$${usedDollars.toFixed(2)} / $${limitDollars.toFixed(2)}`
      : null;

  return buildWindow({
    id,
    label,
    usedPercent: usedPct,
    resetsAt: resetsInSec === null ? resetsAt : null,
    resetsInSec,
    windowSeconds,
    note,
    now,
  });
}

/**
 * Query `GET https://opencode.ai/zen/go/v1/usage` directly with an API key.
 *
 * @param {string} key
 * @param {{ fetchFn?: typeof fetch, timeoutMs?: number, now: number }} options
 * @returns {Promise<{ ok: boolean, windows: import("../model.js").QuotaWindow[], authError: boolean, error: string | null }>}
 */
async function fetchGoUsageByKey(key, options) {
  const response = await requestJson(ZEN_GO_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
  });

  if (!response.ok) {
    const errObj = record(record(response.body)?.error);
    const code = stringValue(errObj?.code);
    const detail = code === "api_key_expired" ? " (API key expired)" : "";
    return {
      ok: false,
      windows: [],
      authError: Boolean(response.authError),
      error: response.authError
        ? `Pi OpenCode key${detail} was rejected by OpenCode Zen; reconnect OpenCode in Pi`
        : `OpenCode Go usage request failed: ${response.error}`,
    };
  }

  const body = record(response.body) ?? {};
  const usage = record(body.usage) ?? body;
  const renewsAt =
    usage.renewsAt ?? usage.endsAt ?? usage.resetsAt ?? body.renewsAt ?? body.endsAt ?? body.resetsAt ?? null;

  const rollingRaw = usage.rolling ?? usage.rolling5h ?? usage.fiveHour ?? usage.rollingUsage;
  const weeklyRaw = usage.weekly ?? usage.week ?? usage.weeklyUsage;
  const monthlyRaw = usage.monthly ?? usage.month ?? usage.monthlyUsage;

  /** @type {import("../model.js").QuotaWindow[]} */
  const windows = [];
  const rolling = parseGoApiWindow(rollingRaw, "5h", "5h window", 18000, null, options.now);
  const weekly = parseGoApiWindow(weeklyRaw, "weekly", "Weekly window", 604800, null, options.now);
  const monthly = parseGoApiWindow(monthlyRaw, "monthly", "Monthly window", 2592000, renewsAt, options.now);
  if (rolling) windows.push(rolling);
  if (weekly) windows.push(weekly);
  if (monthly) windows.push(monthly);

  if (windows.length === 0) {
    return { ok: false, windows: [], authError: false, error: null };
  }
  return { ok: true, windows, authError: false, error: null };
}

/**
 * Confirm the Zen key still authenticates, so a degradation can distinguish a
 * dead credential from a missing session.
 *
 * @param {string | undefined | null} key
 * @param {typeof fetch | undefined} fetchFn
 * @param {number | undefined} timeoutMs
 * @returns {Promise<string>}
 */
async function describeZenKey(key, fetchFn, timeoutMs) {
  if (!key) return "no key stored for opencode-go in the Pi store";
  const response = await requestJson(ZEN_MODELS_URL, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    fetchFn,
    timeoutMs,
  });
  if (response.ok) {
    const body = record(response.body);
    const models = Array.isArray(body?.data) ? body.data.length : 0;
    return `Pi OpenCode key is valid (${models} Zen models visible)`;
  }
  if (response.authError) return "Pi OpenCode key was rejected by OpenCode Zen; reconnect OpenCode in Pi";
  return `OpenCode Zen probe failed: ${response.error}`;
}

/**
 * @param {import("../auth/pi-auth.js").PiCredential} credential
 * @param {{
 *   now?: number,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   expiresInMin?: number | null,
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   stores?: import("../browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 * }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  const now = options.now ?? Date.now();
  const base = {
    family: "opencode-go",
    label: "OpenCode Go (Pi)",
    account: displayIdentity(credential),
    source: credential.source,
    sourceKind: credential.sourceKind ?? "pi",
    expiresInMin: options.expiresInMin ?? null,
  };

  // 1. Primary path: query `GET https://opencode.ai/zen/go/v1/usage` directly with the API key.
  const apiKey = resolveOpenCodeApiKey(credential, { env: options.env, home: options.home });
  /** @type {{ ok: boolean, windows: import("../model.js").QuotaWindow[], authError: boolean, error: string | null } | null} */
  let direct = null;
  if (apiKey) {
    direct = await fetchGoUsageByKey(apiKey, {
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      now,
    });
    if (direct.ok) {
      return {
        ...base,
        plan: "Go subscription",
        windows: direct.windows,
        error: null,
        ok: true,
        updatedAt: new Date(now).toISOString(),
      };
    }
  }

  // 2. Fallback path: resolve session cookie / web console when the API endpoint
  // did not return windows (or when using a cookie-only setup). When the API key
  // already failed with 401/403 (`direct.authError`), do not scan/copy browser
  // SQLite databases unless the caller explicitly requested `allowBrowser: true`.
  const allowBrowser = options.allowBrowser ?? (direct?.authError ? false : undefined);
  const session = resolveCookie({
    env: options.env,
    home: options.home,
    stores: options.stores,
    allowBrowser,
  });
  const plan = await readGoPlan({
    env: options.env,
    home: options.home,
    stores: options.stores,
    allowBrowser,
    cookie: session.found ? session.value : "",
    cookieName: session.name,
    cookieOrigin: session.origin ?? undefined,
    cookieDetail: session.detail,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
    now,
  });

  if (plan.ok) {
    const account = plan.workspaceId
      ? `workspace ${plan.workspaceId.length > 10 ? `${plan.workspaceId.slice(0, 8)}…` : plan.workspaceId}`
      : base.account;
    return {
      ...base,
      account,
      plan: plan.planHint ?? "Go subscription",
      windows: plan.windows,
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  }

  const zen =
    direct?.authError && direct.error
      ? direct.error
      : await describeZenKey(apiKey, options.fetchFn, options.timeoutMs);
  const hint =
    session.origin === "browser"
      ? `the browser session was read from ${session.detail} but was not accepted`
      : session.encryptedOnly
        ? "Chrome on Windows encrypts cookies with DPAPI, which WSL cannot read; log in with Firefox instead"
        : "run: piquota auth opencode";

  return degradedResult({
    ...base,
    error: `${zen}. Go plan windows unavailable: ${plan.error}. ${hint}`,
  });
}
