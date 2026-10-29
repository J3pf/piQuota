/**
 * Claude Code CLI credential source.
 *
 * The `pi-claude-code-provider` package never stores anything in Pi's auth store:
 * it drives the installed `claude` executable, which owns
 * `~/.claude/.credentials.json`. These tests pin the read-only contract for that
 * second Claude source, using synthetic files only.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claudeCodeCandidatePaths,
  describeClaudeCodeSource,
  loadClaudeCodeCredential,
  KEYCHAIN_SERVICE,
  OAUTH_REFRESH_LOCK_NAME,
  readClaudeCodeProfile,
  recoverStaleClaudeLock,
  resolveClaudeCodeCredentialPaths,
} from "../src/auth/claude-code-auth.js";

const FAKE_ACCESS = "sk-ant-oat01-FAKE-claude-code-access";
const FAKE_REFRESH = "sk-ant-ort01-FAKE-claude-code-refresh";
const EXPIRES_AT_MS = 1_893_456_000_000;

/**
 * A synthetic Claude Code home: `.claude/.credentials.json` plus `.claude.json`.
 *
 * @param {{ access?: string, refresh?: string, expiresAt?: number | null, subscriptionType?: string }} [options]
 * @returns {{ home: string, credentialsPath: string, profilePath: string }}
 */
function makeClaudeCodeHome(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-code-"));
  const dir = join(home, ".claude");
  mkdirSync(dir, { recursive: true });

  const oauth = {
    accessToken: options.access ?? FAKE_ACCESS,
    refreshToken: options.refresh ?? FAKE_REFRESH,
    expiresAt: options.expiresAt === undefined ? EXPIRES_AT_MS : options.expiresAt,
    refreshTokenExpiresAt: EXPIRES_AT_MS,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
    subscriptionType: options.subscriptionType ?? "pro",
    rateLimitTier: "default_claude_ai",
  };

  const credentialsPath = join(dir, ".credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: oauth }, null, 2));

  const profilePath = join(home, ".claude.json");
  writeFileSync(
    profilePath,
    JSON.stringify({
      oauthAccount: {
        emailAddress: "fixture@example.com",
        displayName: "Fixture",
        organizationType: "claude_pro",
      },
      userID: "fixture-user-id",
      projects: { "/a/really/long/project/path": { history: [] } },
    }),
  );

  // Tests must never scan the developer's real /mnt/c/Users.
  const usersRoot = join(home, "no-windows-profiles");
  return { home, usersRoot, credentialsPath, profilePath };
}

test("the credential file is discovered at ~/.claude/.credentials.json", () => {
  const { credentialsPath, home, usersRoot } = makeClaudeCodeHome();
  assert.deepEqual(resolveClaudeCodeCredentialPaths({ home, usersRoot, env: {}, platform: "linux" }), [credentialsPath]);
});

test("CLAUDE_CONFIG_DIR relocates the credential file, as Claude Code itself does", () => {
  const { credentialsPath, home, usersRoot } = makeClaudeCodeHome();
  const nested = join(home, "custom-config");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, ".credentials.json"), readFileSync(credentialsPath, "utf-8"));

  const paths = resolveClaudeCodeCredentialPaths({ home, usersRoot, env: { CLAUDE_CONFIG_DIR: nested }, platform: "linux" });
  assert.deepEqual(paths, [join(nested, ".credentials.json")]);
});

test("an explicit override is the only candidate, and is used verbatim", () => {
  const { credentialsPath, home, usersRoot } = makeClaudeCodeHome();
  const env = { PI_QUOTA_CLAUDE_CODE_CREDENTIALS: join(home, "relocated.json") };

  assert.deepEqual(claudeCodeCandidatePaths({ home, usersRoot, env, platform: "linux" }), [join(home, "relocated.json")]);
  assert.deepEqual(resolveClaudeCodeCredentialPaths({ home, usersRoot, env, platform: "linux" }), [], "a missing override yields nothing");

  writeFileSync(join(home, "relocated.json"), readFileSync(credentialsPath, "utf-8"));
  assert.deepEqual(resolveClaudeCodeCredentialPaths({ home, usersRoot, env, platform: "linux" }), [join(home, "relocated.json")]);
});

test("only existing files are offered as candidates", () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-quota-no-claude-"));
  const usersRoot = join(empty, "no-windows-profiles");
  assert.deepEqual(resolveClaudeCodeCredentialPaths({ home: empty, usersRoot, env: {}, platform: "linux" }), []);
  assert.deepEqual(claudeCodeCandidatePaths({ home: empty, usersRoot, env: {}, platform: "linux" }), [join(empty, ".claude", ".credentials.json")]);
});

