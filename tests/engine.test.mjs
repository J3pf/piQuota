/**
 * Engine, cache and Moshi-artifact tests.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { collectQuota } from "../src/engine.js";
import { clearCache, readCache, withCache, writeCache } from "../src/cache.js";
import {
  antigravityUsageBody,
  claudeUsageBody,
  codexUsageBody,
  githubActionsSummaryBody,
  githubActionsUsageBody,
  jsonResponse,
  routedFetch,
} from "./helpers.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-auth.json", import.meta.url));
const NOW = 1_800_000_000_000;

function fullRoutes() {
  return routedFetch([
    ["api.anthropic.com", () => jsonResponse(claudeUsageBody())],
    ["chatgpt.com", () => jsonResponse(codexUsageBody())],
    ["cloudcode", () => jsonResponse(antigravityUsageBody())],
    ["opencode.ai/zen", () => jsonResponse({ object: "list", data: [{ id: "m1" }, { id: "m2" }] })],
  ]);
}

test("collectQuota reports all five registered families when GitHub Actions is enabled", async () => {
  const { fetchFn } = fullRoutes();
  const runCommand = (_command, args) => {
    const path = args.at(-1);
    const body = path.startsWith("/orgs/")
      ? { login: "KoralisSoft", plan: { name: "free" } }
      : path.includes("/usage/summary")
        ? githubActionsSummaryBody()
        : githubActionsUsageBody();
    return { status: 0, stdout: JSON.stringify(body), stderr: "", error: null };
  };
  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    runCommand,
    env: { PI_QUOTA_GITHUB_ACTIONS: "1", PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000" },
    stores: [],
    allowBrowser: false,
  });

  assert.deepEqual(Object.keys(report.byFamily).sort(), ["antigravity", "claude", "codex", "github-actions", "opencode-go"]);
  assert.equal(report.readOnly, true);
  assert.equal(report.schemaVersion, 1);

  const byFamily = Object.fromEntries(report.providers.map((provider) => [provider.family, provider]));
  assert.equal(byFamily.claude.ok, true);
  assert.equal(byFamily.codex.ok, true);
  assert.equal(byFamily.codex.plan, "plus");
  assert.equal(byFamily.antigravity.ok, true);
  assert.equal(byFamily["opencode-go"].ok, false);
  assert.match(byFamily["opencode-go"].error ?? "", /piquota auth opencode/);
  assert.equal(byFamily["github-actions"].ok, true);
});

test("collectQuota marks a family with no credential as degraded, not missing", async () => {
  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, families: ["claude", "grok"], env: {}, stores: [], allowBrowser: false });
  assert.equal(report.providers.length, 2);
  const grok = report.providers.find((provider) => provider.family === "grok");
  assert.ok(grok);
  assert.equal(grok.ok, false);
  assert.match(grok.error ?? "", /no grok credential/);
});

test("collectQuota provides actionable diagnosis when Pi store has openai API instead of openai-codex", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-openai-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    openai: { type: "oauth", access: "fake-access" }
  }));

  const report = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, families: ["codex"], env: {}, stores: [], allowBrowser: false });
  assert.equal(report.providers.length, 1);
  assert.equal(report.providers[0].family, "codex");
  assert.equal(report.providers[0].notConfigured, true);
  assert.match(report.providers[0].error ?? "", /found 'openai' API; run \/login openai-codex in Pi/);

  writeFileSync(authPath, JSON.stringify({
    openai: { type: "oauth", access: "fake-access", clientId: "dyn-1", scopes: ["chatgpt.tokens.use.direct"] },
    "github-copilot": { type: "oauth", refresh: "ghu_FAKE_TOKEN", access: "tid=1" },
    openrouter: { type: "api_key", key: "sk-or-fake" },
  }));
  const { fetchFn } = routedFetch([
    [
      "api.github.com/copilot_internal/user",
      () =>
        jsonResponse({
          copilot_plan: "individual_pro",
          quota_reset_date: "2028-02-01T00:00:00.000Z",
          quota_snapshots: {
            premium_interactions: { entitlement: 300, remaining: 210, percent_remaining: 70 },
          },
        }),
    ],
    [
      "openrouter.ai/api/v1/key",
      () =>
        jsonResponse({
          data: { label: "or-main", limit: 20, limit_remaining: 15, usage: 5, is_free_tier: false },
        }),
    ],
  ]);
  const chatGptReport = await collectQuota({ paths: [authPath], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  const codexEntry = chatGptReport.providers.find((p) => p.family === "codex");
  assert.match(codexEntry?.error ?? "", /Sign in with ChatGPT OAuth without wham\/usage claims/);
  const copilotEntry = chatGptReport.providers.find((p) => p.family === "copilot");
  assert.equal(copilotEntry?.ok, true, "auto-discovers github-copilot from auth.json");
  assert.equal(copilotEntry?.windows[0]?.usedPercent, 30);
  const openrouterEntry = chatGptReport.providers.find((p) => p.family === "openrouter");
  assert.equal(openrouterEntry?.ok, true, "auto-discovers openrouter from auth.json");
  assert.equal(openrouterEntry?.windows[0]?.usedPercent, 25);
});

test("a crashing provider degrades instead of taking the report down", async () => {
  const fetchFn = /** @type {typeof fetch} */ (async () => {
    throw new Error("socket exploded");
  });
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, families: ["codex"], env: {}, stores: [], allowBrowser: false });
  assert.equal(report.providers.length, 1);
  assert.equal(report.providers[0].ok, false);
});

