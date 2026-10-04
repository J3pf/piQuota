/**
 * Read-only reader for Pi's provider credential store (`auth.json`).
 *
 * Hard rules enforced by this module:
 *   - open the file with read-only flags and never write, move or chmod it;
 *   - never import, refresh or "sync" tokens back into it;
 *   - never emit token material through logs, errors or JSON output.
 *
 * On WSL the same Pi installation may also exist on the Windows drive. We read
 * both when present and de-duplicate by provider identity so a shared account is
 * never shown twice.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { extractChatGptAccountId, extractChatGptPlanType, extractEmail, extractExpiresAtMs } from "./jwt.js";
import { redact } from "../http.js";

/** Pi provider key -> normalized quota family. */
export const FAMILY_BY_PROVIDER = {
  "openai-codex": "codex",
  anthropic: "claude",
  antigravity: "antigravity",
  "opencode-go": "opencode-go",
};

/** Display label used by every surface (terminal, Pi TUI, Moshi cards). */
export const LABEL_BY_FAMILY = {
  codex: "Codex (Pi)",
  claude: "Claude (Pi)",
  antigravity: "Antigravity (Pi)",
  "opencode-go": "OpenCode Go (Pi)",
};

const WINDOWS_USERS_ROOT = "/mnt/c/Users";
const MAX_WINDOWS_PROFILES = 40;

/**
 * @typedef {Object} PiCredential
 * @property {string} provider            Raw Pi provider key, e.g. "openai-codex".
 * @property {string} family              Normalized family, e.g. "codex".
 * @property {string} label               Display label, e.g. "Codex (Pi)".
 * @property {string} source              Absolute path the credential came from.
 * @property {"pi" | "claude-code"} [sourceKind]  Which kind of store produced it.
 * @property {string} identity            Stable per-provider identity (never a token).
 * @property {string} [access]            OAuth access token (memory only).
 * @property {string} [refresh]           OAuth refresh token (memory only).
 * @property {string} [key]               API key (memory only).
 * @property {number | null} expiresAtMs  Epoch milliseconds when known.
 * @property {string | null} accountId
 * @property {string | null} projectId
 * @property {string | null} email
 * @property {string | null} planType
 * @property {"oauth" | "api_key"} kind
 */

/**
 * @typedef {Object} PiAuthLoadResult
 * @property {PiCredential[]} credentials
 * @property {string[]} paths               Store paths that were read.
 * @property {string[]} warnings            Non-fatal issues (already redacted).
 */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function explicitAuthPaths(env) {
  const paths = [];
  for (const key of ["PI_QUOTA_AUTH_PATH", "PI_AUTH_PATH"]) {
    const value = env[key];
    if (value) paths.push(value);
  }
  return paths;
}

/**
 * Windows-side Pi stores reachable from WSL, discovered without spawning cmd.exe.
 *
 * @param {{ platform?: string, usersRoot?: string }} [options]
 * @returns {string[]}
 */
export function discoverWindowsAuthPaths(options = {}) {
  const platform = options.platform ?? process.platform;
  const usersRoot = options.usersRoot ?? WINDOWS_USERS_ROOT;
  if (platform === "win32") return [];
  if (!existsSync(usersRoot)) return [];

  /** @type {string[]} */
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(usersRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= MAX_WINDOWS_PROFILES) break;
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name === "Default" || name === "Default User" || name === "All Users" || name === "Public") continue;
    scanned += 1;
    const candidate = join(usersRoot, name, ".pi", "agent", "auth.json");
    if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Candidate store paths, in priority order, without duplicates.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   usersRoot?: string,
 * }} [options]
 * @returns {string[]}
 */
export function resolveAuthPaths(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const explicit = explicitAuthPaths(env);
  if (explicit.length > 0) return dedupePaths(explicit);

  const candidates = [
    join(home, ".pi", "agent", "auth.json"),
    ...discoverWindowsAuthPaths({ platform: options.platform, usersRoot: options.usersRoot }),
  ];
  return dedupePaths(candidates.filter((path) => existsSync(path)));
}

/**
 * @param {string[]} paths
 * @returns {string[]}
 */