test("a readable store yields an access token, an expiry and the subscription plan", () => {
  const { credentialsPath, home, usersRoot } = makeClaudeCodeHome();
  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.credential.provider, "claude-code");
  assert.equal(loaded.credential.family, "claude");
  assert.equal(loaded.credential.label, "Claude (Pi)");
  assert.equal(loaded.credential.sourceKind, "claude-code");
  assert.equal(loaded.credential.source, credentialsPath);
  assert.equal(loaded.credential.access, FAKE_ACCESS);
  assert.equal(loaded.credential.expiresAtMs, EXPIRES_AT_MS);
  assert.equal(loaded.credential.planType, "pro");
  assert.equal(loaded.credential.kind, "oauth");
});

test("the refresh token is never carried, so nothing downstream can rotate it", () => {
  const { home, usersRoot } = makeClaudeCodeHome();
  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.credential.refresh, undefined);
  assert.equal(JSON.stringify(loaded).includes(FAKE_REFRESH), false, "the refresh token must not leave the reader");
});

test("reading the store never writes to it", () => {
  const { credentialsPath, home, usersRoot } = makeClaudeCodeHome();
  const before = readFileSync(credentialsPath);
  chmodSync(credentialsPath, 0o400);

  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });
  assert.equal(loaded.ok, true);

  chmodSync(credentialsPath, 0o600);
  assert.deepEqual(readFileSync(credentialsPath), before, "the Claude Code store must stay byte-identical");
});

test("the account e-mail is read from Claude Code's own profile, never from the token", () => {
  const { home, usersRoot } = makeClaudeCodeHome();
  const profile = readClaudeCodeProfile({ home, usersRoot, env: {} });

  assert.equal(profile.email, "fixture@example.com");
  assert.equal(profile.displayName, "Fixture");
  assert.equal(profile.organizationType, "claude_pro");

  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });
  assert.equal(loaded.credential.email, "fixture@example.com");
  assert.equal(loaded.credential.identity, "fixture@example.com");
});

test("a huge Claude Code profile is never echoed back, only its account fields", () => {
  const { home, usersRoot } = makeClaudeCodeHome();
  const profile = readClaudeCodeProfile({ home, usersRoot, env: {} });
  assert.equal(JSON.stringify(profile).includes("/a/really/long/project/path"), false);
  assert.equal(Object.keys(profile).sort().join(","), "displayName,email,organizationType");
});

test("a missing store degrades with an actionable message instead of throwing", () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-quota-no-claude-"));
  const loaded = loadClaudeCodeCredential({ home: empty, usersRoot: join(empty, "no-windows-profiles"), env: {}, platform: "linux" });

  assert.equal(loaded.ok, false);
  assert.equal(loaded.credential, null);
  assert.match(loaded.error, /Claude Code/);
  assert.match(loaded.error, /\.claude\/\.credentials\.json/);
});

test("a corrupt store degrades instead of throwing", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-bad-claude-"));
  const usersRoot = join(home, "no-windows-profiles");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), "{ this is not json");

  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /cannot parse/);
});

test("a store without an access token degrades instead of reporting an empty account", () => {
  const { home, usersRoot } = makeClaudeCodeHome({ access: "" });
  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });
  assert.equal(loaded.ok, false);
  assert.match(loaded.error, /no Claude Code access token/);
});

test("a store with no expiry still loads, so freshness is simply unknown", () => {
  const { home, usersRoot } = makeClaudeCodeHome({ expiresAt: null });
  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.credential.expiresAtMs, null);
});

test("describeClaudeCodeSource reports paths and never token material", () => {
  const { credentialsPath, home, usersRoot } = makeClaudeCodeHome();
  const described = describeClaudeCodeSource({ home, usersRoot, env: {}, platform: "linux" });

  assert.equal(described.ok, true);
  assert.equal(described.path, credentialsPath);
  assert.equal(described.paths.includes(credentialsPath), true);
  assert.equal(described.hasAccessToken, true);
  assert.equal(described.hasRefreshToken, true);
  assert.equal(described.expiresInMin > 0, true);
  assert.equal(JSON.stringify(described).includes(FAKE_ACCESS), false);
  assert.equal(JSON.stringify(described).includes(FAKE_REFRESH), false);
});