test("the normalized report never contains token material", async () => {
  const { fetchFn } = fullRoutes();
  const githubSecret = "ghp_FAKE_ENGINE_GITHUB_TOKEN_0123456789";
  const runCommand = (_command, args) => {
    const path = args.at(-1);
    const body = path.includes("/usage/summary")
      ? { ...githubActionsSummaryBody(), debugToken: githubSecret }
      : githubActionsUsageBody([
          { product: "actions", sku: "actions_linux", quantity: 52, unitType: "minutes", repositoryName: githubSecret },
        ]);
    return { status: 0, stdout: JSON.stringify(body), stderr: "", error: null };
  };
  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    runCommand,
    env: {
      PI_QUOTA_GITHUB_ACTIONS: "on",
      PI_QUOTA_GITHUB_ACTIONS_MINUTES: "2000",
      GITHUB_TOKEN: githubSecret,
    },
    stores: [],
    allowBrowser: false,
  });
  const serialized = JSON.stringify(report);
  for (const secret of ["sk-ant-oat01", "ya29.", "1//FAKE", "rt.1.FAKE", "sk-FAKE-zen", "fixture-signature", githubSecret]) {
    assert.equal(serialized.includes(secret), false, `report leaked ${secret}`);
  }
});

test("cache round-trips, respects the TTL and stores no secrets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });

  assert.equal(writeCache(report, { path, now: NOW }).ok, true);
  const hit = readCache({ path, now: NOW + 1000, ttlMs: 60_000 });
  assert.ok(hit);
  assert.equal(hit.report.providers.length, report.providers.length);

  assert.equal(readCache({ path, now: NOW + 61_000, ttlMs: 60_000 }), null);

  const raw = readFileSync(path, "utf-8");
  assert.equal(raw.includes("sk-ant-oat01"), false);
  assert.equal(raw.includes("fixture-signature"), false);
  assert.equal(clearCache({ path }).removed, true);
  assert.equal(readCache({ path }), null);
});

test("withCache refreshes once and then serves the cached copy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  };

  const first = await withCache({ path, now: NOW, ttlMs: 60_000 }, loader);
  assert.equal(first.cached, false);
  const second = await withCache({ path, now: NOW + 5000, ttlMs: 60_000 }, loader);
  assert.equal(second.cached, true);
  assert.equal(loads, 1);
  const third = await withCache({ path, now: NOW + 5000, ttlMs: 60_000, force: true }, loader);
  assert.equal(third.cached, false);
  assert.equal(loads, 2);
});

