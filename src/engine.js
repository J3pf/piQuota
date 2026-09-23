/**
 * Quota collection engine.
 *
 * Loads Pi credentials (read-only), asks each provider for its windows and
 * returns one normalized report. Providers never throw: a failure becomes a
 * degraded result with an actionable message.
 */

import { checkFreshness, LABEL_BY_FAMILY, loadPiCredentials, resolveAuthPaths } from "./auth/pi-auth.js";
import { loadClaudeCodeCredential } from "./auth/claude-code-auth.js";
import { degradedResult, displayIdentity, selectPrimaryWindow } from "./model.js";
import { backoffState, clearBackoff, isAuthFailure, isThrottled, recordBackoff, retryAfterFromError } from "./providers/backoff.js";
import { fetchQuota as fetchClaude } from "./providers/claude.js";
import { fetchQuota as fetchCodex } from "./providers/codex.js";
import { fetchQuota as fetchAntigravity } from "./providers/antigravity.js";
import { fetchQuota as fetchOpenCodeGo } from "./providers/opencode-go.js";

/** Canonical family order used by every surface. */
export const FAMILIES = ["claude", "codex", "antigravity", "opencode-go"];

/**
 * Claude has two possible sources, and a user may have either or both.
 *
 * `auto` prefers the Claude Code CLI, because the plugin that drives it is what a
 * user reaches for when Pi's own `anthropic` token cannot serve requests. The
 * choice is a preference, never a fallback: only the selected source is tried, so
 * a broken preferred source is reported instead of silently masked by the other.
 */
export const CLAUDE_SOURCE_MODES = ["auto", "claude-code", "pi"];

/**
 * @param {unknown} value
 * @returns {"auto" | "claude-code" | "pi"}
 */
export function normalizeClaudeSourceMode(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "claude-code" || text === "claude" || text === "cli") return "claude-code";
  if (text === "pi" || text === "anthropic" || text === "oauth") return "pi";
  return "auto";
}

/**
 * Pick the Claude credential set for this run.
 *
 * @param {{
 *   credentials: import("./auth/pi-auth.js").PiCredential[],
 *   env: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   usersRoot?: string,
 *   claudeCodePaths?: string[] | null,
 * }} input
 * @returns {{ credentials: import("./auth/pi-auth.js").PiCredential[], mode: string, unavailable: string | null, claudeCodePaths: string[] }}
 */
export function resolveClaudeCredentials(input) {
  const mode = normalizeClaudeSourceMode(input.env.PI_QUOTA_CLAUDE_SOURCE);
  const fromPi = input.credentials.filter((credential) => credential.family === "claude");
  const claudeCodePaths = input.claudeCodePaths === undefined ? undefined : input.claudeCodePaths;

  if (mode === "pi") return { credentials: fromPi, mode, unavailable: null, claudeCodePaths: claudeCodePaths ?? [], recoveredLock: null };

  const claudeCode = loadClaudeCodeCredential({
    env: input.env,
    home: input.home,
    platform: input.platform,
    usersRoot: input.usersRoot,
    paths: claudeCodePaths ?? undefined,
    now: input.now,
  });

  if (claudeCode.ok) {
    return {
      credentials: [claudeCode.credential],
      mode: "claude-code",
      unavailable: null,
      claudeCodePaths: claudeCode.paths,
      recoveredLock: claudeCode.recoveredLock ?? null,
    };
  }
  if (mode === "claude-code") {
    return {
      credentials: [],
      mode,
      unavailable: claudeCode.error,
      claudeCodePaths: claudeCode.paths,
      recoveredLock: claudeCode.recoveredLock ?? null,
    };
  }
  return {
    credentials: fromPi,
    mode: "pi",
    unavailable: null,
    claudeCodePaths: claudeCode.paths,
    recoveredLock: claudeCode.recoveredLock ?? null,
  };
}

