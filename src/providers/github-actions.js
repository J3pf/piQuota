/**
 * GitHub Actions monthly quota from the user's already-authenticated `gh` CLI.
 *
 * The GitHub token is never read by piQuota: requests are delegated to `gh api`,
 * which receives GH_TOKEN/GITHUB_TOKEN only through its child-process environment.
 * The provider has no Pi-store credential; the engine passes a non-secret descriptor
 * so normal provider bookkeeping can remain shared without fabricating a token.
 */

import { runCommand as defaultRunCommand } from "../exec.js";
import { buildWindow, degradedResult, windowFromSeconds } from "../model.js";
import { redact } from "../http.js";

const FAMILY = "github-actions";
const LABEL = "GitHub Actions";
const SOURCE = "gh CLI";
const DEFAULT_ORG = "KoralisSoft";
const ALLOWANCES = { free: 2000, pro: 3000, team: 3000, enterprise_cloud: 50000 };
const LINUX_MINUTES = 30 * 24 * 60 * 60;

/** @param {unknown} value */
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * Apply the shared redactor plus GitHub-specific token patterns (ghp_/gho_ and
 * fine-grained github_pat_ tokens are not part of the shared HTTP redactor yet).
 * @param {unknown} value
 * @returns {string}
 */
function safeText(value) {
  return redact(value)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, "<redacted>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "<redacted>");
}

/**
 * @param {string} path
 * @param {{ runCommand: typeof defaultRunCommand, timeoutMs: number, env: Record<string, string | undefined> }} options
 * @returns {Promise<{ ok: true, body: unknown } | { ok: false, error: string }>}
 */
async function requestGhJson(path, options) {
  let result;
  try {
    result = await options.runCommand(
      "gh",
      ["api", "-H", "Accept: application/vnd.github+json", path],
      { timeoutMs: options.timeoutMs, env: options.env },
    );
  } catch (error) {
    return { ok: false, error: `GitHub Actions could not run the gh CLI: ${safeText(error?.message ?? error)}. Install GitHub CLI from https://cli.github.com/ and try again.` };
  }

  if (result?.status === null) {
    return {
      ok: false,
      error: "GitHub Actions requires the gh CLI, but it is not installed or could not start; install it from https://cli.github.com/ and try again.",
    };
  }
  if (result?.status !== 0) {
    const detail = safeText(result?.stderr || result?.error || `gh exited with status ${result?.status ?? "unknown"}`);
    const lower = detail.toLowerCase();
    if (/\b404\b|not found/.test(lower)) {
      return {
        ok: false,
        error: `GitHub organization was not found or your account cannot access it (${detail}); verify PI_QUOTA_GITHUB_ORG and your organization membership.`,
      };
    }
    if (/\b401\b|not logged|authentication|unauthorized/.test(lower)) {
      return {
        ok: false,
        error: `GitHub gh CLI is not authenticated (${detail}); run \`gh auth login\` and confirm \`gh auth status\` succeeds.`,
      };
    }
    if (/\b403\b|forbidden|resource not accessible/.test(lower)) {
      return {
        ok: false,
        error: `GitHub denied organization billing access (${detail}); run \`gh auth refresh -h github.com -s read:org,repo,workflow\` and verify you can view the organization's billing usage.`,
      };
    }
    return {
      ok: false,
      error: `GitHub Actions gh request failed (${detail}); check \`gh auth status\`, organization membership, and billing access.`,
    };
  }

  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (stdout.trim() === "") {
    return { ok: false, error: `GitHub Actions received an empty response for ${safeText(path)}; verify gh access and retry.` };
  }
  try {
    return { ok: true, body: JSON.parse(stdout) };
  } catch {
    return { ok: false, error: `GitHub Actions received malformed JSON for ${safeText(path)}; verify gh access and update piQuota if the API response changed.` };
  }
}

/**
 * @param {unknown} items
 * @param {"Actions" | "actions"} product
 * @param {"grossQuantity" | "quantity"} quantityField
 * @returns {{ total: number, count: number } | null}
 */
function sumLinuxMinutes(items, product, quantityField) {
  if (!Array.isArray(items)) return null;
  let total = 0;
  let count = 0;
  for (const item of items) {
    const row = record(item);
    if (!row || row.product !== product || row.unitType !== "minutes") continue;
    if (typeof row.sku !== "string" || !row.sku.toLowerCase().includes("linux")) continue;
    const quantity = row[quantityField];
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) continue;
    total += quantity;
    count += 1;
  }
  return { total, count };
}

/**
 * @param {unknown} items
 * @param {string[]} repoFilter
 * @returns {Array<{ name: string, minutes: number }> | null}
 */
