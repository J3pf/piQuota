/**
 * GitHub Actions quota tests. Every gh response is synthetic; the real gh CLI
 * is never invoked.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { collectQuota, FAMILIES } from "../src/engine.js";
import { resolveFamilies } from "../src/cli/explain.js";
import { fetchQuota } from "../src/providers/github-actions.js";
import { renderBoxWidget } from "../src/render/panel.js";
import { buildUsagePayload } from "../src/moshi/client.js";
import { githubActionsSummaryBody, githubActionsUsageBody } from "./helpers.mjs";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const FAKE_TOKEN = "ghp_FAKE_TOKEN_SHOULD_NEVER_LEAK_1234567890";

function fakeGh(options = {}) {
  const calls = [];
  const runCommand = (command, args, runOptions) => {
    calls.push({ command, args, options: runOptions });
    const path = args.at(-1);
    if (options.failure) return options.failure(path);
    if (path.startsWith("/orgs/")) {
      return {
        status: 0,
        stdout: JSON.stringify({ login: "KoralisSoft", plan: { name: options.plan ?? "free" } }),
        stderr: "",
        error: null,
      };
    }
    if (path.includes("/usage/summary")) {
      return {
        status: 0,
        stdout: JSON.stringify(options.summary ?? githubActionsSummaryBody()),
        stderr: "",
        error: null,
      };
    }
    if (path.includes("/usage?")) {
      return {
        status: 0,
        stdout: JSON.stringify(options.usage ?? githubActionsUsageBody()),
        stderr: "",
        error: null,
      };
    }
    return { status: 1, stdout: "", stderr: "unexpected gh path", error: null };
  };
  return { runCommand, calls };
}

test("GitHub Actions: derives org minutes, monthly reset and repo attribution from gh responses", async () => {
  const gh = fakeGh();
  const env = {
    GH_TOKEN: FAKE_TOKEN,
    PI_QUOTA_GITHUB_ACTIONS_REPOS: "easypets-registry-api,easypets-registry-app",
  };
  const result = await fetchQuota(null, {
    now: NOW,
    env,
    timeoutMs: 4321,
    runCommand: gh.runCommand,
  });

  assert.equal(result.ok, true);
  assert.equal(result.family, "github-actions");
  assert.equal(result.windows[0].usedPercent, 2.6);
  assert.equal(result.windows[0].remainingPercent, 97.4);
  assert.equal(result.windows[0].id, "monthly");
  assert.equal(result.windows[0].resetsAt, "2026-11-01T00:00:00.000Z");
  assert.equal(result.windows[0].resetsInSec, (Date.parse("2026-11-01T00:00:00.000Z") - NOW) / 1000);
  assert.equal(
    result.windows[0].note,
    "52 of 2000 min used | 1948 left · easypets-registry-api 52",
  );
  assert.deepEqual(gh.calls.map(({ args }) => args.at(-1)), [
    "/orgs/KoralisSoft",
    "/organizations/KoralisSoft/settings/billing/usage/summary?product=Actions",
    "/organizations/KoralisSoft/settings/billing/usage?year=2026&month=10",
  ]);
  assert.ok(gh.calls.every(({ command, args, options: runOptions }) =>
    command === "gh" &&
    args.slice(0, 3).join(" ") === "api -H Accept: application/vnd.github+json" &&
    runOptions.timeoutMs === 4321 && runOptions.env === env));
});

test("GitHub Actions: plan mapping covers every supported org plan", async () => {
  for (const [plan, allowance] of [["free", 2000], ["pro", 3000], ["team", 3000], ["enterprise_cloud", 50000]]) {
    const gh = fakeGh({ plan });
    const result = await fetchQuota(null, { now: NOW, env: {}, runCommand: gh.runCommand });
    assert.equal(result.ok, true, `plan ${plan}`);
    assert.match(result.windows[0].note ?? "", new RegExp(`52 of ${allowance} min used`));
  }
});

test("GitHub Actions: a valid minutes override wins without resolving the plan", async () => {
  const gh = fakeGh({ plan: "unknown" });
  const result = await fetchQuota(null, {
    now: NOW,
    env: { PI_QUOTA_GITHUB_ACTIONS_MINUTES: "3000" },
    runCommand: gh.runCommand,
  });
  assert.equal(result.ok, true);
  assert.equal(result.windows[0].usedPercent, 1.73);
  assert.match(result.windows[0].note ?? "", /52 of 3000 min used \| 2948 left/);
  assert.equal(gh.calls.some(({ args }) => args.at(-1).startsWith("/orgs/")), false);
});

test("GitHub Actions: an unknown plan degrades with the override setting named", async () => {
  const gh = fakeGh({ plan: "starter" });
  const result = await fetchQuota(null, { now: NOW, env: {}, runCommand: gh.runCommand });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /PI_QUOTA_GITHUB_ACTIONS_MINUTES/);
});

test("GitHub Actions: non-positive, fractional and malformed overrides degrade instead of guessing", async () => {
  for (const override of ["0", "-1", "3.14", "not-a-number"]) {
    const gh = fakeGh();
    const result = await fetchQuota(null, {
      now: NOW,
      env: { PI_QUOTA_GITHUB_ACTIONS_MINUTES: override },
      runCommand: gh.runCommand,
    });
    assert.equal(result.ok, false, `override ${override} should degrade`);
    assert.match(result.error ?? "", /PI_QUOTA_GITHUB_ACTIONS_MINUTES/);
    assert.equal(gh.calls.length, 0);
  }
});

test("GitHub Actions: default runs omit it, while the flag and explicit family selection include it", async () => {
  const common = {
    paths: [],
    claudeCodePaths: [],
    now: NOW,
    env: {},
    stores: [],
    allowBrowser: false,
  };
  const disabledGh = fakeGh();
  const disabled = await collectQuota({ ...common, families: FAMILIES, runCommand: disabledGh.runCommand });
  const legacy = await collectQuota({ ...common, families: FAMILIES.filter((family) => family !== "github-actions") });
  assert.equal(disabled.providers.some((provider) => provider.family === "github-actions"), false);
  assert.deepEqual(disabled.providers, legacy.providers, "default provider results remain byte-equivalent to the previous family set");
  assert.equal(disabledGh.calls.length, 0);

  const flagGh = fakeGh();
  const enabled = await collectQuota({
    ...common,
    families: FAMILIES,
    env: { PI_QUOTA_GITHUB_ACTIONS: "yes", PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000" },
    runCommand: flagGh.runCommand,
  });
  assert.equal(enabled.providers.some((provider) => provider.family === "github-actions"), true);

  const selected = resolveFamilies(["github-actions"]);
  assert.deepEqual(selected, { families: ["github-actions"], unknown: [], explicit: true });
  const explicitGh = fakeGh();
  const copiedFamilies = [...selected.families];
  const explicit = await collectQuota({
    ...common,
    families: copiedFamilies,
    explicit: selected.explicit,
    env: { PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000" },
    runCommand: explicitGh.runCommand,
  });
  assert.equal(explicit.providers.some((provider) => provider.family === "github-actions"), true);
});

test("GitHub Actions: a missing gh executable explains how to install it", async () => {
  const gh = fakeGh({ failure: () => ({ status: null, stdout: "", stderr: "", error: "ENOENT" }) });
  const result = await fetchQuota(null, {
    now: NOW,
    env: { PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000" },
    runCommand: gh.runCommand,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /gh CLI/);
  assert.match(result.error ?? "", /https:\/\/cli\.github\.com/);
});

test("GitHub Actions: missing gh authentication gives a login hint", async () => {
  const gh = fakeGh({
    failure: () => ({ status: 1, stdout: "", stderr: "gh: not logged in", error: null }),
  });
  const result = await fetchQuota(null, {
    now: NOW,
    env: { PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000" },
    runCommand: gh.runCommand,
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /gh auth login/);
});

test("GitHub Actions: an unknown or inaccessible organization is actionable", async () => {
  const gh = fakeGh({
    failure: (path) => path.startsWith("/orgs/")
      ? { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)", error: null }
      : { status: 1, stdout: "", stderr: "unexpected request", error: null },
  });
  const result = await fetchQuota(null, { now: NOW, env: {}, runCommand: gh.runCommand });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /not found|access/i);
  assert.match(result.error ?? "", /PI_QUOTA_GITHUB_ORG/);
});

test("GitHub Actions: billing access denial explains the required permissions", async () => {
  const gh = fakeGh({
    failure: (path) => path.startsWith("/orgs/")
      ? { status: 0, stdout: JSON.stringify({ plan: { name: "free" } }), stderr: "", error: null }
      : { status: 1, stdout: "", stderr: "HTTP 403: Resource not accessible", error: null },
  });
  const result = await fetchQuota(null, { now: NOW, env: {}, runCommand: gh.runCommand });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /403/);
  assert.match(result.error ?? "", /read:org|billing access/i);
});

test("GitHub Actions: zero Linux minutes is a healthy full allowance for empty and storage-only summaries", async () => {
  for (const usageItems of [
    [],
    [{ product: "Actions", sku: "actions_storage", grossQuantity: 999, unitType: "gigabyte-hours" }],
  ]) {
    const gh = fakeGh({ summary: { usageItems } });
    const result = await fetchQuota(null, { now: NOW, env: {}, runCommand: gh.runCommand });

    assert.equal(result.ok, true);
    assert.equal(result.windows[0].usedPercent, 0);
    assert.equal(result.windows[0].remainingPercent, 100);
    assert.equal(result.windows[0].note, "0 of 2000 min used | 2000 left");
  }
});

test("GitHub Actions: malformed usage payload shapes degrade with an API-shape hint", async () => {
  for (const stdout of ["not json", "", "[]", "null", "{}", JSON.stringify({ usageItems: null })]) { 
    const gh = fakeGh({
      failure: (path) => {
        if (path.startsWith("/orgs/")) {
          return { status: 0, stdout: JSON.stringify({ plan: { name: "free" } }), stderr: "", error: null };
        }
        if (path.includes("/usage/summary")) return { status: 0, stdout, stderr: "", error: null };
        return { status: 0, stdout: JSON.stringify(githubActionsUsageBody()), stderr: "", error: null };
      },
    });
    const result = await fetchQuota(null, { now: NOW, env: {}, runCommand: gh.runCommand });
    assert.equal(result.ok, false, `payload ${JSON.stringify(stdout)} should degrade`);
    assert.match(result.error ?? "", /usage|payload|response/i);
  }
});

test("GitHub Actions: multiple repo attributions are ranked and capped at three", async () => {
  const usage = githubActionsUsageBody([
    { product: "actions", sku: "actions_linux", quantity: 10, unitType: "minutes", repositoryName: "repo-a" },
    { product: "actions", sku: "actions_linux", quantity: 25, unitType: "minutes", repositoryName: "repo-b" },
    { product: "actions", sku: "actions_linux", quantity: 15, unitType: "minutes", repositoryName: "repo-c" },
    { product: "actions", sku: "actions_linux", quantity: 7, unitType: "minutes", repositoryName: "repo-d" },
    { product: "actions", sku: "actions_linux", quantity: 5, unitType: "minutes", repositoryName: "repo-b" },
  ]);
  const gh = fakeGh({ usage });
  const result = await fetchQuota(null, { now: NOW, env: {}, runCommand: gh.runCommand });
  assert.equal(result.ok, true);
  assert.match(result.windows[0].note ?? "", /repo-b 30 · repo-c 15 · repo-a 10/);
  assert.equal(result.windows[0].note?.includes("repo-d"), false);
});

test("GitHub Actions: repo attribution is filtered client-side and names are sanitized", async () => {
  const usage = githubActionsUsageBody([
    { product: "actions", sku: "actions_linux", quantity: 52, unitType: "minutes", repositoryName: "easypets-registry-api" },
    { product: "actions", sku: "actions_linux", quantity: 900, unitType: "minutes", repositoryName: "another-repo" },
    { product: "actions", sku: "actions_linux", quantity: 12, unitType: "minutes", repositoryName: FAKE_TOKEN },
  ]);
  const gh = fakeGh({ usage });
  const serialized = JSON.stringify(await fetchQuota(null, {
    now: NOW,
    env: {
      GH_TOKEN: FAKE_TOKEN,
      PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000",
      PI_QUOTA_GITHUB_ACTIONS_REPOS: "easypets-registry-api",
    },
    runCommand: gh.runCommand,
  }));
  assert.equal(serialized.includes(FAKE_TOKEN), false);
  assert.equal(serialized.includes("another-repo"), false);
  assert.ok(gh.calls.every(({ args }) => !args.at(-1).includes("repository=")));
});

test("GitHub Actions: terminal box and Moshi payload expose the family only when present", () => {
  const paint = (_key, text) => text;
  const absent = renderBoxWidget([], paint, 100).join("\\n");
  assert.equal(absent.includes("GH Actions"), false);
  const provider = {
    family: "github-actions",
    label: "GitHub Actions",
    account: "KoralisSoft",
    plan: "free",
    windows: [{
      id: "monthly",
      label: "Monthly window",
      usedPercent: 2.6,
      remainingPercent: 97.4,
      resetsAt: "2026-11-01T00:00:00.000Z",
      resetsInSec: 2_376_000,
      windowSeconds: null,
      note: "52 of 2000 min used | 1948 left",
    }],
    ok: true,
    error: null,
    notConfigured: false,
    primaryWindowId: "monthly",
  };
  const box = renderBoxWidget([provider], paint, 100).join("\\n");
  assert.match(box, /GH Actions/);
  const payload = buildUsagePayload({ generatedAt: "2026-10-04T12:00:00.000Z", providers: [provider] });
  assert.equal(payload.snapshots[0].accountId, "pi:github-actions");
  assert.equal(payload.snapshots[0].accountLabel, "GitHub Actions");
  assert.equal(payload.snapshots[0].windows[0].label, "monthly");
});

test("GitHub Actions: thrown runners and failed commands never throw from the provider", async () => {
  const result = await fetchQuota(null, {
    now: NOW,
    env: { PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000" },
    runCommand: () => { throw new Error(`runner failed ${FAKE_TOKEN}`); },
  });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(FAKE_TOKEN), false);
  assert.match(result.error ?? "", /runner|command|gh/i);
});
