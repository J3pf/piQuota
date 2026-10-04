/**
 * Family aliases, family resolution and diagnostic explain formatting.
 */

import { describeClaudeCodeSource } from "../auth/claude-code-auth.js";
import { describeStore, loadPiCredentials, resolveAuthPaths } from "../auth/pi-auth.js";
import { describeCache, resolveCachePath } from "../cache.js";
import { FAMILIES } from "../engine.js";
import { redact } from "../http.js";
import { resolveCookie } from "../opencode/session.js";

export const FAMILY_ALIASES = {
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  "openai-codex": "codex",
  chatgpt: "codex",
  antigravity: "antigravity",
  google: "antigravity",
  agy: "antigravity",
  "opencode-go": "opencode-go",
  opencode: "opencode-go",
  go: "opencode-go",
  zen: "opencode-go",
  "github-actions": "github-actions",
  gh: "github-actions",
  actions: "github-actions",
};

/**
 * @param {string[]} positionals
 * @returns {{ families: string[], unknown: string[], explicit: boolean }}
 */
export function resolveFamilies(positionals) {
  /** @type {string[]} */
  const families = [];
  /** @type {string[]} */
  const unknown = [];
  for (const positional of positionals) {
    if (positional === "all") continue;
    const family = FAMILY_ALIASES[positional.toLowerCase()];
    if (!family) {
      unknown.push(positional);
      continue;
    }
    if (!families.includes(family)) families.push(family);
  }
  return { families, unknown, explicit: families.length > 0 };
}

/**
 * @param {string[]} families
 * @returns {string[]}
 */
export function explainLines(families) {
  const paths = resolveAuthPaths({});
  const lines = ["", "Credential resolution:"];
  if (paths.length === 0) {
    lines.push("  no Pi auth store found (looked for $PI_AUTH_PATH, ~/.pi/agent/auth.json, /mnt/c/Users/*/.pi/agent/auth.json)");
  }
  for (const path of paths) {
    const store = describeStore(path);
    lines.push(`  store  ${path}  exists=${store.exists} file=${store.isFile} bytes=${store.sizeBytes ?? "?"}`);
  }

  const loaded = loadPiCredentials({});
  const counts = new Map();
  for (const credential of loaded.credentials) counts.set(credential.family, (counts.get(credential.family) ?? 0) + 1);
  lines.push("  credentials: " + FAMILIES.map((family) => `${family}=${counts.get(family) ?? 0}`).join(" "));
  lines.push("  fields read from auth.json: type, access, refresh, expires, accountId, projectId, email, key");
  lines.push("  derived from the Codex JWT (payload only): chatgpt_account_id, chatgpt_plan_type, email");

  const cookie = resolveCookie({});
  lines.push(`  opencode.ai cookie: ${cookie.found ? `found via ${cookie.origin} (${cookie.detail})` : `not found (${cookie.detail})`}`);
  // Claude has two sources, and which one is in use is the single most useful
  // diagnostic for a provider that answers 400 or "not configured".
  const claudeCode = describeClaudeCodeSource({});
  lines.push("");
  lines.push("Claude source resolution:");
  lines.push(`  preference: ${process.env.PI_QUOTA_CLAUDE_SOURCE ?? "auto"} (auto prefers the Claude Code CLI)`);
  lines.push(`  Claude Code store: ${claudeCode.path ?? "none found"}`);
  if (claudeCode.path) {
    lines.push(
      `    access token: ${claudeCode.hasAccessToken ? "yes" : "no"}` +
        ` · refresh token present: ${claudeCode.hasRefreshToken ? "yes (never read, never used)" : "no"}` +
        ` · expires in: ${claudeCode.expiresInMin === null ? "unknown" : `${claudeCode.expiresInMin}m`}` +
        ` · plan: ${claudeCode.plan ?? "unknown"}`,
    );
  } else if (claudeCode.error) {
    lines.push(`    ${redact(claudeCode.error)}`);
  }
  lines.push("  fields read from that store: claudeAiOauth.accessToken, expiresAt, subscriptionType, rateLimitTier");
  lines.push("  never read from that store: the refresh token value, and nothing is ever written back");
  lines.push(`  cache: ${resolveCachePath({})} (${describeCache({}).exists ? "present" : "absent"})`);
  lines.push(`  families requested: ${families.join(", ")}`);
  for (const warning of loaded.warnings) lines.push(`  warn: ${redact(warning)}`);
  lines.push("");
  return lines;
}