test("withCache merges a partial family query without poisoning the full cache", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-quota-cache-partial-"));
  const path = join(directory, "usage.json");
  const { fetchFn } = fullRoutes();

  const fullReport = await collectQuota({ paths: [FIXTURE], claudeCodePaths: [], now: NOW, fetchFn, env: {}, stores: [], allowBrowser: false });
  writeCache(fullReport, { path, now: NOW });
  assert.equal(readCache({ path, now: NOW }).report.providers.length, 4);

  const partial = await withCache(
    { path, now: NOW + 1000, ttlMs: 60_000, families: ["codex"] },
    async () => collectQuota({ paths: [FIXTURE], claudeCodePaths: [], families: ["codex"], now: NOW + 1000, fetchFn, env: {}, stores: [], allowBrowser: false }),
  );
  assert.deepEqual(partial.report.providers.map((p) => p.family), ["codex"]);

  const cachedFull = readCache({ path, now: NOW + 1000 });
  assert.equal(cachedFull.report.providers.length, 4);
  assert.deepEqual(Object.keys(cachedFull.report.byFamily).sort(), ["antigravity", "claude", "codex", "opencode-go"]);
});

test("the terminal surface also shows last known values while a provider is throttled", async () => {
  const { mergeLastGood } = await import("../src/sticky.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-cli-lastgood-"));
  const NOW = 1_800_000_000_000;

  const healthy = {
    engine: "pi-quota", schemaVersion: 1, readOnly: true, generatedAt: new Date(NOW).toISOString(),
    sources: [], warnings: [],
    providers: [{ family: "claude", label: "Claude (Pi)", account: "fixture@example.com", plan: null,
      windows: [{ id: "5h", label: "5h window", usedPercent: 4, remainingPercent: 96, resetsAt: null,
        resetsInSec: 3600, windowSeconds: null, note: null }],
      error: null, ok: true, updatedAt: new Date(NOW).toISOString(), source: "/tmp/auth.json", expiresInMin: 60 }],
    byFamily: {},
  };
  healthy.byFamily = { claude: healthy.providers };

  mergeLastGood(healthy, { env: {}, home: dir, now: NOW });

  const throttled = {
    ...healthy,
    providers: [{ ...healthy.providers[0], ok: false, windows: [], error: "backing off after a throttle: next attempt in 120s" }],
  };
  throttled.byFamily = { claude: throttled.providers };

  const { report } = mergeLastGood(throttled, { env: {}, home: dir, now: NOW + 60_000 });
  assert.equal(report.providers[0].ok, true, "the terminal must not show n/a while merely throttled");
  assert.equal(report.providers[0].windows[0].remainingPercent, 96);
  assert.match(report.providers[0].note ?? "", /last known values, 1 min old/);
});

test("the Claude Code CLI source wins over Pi's own anthropic entry when both exist", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-claude-code", expiresAt: NOW + 3_600_000, subscriptionType: "max" } }),
  );

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  const claude = report.providers[0];
  assert.equal(claude.ok, true);
  assert.equal(claude.sourceKind, "claude-code");
  assert.equal(claude.plan, "max");
  assert.equal(claude.label, "Claude (Pi)", "the label never reveals which source was used");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-claude-code");
});

test("with no Claude Code store, Pi's own anthropic entry is used", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  const claude = report.providers[0];
  assert.equal(claude.ok, true);
  assert.equal(claude.sourceKind, "pi");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-access-for-fixtures-only");
});

test("an expired Claude Code token is not silently replaced by Pi's anthropic token", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-expired", expiresAt: NOW - 60_000, subscriptionType: "pro" } }),
  );

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({ paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  assert.equal(report.providers[0].sourceKind, "claude-code", "the preferred source is the only one tried");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-expired");
  assert.ok(report.warnings.some((warning) => /claude: the Claude Code token expired/.test(warning)));
});