function repoAttributions(items, repoFilter) {
  if (!Array.isArray(items)) return null;
  const allowed = new Set(repoFilter);
  const totals = new Map();
  for (const item of items) {
    const row = record(item);
    if (!row || row.product !== "actions" || row.unitType !== "minutes") continue;
    if (typeof row.sku !== "string" || !row.sku.toLowerCase().includes("linux")) continue;
    if (typeof row.quantity !== "number" || !Number.isFinite(row.quantity) || row.quantity < 0) continue;
    if (typeof row.repositoryName !== "string" || row.repositoryName.trim() === "") continue;
    const name = safeText(row.repositoryName.trim());
    if (repoFilter.length > 0 && !allowed.has(row.repositoryName.trim())) continue;
    totals.set(name, (totals.get(name) ?? 0) + row.quantity);
  }
  return [...totals].map(([name, minutes]) => ({ name, minutes }))
    .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name));
}

/** @param {number} value */
function formatMinutes(value) {
  return String(Number.isInteger(value) ? value : Number(value.toFixed(2)));
}

/**
 * @param {number} now
 * @returns {{ at: string, inSeconds: number }}
 */
function nextMonthReset(now) {
  const current = new Date(now);
  const reset = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  return { at: reset.toISOString(), inSeconds: Math.max(0, Math.round((reset.getTime() - now) / 1000)) };
}

/**
 * @param {string} org
 * @param {{
 *   now: number,
 *   env: Record<string, string | undefined>,
 *   overrideAllowance?: number,
 *   runCommand: typeof defaultRunCommand,
 *   timeoutMs: number,
 *   repoFilter: string[],
 * }} options
 * @returns {Promise<{
 *   ok: true,
 *   org: string,
 *   plan: string | null,
 *   allowance: number,
 *   usageTotal: number,
 *   usedPercent: number,
 *   remainingPercent: number,
 *   reset: { at: string, inSeconds: number },
 *   window: { id: string, label: string },
 *   note: string,
 * } | { ok: false, error: string }>}
 */
async function fetchOrgQuota(org, { now, env, overrideAllowance, runCommand, timeoutMs, repoFilter }) {
  let allowance;
  let plan = null;
  let isUser = false;

  if (overrideAllowance !== undefined) {
    allowance = overrideAllowance;
  } else {
    let organization = await requestGhJson(`/orgs/${encodeURIComponent(org)}`, { runCommand, timeoutMs, env });
    if (!organization.ok) {
      const user = await requestGhJson(`/users/${encodeURIComponent(org)}`, { runCommand, timeoutMs, env });
      if (user.ok) {
        organization = user;
        isUser = true;
      } else {
        return { ok: false, error: organization.error };
      }
    }
    const organizationBody = record(organization.body);
    const rawPlan = record(organizationBody?.plan)?.name;
    const normalizedPlan = typeof rawPlan === "string" ? rawPlan.toLowerCase() : "";
    const planAllowance = ALLOWANCES[normalizedPlan];
    if (!planAllowance) {
      return { ok: false, error: `GitHub organization plan is missing or unsupported; set PI_QUOTA_GITHUB_ACTIONS_MINUTES to a positive monthly allowance (supported plans: free, pro, team, enterprise_cloud).` };
    }
    allowance = planAllowance;
    plan = normalizedPlan;
  }

  const encodedOrg = encodeURIComponent(org);
  const basePath = isUser ? `/users/${encodedOrg}` : `/organizations/${encodedOrg}`;
  const summary = await requestGhJson(
    `${basePath}/settings/billing/usage/summary?product=Actions`,
    { runCommand, timeoutMs, env },
  );
  if (!summary.ok) return { ok: false, error: summary.error };
  const summaryBody = record(summary.body);
  if (!summaryBody || !Array.isArray(summaryBody.usageItems)) {
    return { ok: false, error: "GitHub Actions usage summary was empty or malformed; verify organization billing access and the GitHub API response shape." };
  }
  const usage = sumLinuxMinutes(summaryBody.usageItems, "Actions", "grossQuantity");
  if (!usage) {
    return { ok: false, error: "GitHub Actions usage summary contained no Linux minute rows; verify organization billing access and the GitHub API response shape." };
  }

  const current = new Date(now);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth() + 1;
  const detailed = await requestGhJson(
    `${basePath}/settings/billing/usage?year=${year}&month=${month}`,
    { runCommand, timeoutMs, env },
  );
  if (!detailed.ok) return { ok: false, error: detailed.error };
  const detailedBody = record(detailed.body);
  if (!detailedBody || !Array.isArray(detailedBody.usageItems)) {
    return { ok: false, error: "GitHub Actions detailed usage payload was empty or malformed; verify organization billing access and the GitHub API response shape." };
  }

  const attributions = repoAttributions(detailedBody.usageItems, repoFilter);
  if (!attributions) {
    return { ok: false, error: "GitHub Actions detailed usage payload was malformed; verify organization billing access and the GitHub API response shape." };
  }

  const usedPercent = Math.min(100, Math.max(0, Math.round((usage.total / allowance) * 100 * 100) / 100));
  const remainingPercent = Math.min(100, Math.max(0, 100 - usedPercent));
  const reset = nextMonthReset(now);
  const window = windowFromSeconds(LINUX_MINUTES);
  const left = Math.max(0, allowance - usage.total);
  const multipleReposExist = attributions.length > 1;
  const topRepos = repoFilter.length > 0 || multipleReposExist
    ? attributions.slice(0, 3).map(({ name, minutes }) => `${name} ${formatMinutes(minutes)}`)
    : [];
  const note = `${formatMinutes(usage.total)} of ${formatMinutes(allowance)} min used | ${formatMinutes(left)} left${topRepos.length ? ` · ${topRepos.join(" · ")}` : ""}`;

  return {
    ok: true,
    org,
    plan,
    allowance,
    usageTotal: usage.total,
    usedPercent,
    remainingPercent,
    reset,
    window,
    note,
  };
}

