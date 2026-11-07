/**
 * OpenCode Go quota.
 *
 * The `opencode-go` entry in Pi's store is an OpenCode Zen API key: it proves
 * the credential is alive but exposes no usage. The Go plan windows
 * (5h / weekly / monthly) live behind the authenticated dashboard, so they are
 * read through src/opencode/session.js, which resolves the session cookie from
 * the environment, a 0600 config file, or a local browser's cookie store.
 *
 * This provider never breaks the report: every failure is a precise,
 * actionable message.
 */

import { degradedResult, displayIdentity } from "../model.js";
import { requestJson } from "../http.js";
import { readGoPlan, resolveCookie } from "../opencode/session.js";

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
 * Confirm the Zen key still authenticates, so a degradation can distinguish a
 * dead credential from a missing session.
 *
 * @param {string | undefined} key
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

  const session = resolveCookie({
    env: options.env,
    home: options.home,
    stores: options.stores,
    allowBrowser: options.allowBrowser,
  });
  const plan = await readGoPlan({
    env: options.env,
    home: options.home,
    stores: options.stores,
    allowBrowser: options.allowBrowser,
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

  const zen = await describeZenKey(credential.key, options.fetchFn, options.timeoutMs);
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