test("PI_QUOTA_CLAUDE_SOURCE=pi overrides the default preference", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-FAKE-claude-code", expiresAt: NOW + 3_600_000 } }),
  );

  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({
    paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: { PI_QUOTA_CLAUDE_SOURCE: "pi" }, home, usersRoot, stores: [], allowBrowser: false,
  });

  assert.equal(report.providers[0].sourceKind, "pi");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-FAKE-access-for-fixtures-only");
});

test("PI_QUOTA_CLAUDE_SOURCE=claude-code never falls back to the Pi store", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  const { fetchFn, calls } = fullRoutes();
  const report = await collectQuota({
    paths: [FIXTURE], now: NOW, fetchFn, families: ["claude"], env: { PI_QUOTA_CLAUDE_SOURCE: "claude-code" }, home, usersRoot, stores: [], allowBrowser: false,
  });

  assert.equal(report.providers[0].ok, false);
  assert.equal(calls.length, 0, "no request is made when the requested source is missing");
  assert.match(report.providers[0].error, /Claude Code/);
});

test("neither Claude source configured degrades as not-configured, not as a failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-src-"));
  const usersRoot = join(home, "no-windows-profiles");
  const emptyStore = join(home, "empty-auth.json");
  writeFileSync(emptyStore, "{}");

  const { fetchFn } = fullRoutes();
  const report = await collectQuota({ paths: [emptyStore], claudeCodePaths: [], now: NOW, fetchFn, families: ["claude"], env: {}, home, usersRoot, stores: [], allowBrowser: false });

  const claude = report.providers[0];
  assert.equal(claude.ok, false);
  assert.equal(claude.notConfigured, true);
  assert.match(claude.error, /no claude credential/);
});

test("warnings from parallel provider fetches are deterministically ordered by families", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-warn-order-"));
  const fetchFn = /** @type {typeof fetch} */ (async (url) => {
    const urlStr = String(url);
    if (urlStr.includes("anthropic")) {
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse({}, { status: 429, headers: { "retry-after": "60" } });
    }
    if (urlStr.includes("chatgpt")) {
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({}, { status: 429, headers: { "retry-after": "60" } });
    }
    return jsonResponse({});
  });

  const report = await collectQuota({
    paths: [FIXTURE],
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["claude", "codex"],
    env: {},
    home,
    stores: [],
    allowBrowser: false,
  });

  const throttledWarnings = report.warnings.filter((w) => w.includes("throttled upstream"));
  assert.equal(throttledWarnings.length, 2);
  assert.ok(throttledWarnings[0].startsWith("claude:"));
  assert.ok(throttledWarnings[1].startsWith("codex:"));
});

test("collectQuota falls back to ~/.codex/auth.json read-only when Pi store lacks openai-codex", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-codex-cli-"));
  const piStore = join(home, "pi-auth.json");
  const codexStore = join(home, "codex-auth.json");
  writeFileSync(piStore, JSON.stringify({ openai: { type: "oauth", access: "eyJ.direct.sig", clientId: "app_123" } }));
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      exp: Math.floor(NOW / 1000) + 3600,
      "https://api.openai.com/profile": { email: "cli-user@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-cli-999", chatgpt_plan_type: "plus" },
    }),
  ).toString("base64url");
  writeFileSync(
    codexStore,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: `${header}.${payload}.sig`,
        refresh_token: "rt_secret_never_load",
        account_id: "acc-cli-999",
      },
    }),
  );

  const { fetchFn } = fullRoutes();
  const report = await collectQuota({
    paths: [piStore],
    codexAuthPath: codexStore,
    claudeCodePaths: [],
    now: NOW,
    fetchFn,
    families: ["codex"],
    env: {},
    home,
    stores: [],
    allowBrowser: false,
  });

  const codex = report.providers[0];
  assert.equal(codex.ok, true);
  assert.equal(codex.sourceKind, "codex-cli");
  assert.equal(codex.plan, "plus");
  assert.equal(JSON.stringify(report).includes("rt_secret_never_load"), false);
});