/**
 * @param {unknown} credential Unused; GitHub authentication belongs to the gh CLI.
 * @param {{
 *   now?: number,
 *   env?: Record<string, string | undefined>,
 *   timeoutMs?: number,
 *   runCommand?: typeof defaultRunCommand,
 * }} [options]
 * @returns {Promise<import("../model.js").QuotaResult>}
 */
export async function fetchQuota(credential, options = {}) {
  void credential;
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const envOrgs = env.PI_QUOTA_GITHUB_ORG?.trim();
  const orgList = envOrgs
    ? envOrgs.split(",").map((s) => safeText(s.trim())).filter(Boolean)
    : [DEFAULT_ORG];
  const orgs = orgList.length > 0 ? orgList : [DEFAULT_ORG];

  const primaryOrg = orgs.join(", ");
  const base = { family: FAMILY, label: LABEL, account: primaryOrg, plan: null, source: SOURCE };
  const fail = (error) => degradedResult({ ...base, error: safeText(error), now });
  const runCommand = options.runCommand ?? defaultRunCommand;
  const timeoutMs = options.timeoutMs ?? 15_000;

  try {
    let overrideAllowance;
    const override = env.PI_QUOTA_GITHUB_ACTIONS_MINUTES;
    if (override !== undefined) {
      const numericOverride = Number(override);
      if (!Number.isFinite(numericOverride) || !Number.isInteger(numericOverride) || numericOverride <= 0) {
        return fail("PI_QUOTA_GITHUB_ACTIONS_MINUTES must be a positive finite integer; set it to a valid monthly minutes allowance.");
      }
      overrideAllowance = numericOverride;
    }

    const repoFilter = (env.PI_QUOTA_GITHUB_ACTIONS_REPOS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);

    if (orgs.length === 1) {
      const org = orgs[0];
      const res = await fetchOrgQuota(org, { now, env, overrideAllowance, runCommand, timeoutMs, repoFilter });
      if (!res.ok) return fail(res.error);
      return {
        ...base,
        account: org,
        plan: res.plan,
        windows: [buildWindow({
          id: res.window.id,
          label: res.window.label,
          usedPercent: res.usedPercent,
          remainingPercent: res.remainingPercent,
          resetsAt: res.reset.at,
          resetsInSec: res.reset.inSeconds,
          note: res.note,
          now,
        })],
        error: null,
        ok: true,
        updatedAt: new Date(now).toISOString(),
      };
    }

    const windows = [];
    const plans = [];
    const errors = [];
    for (let i = 0; i < orgs.length; i++) {
      const org = orgs[i];
      const res = await fetchOrgQuota(org, { now, env, overrideAllowance, runCommand, timeoutMs, repoFilter });
      if (!res.ok) {
        errors.push(`${org}: ${res.error}`);
        continue;
      }
      if (res.plan) plans.push(res.plan);
      const windowId = i === 0 ? "monthly" : `monthly-${org.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
      windows.push(buildWindow({
        id: windowId,
        label: `${org} monthly`,
        usedPercent: res.usedPercent,
        remainingPercent: res.remainingPercent,
        resetsAt: res.reset.at,
        resetsInSec: res.reset.inSeconds,
        note: `${org}: ${res.note}`,
        now,
      }));
    }

    if (windows.length === 0) {
      return fail(errors.join("; "));
    }

    const uniquePlans = Array.from(new Set(plans));
    return {
      ...base,
      account: orgs.join(", "),
      plan: uniquePlans.join(", ") || null,
      windows,
      error: null,
      ok: true,
      updatedAt: new Date(now).toISOString(),
    };
  } catch (error) {
    return fail(`GitHub Actions provider could not complete the gh CLI request; check gh installation, authentication, and organization billing access. ${safeText(error?.message ?? error)}`);
  }
}