function dedupePaths(paths) {
  const seen = new Set();
  const out = [];
  for (const path of paths) {
    let key = path;
    try {
      key = realpathSync(path);
    } catch {
      // Keep the unresolved path when realpath fails; existsSync already ran.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Milliseconds since epoch below which we treat a stored timestamp as SECONDS.
 * Current second-epochs are ~1.8e9 and millisecond-epochs ~1.8e12, so 1e11
 * separates them with a wide margin (1e11 ms is 1973, 1e11 s is year 5138).
 */
const SECONDS_EPOCH_CEILING = 1e11;

/**
 * @param {unknown} value
 * @returns {number | null} Epoch milliseconds.
 */
function epochMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > SECONDS_EPOCH_CEILING ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return epochMs(asNumber);
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Non-reversible identity fingerprint. Used only for de-duplication.
 *
 * @param {string[]} parts
 * @returns {string}
 */
function fingerprint(parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/**
 * Normalize one raw auth.json entry into a credential.
 *
 * @param {string} provider
 * @param {Record<string, unknown>} raw
 * @param {string} source
 * @returns {PiCredential | null}
 */
export function normalizeCredential(provider, raw, source) {
  const family = FAMILY_BY_PROVIDER[provider];
  if (!family || !raw || typeof raw !== "object") return null;

  const kind = raw.type === "api_key" ? "api_key" : "oauth";
  const access = text(raw.access);
  const refresh = text(raw.refresh);
  const key = text(raw.key);
  if (!access && !refresh && !key) return null;

  const accountId = text(raw.accountId) ?? (access ? extractChatGptAccountId(access) : null);
  const email = text(raw.email) ?? (access ? extractEmail(access) : null);
  const projectId = text(raw.projectId) ?? text(raw.project_id);
  const planType = text(raw.planType) ?? (access ? extractChatGptPlanType(access) : null);
  const expiresAtMs = epochMs(raw.expires) ?? (access ? extractExpiresAtMs(access) : null);

  const secretMaterial = access ?? key ?? refresh ?? "";
  const identity = accountId ?? email ?? projectId ?? fingerprint([provider, secretMaterial]);

  return {
    provider,
    family,
    label: LABEL_BY_FAMILY[family],
    source,
    sourceKind: "pi",
    identity,
    access: access ?? undefined,
    refresh: refresh ?? undefined,
    key: key ?? undefined,
    expiresAtMs,
    accountId,
    projectId,
    email,
    planType,
    kind,
  };
}

/**
 * Parse one store file. Never throws.
 *
 * @param {string} path
 * @returns {{ credentials: PiCredential[], warnings: string[] }}
 */
export function readAuthStore(path) {
  /** @type {PiCredential[]} */
  const credentials = [];
  /** @type {string[]} */
  const warnings = [];

  let raw;
  try {
    raw = readFileSync(path, { encoding: "utf-8", flag: "r" });
  } catch (error) {
    warnings.push(`cannot read ${path}: ${redact(/** @type {{ message?: string }} */ (error)?.message)}`);
    return { credentials, warnings };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`cannot parse ${path}: invalid JSON`);
    return { credentials, warnings };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`cannot use ${path}: expected a JSON object`);
    return { credentials, warnings };
  }

  for (const [provider, entry] of Object.entries(parsed)) {
    if (!FAMILY_BY_PROVIDER[provider]) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`${path}: ${provider} entry is not an object`);
      continue;
    }
    const credential = normalizeCredential(provider, /** @type {Record<string, unknown>} */ (entry), path);
    if (credential) credentials.push(credential);
  }
  return { credentials, warnings, rawProviders: Object.keys(parsed) };
}

/**
 * Load every Pi credential from every resolvable store, de-duplicated.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   usersRoot?: string,
 *   paths?: string[],
 * }} [options]
 * @returns {PiAuthLoadResult}
 */
export function loadPiCredentials(options = {}) {
  const paths = options.paths ?? resolveAuthPaths(options);
  /** @type {PiCredential[]} */
  const credentials = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const usedPaths = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Set<string>} */
  const rawProviders = new Set();

  for (const path of paths) {
    const result = readAuthStore(path);
    warnings.push(...result.warnings);
    if (result.credentials.length > 0) usedPaths.push(path);
    for (const p of result.rawProviders ?? []) rawProviders.add(p);
    for (const credential of result.credentials) {
      const key = `${credential.family}:${credential.identity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      credentials.push(credential);
    }
  }

  credentials.sort((a, b) => a.family.localeCompare(b.family));
  return { credentials, paths: usedPaths, warnings, rawProviders: Array.from(rawProviders) };
}

/**
 * Freshness check driven by the stored expiry. Read-only: this module never
 * refreshes, because a rotated refresh token would invalidate Pi's stored copy.
 *
 * @param {PiCredential} credential
 * @param {number} [now]
 * @returns {{ fresh: boolean, expiresAtMs: number | null, expiresInMin: number | null }}
 */
export function checkFreshness(credential, now = Date.now()) {
  const expiresAtMs = credential.expiresAtMs ?? null;
  if (expiresAtMs === null) return { fresh: true, expiresAtMs: null, expiresInMin: null };
  const expiresInMin = Math.round((expiresAtMs - now) / 60000);
  return { fresh: expiresAtMs > now, expiresAtMs, expiresInMin };
}

/**
 * Sanity check used by diagnostics: confirm the store exists and is a plain file.
 *
 * @param {string} path
 * @returns {{ exists: boolean, isFile: boolean, sizeBytes: number | null }}
 */
export function describeStore(path) {
  if (!existsSync(path)) return { exists: false, isFile: false, sizeBytes: null };
  try {
    const stats = statSync(path);
    return { exists: true, isFile: stats.isFile(), sizeBytes: stats.size };
  } catch {
    return { exists: true, isFile: false, sizeBytes: null };
  }
}