/** @type {Record<string, (credential: any, options?: any) => Promise<import("./model.js").QuotaResult>>} */
const PROVIDERS = {
  claude: fetchClaude,
  codex: fetchCodex,
  antigravity: fetchAntigravity,
  "opencode-go": fetchOpenCodeGo,
};

/**
 * @typedef {Object} PiQuotaReport
 * @property {string} engine
 * @property {number} schemaVersion
 * @property {true} readOnly
 * @property {string} generatedAt
 * @property {string[]} sources               Pi auth stores that were read.
 * @property {string[]} warnings
 * @property {import("./model.js").QuotaResult[]} providers   Flattened, family-ordered.
 * @property {Record<string, import("./model.js").QuotaResult[]>} byFamily
 */

/**
 * @param {{
 *   families?: string[],
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   platform?: string,
 *   usersRoot?: string,
 *   paths?: string[],
 *   now?: number,
 *   fetchFn?: typeof fetch,
 *   timeoutMs?: number,
 *   refresh?: boolean,
 *   force?: boolean,
 *   stores?: import("./browser/cookies.js").CookieStore[],
 *   allowBrowser?: boolean,
 *   claudeCodePaths?: string[] | null,
 * }} [options]
 * @returns {Promise<PiQuotaReport>}
 */
export async function collectQuota(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const families = options.families ?? FAMILIES;

  const loaded = loadPiCredentials({
    env,
    home: options.home,
    platform: options.platform,
    usersRoot: options.usersRoot,
    paths: options.paths,
  });

  // Claude is the one family with a second, non-Pi source, so it is resolved
  // before the per-family loop and then treated exactly like any other credential.
  const claude = resolveClaudeCredentials({
    credentials: loaded.credentials,
    env,
    home: options.home,
    platform: options.platform,
    usersRoot: options.usersRoot,
    claudeCodePaths: options.claudeCodePaths,
  });

  /**
   * @param {string} family
   * @returns {import("./auth/pi-auth.js").PiCredential[]}
   */
  const credentialsFor = (family) =>
    family === "claude" ? claude.credentials : loaded.credentials.filter((credential) => credential.family === family);

  /** @type {Record<string, import("./model.js").QuotaResult[]>} */
  const byFamily = {};
  /** @type {string[]} */
  const warnings = [...loaded.warnings];
  if (claude.recoveredLock) {
    warnings.push(
      `claude: removed abandoned OAuth refresh lock (${Math.round((claude.recoveredLock.ageMs ?? 0) / 1000)}s old) at ${claude.recoveredLock.lockPath}`,
    );
  }

  await Promise.all(
    families.map(async (family) => {
      const credentials = credentialsFor(family);
      if (credentials.length === 0) {
        // `notConfigured` is stated rather than inferred: the message now names a
        // second source, and every renderer keys off this flag to avoid painting a
        // failure icon for a provider the user simply does not use.
        byFamily[family] = [
          degradedResult({
            family,
            label: LABEL_BY_FAMILY[family] ?? family,
            error: claude.unavailable && family === "claude" ? claude.unavailable : missingCredentialMessage(family),
            notConfigured: true,
            source: loaded.paths[0] ?? resolveAuthPaths({ env, home: options.home })[0] ?? "~/.pi/agent/auth.json",
            now,
          }),
        ];
        return;
      }

      // A family that is currently throttled is skipped entirely, so the
      // caller's sticky layer can republish the previous good snapshot instead
      // of adding more pressure to a rate-limited endpoint.
      //
      // Authentication failures supersede throttling: if any credential for this
      // family is already known to be expired, waiting out a rate limit is useless
      // and misleading. We clear backoff immediately so the auth failure surfaces.
      const hasExpiredToken = credentials.some((credential) => {
        const freshness = checkFreshness(credential, now);
        return !freshness.fresh;
      });
      if (hasExpiredToken || options.force) {
        clearBackoff(family, { env, home: options.home });
      }

      const throttle = backoffState(family, { now, env, home: options.home });
      if (throttle.active && !options.force) {
        byFamily[family] = [
          degradedResult({
            family,
            label: LABEL_BY_FAMILY[family] ?? family,
            // Keep the identity visible while paused: "unknown" on screen is
            // worse than a stale-but-labelled account.
            account: displayIdentity(credentials[0]),
            error: `backing off after a throttle: next attempt in ${throttle.secondsLeft}s`,
            source: credentials[0].source,
            now,
          }),
        ];
        return;
      }

      /** @type {import("./model.js").QuotaResult[]} */
      const results = [];
      for (const credential of credentials) {
        const freshness = checkFreshness(credential, now);
        if (!freshness.fresh) {
          warnings.push(
            `${family}: the ${expiredTokenName(credential)} expired ${Math.abs(freshness.expiresInMin ?? 0)}m ago; ${refreshHint(credential)}`,
          );
        }
        const fetchQuota = PROVIDERS[family];
        try {
          const result = await fetchQuota(credential, {
            now,
            fetchFn: options.fetchFn,
            timeoutMs: options.timeoutMs,
            expiresInMin: freshness.expiresInMin,
            env,
            home: options.home,
            refresh: options.refresh,
            stores: options.stores,
            allowBrowser: options.allowBrowser,
          });
          if (isThrottled(result.error)) {
            const seconds = recordBackoff(family, {
              retryAfterSec: retryAfterFromError(result.error),
              now,
              env,
              home: options.home,
            }).seconds;
            warnings.push(`${family}: throttled upstream; pausing that family for ${seconds}s`);
          } else if (result.ok || isAuthFailure(result.error)) {
            clearBackoff(family, { env, home: options.home });
          }
          results.push(result);
        } catch (error) {
          // A provider must never take the whole report down.
          results.push(
            degradedResult({
              family,
              label: credential.label,
              account: credential.email ?? credential.accountId ?? "unknown",
              error: `provider crashed: ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`,
              source: credential.source,
              now,
              expiresInMin: freshness.expiresInMin,
            }),
          );
        }
      }
      byFamily[family] = results;
    }),
  );

  const providers = families.flatMap((family) => byFamily[family] ?? []);

  // Stamp the primary window so the terminal, the Pi TUI and the Moshi adapter
  // all agree on which window represents a provider, with no duplicated rules.
  for (const provider of providers) {
    provider.primaryWindowId = selectPrimaryWindow(provider.windows ?? [])?.id ?? null;
  }

  return {
    engine: "pi-quota",
    schemaVersion: 1,
    readOnly: true,
    generatedAt: new Date(now).toISOString(),
    sources: loaded.paths,
    // Named so `piquota --explain` can state which Claude source was chosen and
    // every surface agrees, instead of each one guessing.
    claudeSource: { mode: claude.mode, paths: claude.claudeCodePaths, unavailable: claude.unavailable },
    warnings,
    providers,
    byFamily,
  };
}

/**
 * @param {string} family
 * @returns {string}
 */
function missingCredentialMessage(family) {
  return family === "claude"
    ? "no claude credential in the Pi store or from the Claude Code CLI"
    : `no ${family} credential in the Pi store`;
}

/**
 * @param {{ sourceKind?: string }} credential
 * @returns {string}
 */
function expiredTokenName(credential) {
  return credential.sourceKind === "claude-code" ? "Claude Code token" : "Pi token";
}

/**
 * @param {{ sourceKind?: string }} credential
 * @returns {string}
 */
function refreshHint(credential) {
  return credential.sourceKind === "claude-code"
    ? "run `claude` once to refresh it"
    : "use that provider in Pi to refresh it";
}

/**
 * Convenience accessor used by the renderers.
 *
 * @param {PiQuotaReport} report
 * @returns {import("./model.js").QuotaResult | null}
 */
export function firstForFamily(report, family) {
  return report.byFamily[family]?.[0] ?? null;
}