test("describeClaudeCodeSource explains an empty search without throwing", () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-quota-no-claude-"));
  const described = describeClaudeCodeSource({ home: empty, usersRoot: join(empty, "no-windows-profiles"), env: {}, platform: "linux" });
  assert.equal(described.ok, false);
  assert.deepEqual(described.paths, []);
  assert.match(described.error, /Claude Code/);
});

test("an abandoned .oauth_refresh.lock is automatically cleaned up when stale", () => {
  const { home, usersRoot } = makeClaudeCodeHome();
  const claudeDir = join(home, ".claude");
  const lockDir = join(claudeDir, OAUTH_REFRESH_LOCK_NAME);
  mkdirSync(lockDir);
  // Set mtime to 10 minutes ago
  const tenMinutesAgo = (Date.now() - 600_000) / 1000;
  utimesSync(lockDir, tenMinutesAgo, tenMinutesAgo);

  assert.equal(existsSync(lockDir), true);

  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux" });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recoveredLock?.recovered, true);
  assert.equal(existsSync(lockDir), false, "the stale lock directory must be deleted");
});

test("a recent .oauth_refresh.lock (< staleMs) is not removed", () => {
  const { home, usersRoot } = makeClaudeCodeHome();
  const claudeDir = join(home, ".claude");
  const lockDir = join(claudeDir, OAUTH_REFRESH_LOCK_NAME);
  mkdirSync(lockDir);

  assert.equal(existsSync(lockDir), true);

  const loaded = loadClaudeCodeCredential({ home, usersRoot, env: {}, platform: "linux", staleMs: 120_000 });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.recoveredLock, null);
  assert.equal(existsSync(lockDir), true, "a fresh lock must be preserved");
});


// --- macOS Keychain source -------------------------------------------------

const keychainBlob = (oauth = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: FAKE_ACCESS,
      refreshToken: FAKE_REFRESH,
      expiresAt: EXPIRES_AT_MS,
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
      ...oauth,
    },
  });

test("keychain: darwin with no credentials file falls back to the Keychain item", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-keychain-"));
  const loaded = loadClaudeCodeCredential({ home, env: {}, platform: "darwin", keychainReader: () => keychainBlob() });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.credential.access, FAKE_ACCESS);
  assert.equal(loaded.credential.planType, "pro");
  assert.equal(loaded.credential.source, `macOS Keychain (${KEYCHAIN_SERVICE})`);
  assert.equal(JSON.stringify(loaded).includes(FAKE_REFRESH), false, "refresh token must not be carried");
});

test("keychain: a credentials file still wins over the Keychain", () => {
  const { home } = makeClaudeCodeHome({ access: "from-file" });
  const loaded = loadClaudeCodeCredential({ home, env: {}, platform: "darwin", keychainReader: () => keychainBlob() });
  assert.equal(loaded.credential.access, "from-file");
});

test("keychain: ignored off darwin, with an explicit path, or with a relocated config dir", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-keychain-"));
  const reader = () => keychainBlob();
  assert.equal(loadClaudeCodeCredential({ home, env: {}, platform: "linux", usersRoot: join(home, "none"), keychainReader: reader }).ok, false);
  assert.equal(loadClaudeCodeCredential({ home, env: { CLAUDE_CONFIG_DIR: join(home, "x") }, platform: "darwin", keychainReader: reader }).ok, false);
  assert.equal(loadClaudeCodeCredential({ home, env: {}, platform: "darwin", paths: [], keychainReader: reader }).ok, false);
});

test("keychain: unreadable or malformed items degrade into a message, never a throw", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-keychain-"));
  for (const keychainReader of [() => null, () => "not json", () => "{}", () => keychainBlob({ accessToken: "" })]) {
    const loaded = loadClaudeCodeCredential({ home, env: {}, platform: "darwin", keychainReader });
    assert.equal(loaded.ok, false);
    assert.match(loaded.error, /Keychain/);
  }
});

test("keychain: describeClaudeCodeSource reports presence only, never token values", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-claude-keychain-"));
  const described = describeClaudeCodeSource({ home, env: {}, platform: "darwin", keychainReader: () => keychainBlob() });
  assert.equal(described.ok, true);
  assert.equal(described.hasAccessToken, true);
  assert.equal(described.hasRefreshToken, true);
  assert.equal(described.plan, "pro");
  assert.equal(JSON.stringify(described).includes(FAKE_ACCESS), false);
});
