/**
 * OpenCode Go session resolution (cookie + workspace) and dashboard fetch.
 *
 * Independent implementation: nothing here calls another tool's code. The
 * session cookie is the only credential Pi cannot provide, so it is resolved
 * from, in order:
 *   1. `OPENCODE_GO_AUTH_COOKIE` in the environment;
 *   2. `~/.config/pi-quota/opencode-cookie` (0600, written only by an explicit
 *      `piquota auth opencode --paste`);
 *   3. a local browser's cookie store, read read-only (see src/browser/cookies.js).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { discoverCookieStores, findCookie } from "../browser/cookies.js";
import { findRecentWorkspaceIds } from "../browser/history.js";
import { requestJson } from "../http.js";
import { parseGoDashboard, parseGoMeters, findWorkspaceIds } from "./dashboard.js";

export const OPENCODE_ORIGIN = "https://opencode.ai";
export const OPENCODE_COOKIE_HOST = "opencode.ai";
export const OPENCODE_COOKIE_NAME = "auth";
export const OPENCODE_COOKIE_NAMES = ["__Host-console_session", OPENCODE_COOKIE_NAME];

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ path: string, workspacePath: string }}
 */
export function configPaths(options = {}) {
  const env = options.env ?? process.env;
  const base = env.XDG_CONFIG_HOME || join(options.home ?? homedir(), ".config", "pi-quota");
  return {
    path: join(base, "opencode-cookie"),
    workspacePath: join(base, "opencode-workspace"),
  };
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function readTrimmed(path) {
  try {
    const value = readFileSync(path, "utf-8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/**
 * @param {string} path
 * @param {string} value
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeSecretFile(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value.trim() + "\n", { encoding: "utf-8", mode: 0o600 });
    chmodSync(path, 0o600);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
  }
}

/**
 * Resolve the session cookie without ever writing it anywhere new.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   stores?: import("../browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 * }} [options]
 * @returns {{
 *   found: boolean,
 *   value?: string,
 *   origin: "env" | "config" | "browser" | null,
 *   detail: string,
 *   encryptedOnly: boolean,
 *   storeCount: number,
 *   name?: string,
 * }}
 */
export function resolveCookie(options = {}) {
  const env = options.env ?? process.env;
  const paths = configPaths(options);

  const fromEnv = env.OPENCODE_GO_AUTH_COOKIE?.trim();
  if (fromEnv) return { found: true, value: fromEnv, origin: "env", detail: "OPENCODE_GO_AUTH_COOKIE", encryptedOnly: false, storeCount: 0 };

  const fromConfig = readTrimmed(paths.path);
  if (fromConfig) return { found: true, value: fromConfig, origin: "config", detail: paths.path, encryptedOnly: false, storeCount: 0 };

  if (options.allowBrowser === false) {
    return { found: false, origin: null, detail: "browser lookup disabled", encryptedOnly: false, storeCount: 0 };
  }

  const stores = options.stores ?? discoverCookieStores(options);
  let lastHit = null;
  for (const name of OPENCODE_COOKIE_NAMES) {
    const hit = findCookie({ host: OPENCODE_COOKIE_HOST, name, stores, home: options.home });
    if (hit.found) {
      return {
        found: true,
        value: hit.value,
        origin: "browser",
        detail: hit.store ? `${hit.store.browser} ${hit.store.profile}` : "browser",
        encryptedOnly: false,
        storeCount: stores.length,
        name,
      };
    }
    lastHit = hit;
  }

  const hit = lastHit ?? { encryptedOnly: false, candidates: 0 };
  return {
    found: false,
    origin: null,
    detail:
      stores.length === 0
        ? "no browser cookie store found"
        : hit.encryptedOnly
          ? "only encrypted Chromium stores found (DPAPI is unavailable from WSL)"
          : `no "${OPENCODE_COOKIE_NAMES.join("\" or \"")}" cookie for ${OPENCODE_COOKIE_HOST} in ${hit.candidates} readable store(s)`,
    encryptedOnly: hit.encryptedOnly,
    storeCount: stores.length,
  };
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string | null}
 */
export function resolveWorkspaceIdFromConfig(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env.OPENCODE_GO_WORKSPACE_ID?.trim();
  if (fromEnv) return fromEnv;
  return readTrimmed(configPaths(options).workspacePath);
}

/**
 * Fetch a page with the session cookie.
 *
 * @param {string} url
 * @param {{ cookie: string, fetchFn?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, status: number, html: string, redirected: boolean, error?: string }>}
 */
async function fetchPage(url, options) {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      headers: {
        Cookie: `${OPENCODE_COOKIE_NAME}=${options.cookie}`,
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    const location = response.headers?.get?.("location") ?? null;
    const redirected = response.status >= 300 && response.status < 400;
    if (redirected) {
      return {
        ok: false,
        status: response.status,
        html: "",
        redirected: true,
        error: location ? `redirected to ${location.replace(/\?.*$/, "")}` : `HTTP ${response.status}`,
      };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, html: "", redirected: false, error: `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, html: await response.text(), redirected: false };
  } catch (error) {
    const name = /** @type {{ name?: string }} */ (error)?.name;
    return {
      ok: false,
      status: 0,
      html: "",
      redirected: false,
      error: name === "AbortError" ? "request timed out" : "request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Discover the workspace id.
 *
 * opencode.ai serves the workspace app only at `/workspace/<id>/...`: there is
 * no listing route (`/workspace` answers 404 even authenticated), so the id is
 * observed rather than requested. Order:
 *   1. the cached id;
 *   2. Firefox history, because the OAuth flow lands on `/workspace/<id>`;
 *   3. any id referenced by the authenticated console page.
 *
 * @param {{ cookie: string, fetchFn?: typeof fetch, timeoutMs?: number, home?: string, env?: Record<string, string | undefined>, history?: { ids: string[], profile: string | null } }} options
 * @returns {Promise<{ workspaceId: string | null, origin?: string, error?: string }>}
 */
export async function discoverWorkspaceId(options) {
  const known = resolveWorkspaceIdFromConfig(options);
  if (known) return { workspaceId: known, origin: "config" };

  const history = options.history ?? findRecentWorkspaceIds(options);
  if (history.ids.length > 0) {
    const paths = configPaths(options);
    writeSecretFile(paths.workspacePath, history.ids[0]);
    return { workspaceId: history.ids[0], origin: `firefox history (${history.profile ?? "unknown"})` };
  }

  for (const candidate of [`${OPENCODE_ORIGIN}/console/`, `${OPENCODE_ORIGIN}/`]) {
    const page = await fetchPage(candidate, options);
    if (!page.ok) continue;
    const ids = findWorkspaceIds(page.html);
    if (ids.length > 0) {
      const paths = configPaths(options);
      writeSecretFile(paths.workspacePath, ids[0]);
      return { workspaceId: ids[0], origin: `page ${candidate}` };
    }
  }

  return {
    workspaceId: null,
    error:
      "no workspace id found; finish the login so the browser lands on /workspace/<id>, " +
      "then re-run, or set OPENCODE_GO_WORKSPACE_ID",
  };
}

/**
 * Format a supplied cookie value for an OpenCode request.
 *
 * @param {string} cookie
 * @param {string} [cookieName]
 * @returns {string}
 */
export function toCookieHeader(cookie, cookieName) {
  const value = cookie.trim();
  if (value.includes("=")) return value;
  if (cookieName) return `${cookieName}=${value}`;
  return `__Host-console_session=${value}; auth=${value}`;
}

/**
 * Fetch Go quota meters from the Console API.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   now?: number,
 *   cookie?: string,
 *   cookieName?: string,
 *   workspaceId?: string,
 *   stores?: import("../browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   windows: import("../model.js").QuotaWindow[],
 *   workspaceId: string | null,
 *   planHint: string | null,
 *   strategies: string[],
 *   cookieOrigin: string,
 *   error: string | null,
 * }>}
 */
export async function fetchGoStatusApi(options = {}) {
  const cookie = options.cookie !== undefined
    ? { found: Boolean(options.cookie), value: options.cookie, origin: "provided", name: options.cookieName }
    : resolveCookie(options);
  if (!cookie.found || !cookie.value) {
    return {
      ok: false, windows: [], workspaceId: null, planHint: null, strategies: [], cookieOrigin: "none",
      error: `no OpenCode session cookie: ${cookie.detail ?? "not found"}`,
    };
  }

  const headers = {
    Cookie: toCookieHeader(cookie.value, cookie.name),
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  const ids = [];
  for (const id of [options.workspaceId, resolveWorkspaceIdFromConfig(options)]) {
    if (id && !ids.includes(id)) ids.push(id);
  }

  const errors = [];
  const tryStatus = async (orgId) => {
    const response = await requestJson(`${OPENCODE_ORIGIN}/console/api/go/status`, {
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      headers: { ...headers, "x-org-id": orgId },
    });
    if (!response.ok) {
      errors.push(response.error ?? `HTTP ${response.status}`);
      return null;
    }
    const body = response.body && typeof response.body === "object" ? response.body : null;
    const access = body && "access" in body && body.access && typeof body.access === "object" ? body.access : null;
    const meters = access && "meters" in access ? access.meters : null;
    const windows = parseGoMeters(meters, { now: options.now });
    if (windows.length === 0) {
      errors.push("Console API returned no Go usage meters");
      return null;
    }
    writeSecretFile(configPaths(options).workspacePath, orgId);
    return {
      ok: true, windows, workspaceId: orgId, planHint: "Go subscription", strategies: ["console-api"],
      cookieOrigin: String(cookie.origin), error: null,
    };
  };

  for (const orgId of ids) {
    const result = await tryStatus(orgId);
    if (result) return result;
  }

  const orgs = await requestJson(`${OPENCODE_ORIGIN}/console/api/orgs`, {
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
    headers,
  });
  if (orgs.ok && Array.isArray(orgs.body)) {
    for (const org of orgs.body) {
      const orgId = org && typeof org === "object" && typeof org.id === "string" ? org.id : null;
      if (!orgId || ids.includes(orgId)) continue;
      const result = await tryStatus(orgId);
      if (result) return result;
    }
  } else {
    errors.push(orgs.error ?? `HTTP ${orgs.status}`);
  }

  return {
    ok: false, windows: [], workspaceId: null, planHint: null, strategies: [],
    cookieOrigin: String(cookie.origin), error: errors[0] ?? "Console API returned no organizations",
  };
}

/**
 * Read the Go plan windows for one account.
 *
 * @param {{ 
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   now?: number,
 *   cookie?: string,
 *   workspaceId?: string,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   windows: import("../model.js").QuotaWindow[],
 *   workspaceId: string | null,
 *   planHint: string | null,
 *   strategies: string[],
 *   cookieOrigin: string,
 *   error: string | null,
 * }>}
 */
export async function readGoPlan(options = {}) {
  const apiResult = await fetchGoStatusApi(options);
  if (apiResult.ok) return apiResult;

  const now = options.now ?? Date.now();
  const cookie = options.cookie !== undefined
    ? { found: Boolean(options.cookie), value: options.cookie, origin: "provided", detail: "provided", encryptedOnly: false, storeCount: 0 }
    : resolveCookie(options);
  if (!cookie.found || !cookie.value) {
    return {
      ok: false,
      windows: [],
      workspaceId: null,
      planHint: null,
      strategies: [],
      cookieOrigin: "none",
      error: `no ${OPENCODE_COOKIE_NAME} cookie: ${cookie.detail}`,
    };
  }

  const workspace = options.workspaceId
    ? { workspaceId: options.workspaceId }
    : await discoverWorkspaceId({ ...options, cookie: cookie.value });
  if (!workspace.workspaceId) {
    return {
      ok: false,
      windows: [],
      workspaceId: null,
      planHint: null,
      strategies: [],
      cookieOrigin: String(cookie.origin),
      error: `session found (${cookie.detail}) but no workspace id: ${workspace.error ?? "unknown"}`,
    };
  }

  const url = `${OPENCODE_ORIGIN}/workspace/${encodeURIComponent(workspace.workspaceId)}/go`;
  const page = await fetchPage(url, { ...options, cookie: cookie.value });
  if (!page.ok) {
    return {
      ok: false,
      windows: [],
      workspaceId: workspace.workspaceId,
      planHint: null,
      strategies: [],
      cookieOrigin: String(cookie.origin),
      error: page.redirected
        ? `session rejected (${page.error}); the cookie is missing or expired`
        : `dashboard request failed (${page.error})`,
    };
  }

  const parsed = parseGoDashboard(page.html, { now });
  if (parsed.windows.length === 0) {
    return {
      ok: false,
      windows: [],
      workspaceId: workspace.workspaceId,
      planHint: parsed.planHint,
      strategies: parsed.strategies,
      cookieOrigin: String(cookie.origin),
      error: "dashboard HTML fetched but no usage windows matched (page layout may have changed)",
    };
  }

  return {
    ok: true,
    windows: parsed.windows,
    workspaceId: workspace.workspaceId,
    planHint: parsed.planHint,
    strategies: parsed.strategies,
    cookieOrigin: String(cookie.origin),
    error: null,
  };
}

export { fetchPage as fetchOpenCodePage, requestJson };
