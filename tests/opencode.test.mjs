/**
 * OpenCode tests: dashboard parsing and session/cookie resolution.
 */

import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { findWorkspaceIds, htmlToText, parseGoDashboard, parseGoMeters, parsePercent, parseResetSeconds } from "../src/opencode/dashboard.js";
import { decryptLinuxChromiumCookie, discoverCookieStores, findCookie, readFirefoxCookies } from "../src/browser/cookies.js";
import { configPaths, fetchGoStatusApi, resolveCookie, toCookieHeader, writeSecretFile } from "../src/opencode/session.js";

const NOW = 1_800_000_000_000;

function encryptChromiumCookie(value, { version, password }) {
  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const plaintext = version === "v11"
    ? Buffer.concat([Buffer.alloc(32, 0x53), Buffer.from(value, "ascii")])
    : Buffer.from(value, "ascii");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(version), cipher.update(plaintext), cipher.final()]);
}

test("Linux Chromium cookies decrypt v10 peanuts and v11 keyring payloads", () => {
  const v10 = encryptChromiumCookie("v10-cookie-value", { version: "v10", password: "peanuts" });
  const v11 = encryptChromiumCookie("st_session-cookie", { version: "v11", password: "keyring-secret" });

  assert.equal(decryptLinuxChromiumCookie(v10), "v10-cookie-value");
  assert.equal(decryptLinuxChromiumCookie(v11, { app: "chromium", password: "keyring-secret" }), "st_session-cookie");
  assert.equal(decryptLinuxChromiumCookie(v11, { app: "chromium", password: "" }), null);
});

test("Linux Chromium v11 lookup resolves Safe Storage through Secret Service", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-chromium-v11-"));
  const db = join(dir, "Cookies");
  const writer = new DatabaseSync(db);
  writer.exec("create table cookies (host_key text, name text, value text, encrypted_value blob, path text)");
  writer.prepare("insert into cookies values (?, ?, ?, ?, ?)").run(
    ".opencode.ai", "auth", "", encryptChromiumCookie("st_session-cookie", { version: "v11", password: "keyring-secret" }), "/",
  );
  writer.close();

  const lookups = [];
  const hit = findCookie({
    host: "opencode.ai",
    name: "auth",
    stores: [{ browser: "chromium", path: db, profile: "linux:Chromium/Default", readability: "plaintext", app: "chromium" }],
    secretTool: (args) => {
      lookups.push(args);
      return args[1] === "service" ? "keyring-secret" : null;
    },
  });
  assert.equal(hit.found, true);
  assert.equal(hit.value, "st_session-cookie");
  assert.deepEqual(lookups, [
    ["lookup", "application", "chromium"],
    ["lookup", "service", "chromium Safe Storage"],
  ]);
});

test("resolveCookie combines __Host-console_session and auth cookies when both are present in the same store", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-multi-cookie-"));
  const db = join(dir, "Cookies");
  const writer = new DatabaseSync(db);
  writer.exec("create table cookies (host_key text, name text, value text, encrypted_value blob, path text)");
  writer.prepare("insert into cookies values (?, ?, ?, ?, ?)").run(".opencode.ai", "auth", "auth-token-val", null, "/");
  writer.prepare("insert into cookies values (?, ?, ?, ?, ?)").run(".opencode.ai", "__Host-console_session", "session-val", null, "/");
  writer.close();

  const store = { browser: "chromium", path: db, profile: "linux:Microsoft Edge/Default", readability: "plaintext" };
  const res = resolveCookie({ env: {}, stores: [store], allowBrowser: true });
  assert.equal(res.found, true);
  assert.equal(res.value, "__Host-console_session=session-val; auth=auth-token-val");
});

test("Linux Chromium discovery reports unreadable v11 stores and marks resolvable stores plaintext", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-linux-v11-"));
  const config = join(home, "xdg");
  const db = join(config, "chromium", "Default", "Network", "Cookies");
  mkdirSync(join(db, ".."), { recursive: true });
  const writer = new DatabaseSync(db);
  writer.exec("create table cookies (host_key text, name text, value text, encrypted_value blob, path text)");
  writer.prepare("insert into cookies values (?, ?, ?, ?, ?)").run(
    ".opencode.ai", "auth", "", encryptChromiumCookie("st_session-cookie", { version: "v11", password: "keyring-secret" }), "/",
  );
  writer.close();

  const options = { home, env: { XDG_CONFIG_HOME: config }, platform: "linux", secretTool: () => null };
  const locked = discoverCookieStores(options).find((store) => store.path === db);
  assert.equal(locked.readability, "encrypted");
  assert.match(locked.note, /Safe Storage/);

  const available = discoverCookieStores({
    ...options,
    secretTool: () => "keyring-secret",
  }).find((store) => store.path === db);
  assert.equal(available.readability, "plaintext");
});

test("Linux Chromium cookie lookup decrypts encrypted rows from a copied database", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-chromium-"));
  const db = join(dir, "Cookies");
  const writer = new DatabaseSync(db);
  writer.exec("create table cookies (host_key text, name text, value text, encrypted_value blob, path text)");
  writer.prepare("insert into cookies values (?, ?, ?, ?, ?)").run(
    ".opencode.ai", "auth", "", encryptChromiumCookie("v10-session", { version: "v10", password: "peanuts" }), "/",
  );
  writer.prepare("insert into cookies values (?, ?, ?, ?, ?)").run(
    ".opencode.ai", "auth-plain", "plain-session", Buffer.from("ignored"), "/",
  );
  writer.close();

  const hit = findCookie({
    host: "opencode.ai",
    name: "auth",
    stores: [{ browser: "chromium", path: db, profile: "linux:chromium/Default", readability: "plaintext", app: "chromium" }],
  });
  assert.equal(hit.found, true);
  assert.equal(hit.value, "v10-session");
  const plaintextHit = findCookie({
    host: "opencode.ai",
    name: "auth-plain",
    stores: [{ browser: "chromium", path: db, profile: "linux:chromium/Default", readability: "plaintext", app: "chromium" }],
  });
  assert.equal(plaintextHit.value, "plain-session");

  const reader = new DatabaseSync(db, { readOnly: true });
  assert.equal(reader.prepare("select count(*) as count from cookies").get().count, 2);
  reader.close();
});

test("Linux Chromium discovery covers browser config roots and profile cookie layouts", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-linux-browsers-"));
  const config = join(home, "xdg");
  const browserDirs = [
    "google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium",
    "microsoft-edge", "microsoft-edge-dev", "BraveSoftware/Brave-Browser",
  ];
  const expected = [];
  for (const browserDir of browserDirs) {
    const base = join(config, browserDir);
    for (const relative of ["Default/Cookies", "Default/Network/Cookies", "Profile 1/Cookies", "Profile 1/Network/Cookies"]) {
      const db = join(base, relative);
      mkdirSync(join(db, ".."), { recursive: true });
      writeFileSync(db, "synthetic database");
      expected.push(db);
    }
  }

  const stores = discoverCookieStores({ home, env: { XDG_CONFIG_HOME: config }, platform: "linux" });
  const linuxStores = stores.filter((store) => store.profile.startsWith("linux:"));
  assert.deepEqual(linuxStores.map((store) => store.path).sort(), expected.sort());
  assert.ok(linuxStores.every((store) => store.browser === "chromium"));
});

test("Console API meters normalize into canonical quota windows", () => {
  const windows = parseGoMeters({
    fiveHour: { limitMicroCents: "1000", usedMicroCents: "250", resetsAt: "2027-01-15T08:00:00.000Z" },
    week: { limitMicroCents: "1000", usedMicroCents: "1500", resetsAt: "2027-01-20T08:00:00.000Z" },
    month: { limitMicroCents: "1000", usedMicroCents: "-10", resetsAt: "2027-02-01T08:00:00.000Z" },
  }, { now: NOW });

  assert.deepEqual(windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.deepEqual(windows.map((window) => window.usedPercent), [25, 100, 0]);
  assert.deepEqual(windows.map((window) => window.windowSeconds), [18000, 604800, 2592000]);
  assert.equal(windows[0].resetsAt, "2027-01-15T08:00:00.000Z");
});

test("Console cookie headers preserve complete values and name bare tokens", () => {
  assert.equal(toCookieHeader("auth=already-complete; x=y"), "auth=already-complete; x=y");
  assert.equal(toCookieHeader(" token "), "__Host-console_session=token; auth=token");
  assert.equal(toCookieHeader(" token ", "auth"), "auth=token");
});

test("Console API fetches orgs and persists the organization that has Go meters", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-console-"));
  const calls = [];
  const response = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/orgs")) return response([{ id: "wrk_console" }]);
    return response({ access: { meters: {
      fiveHour: { limitMicroCents: "100", usedMicroCents: "25", resetsAt: "2027-01-15T08:00:00.000Z" },
      week: { limitMicroCents: "200", usedMicroCents: "50", resetsAt: "2027-01-20T08:00:00.000Z" },
      month: { limitMicroCents: "300", usedMicroCents: "75", resetsAt: "2027-02-01T08:00:00.000Z" },
    } } });
  };

  const result = await fetchGoStatusApi({ home, env: {}, cookie: "console-token", fetchFn, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.workspaceId, "wrk_console");
  assert.equal(result.planHint, "Go subscription");
  assert.deepEqual(result.strategies, ["console-api"]);
  assert.equal(calls[0].url, "https://opencode.ai/console/api/orgs");
  assert.equal(calls[1].options.headers["x-org-id"], "wrk_console");
  assert.equal(calls[1].options.headers.Cookie, "__Host-console_session=console-token; auth=console-token");
  assert.equal(resolveCookie({ home, env: {}, allowBrowser: false }).found, false);
  assert.equal(readFileSync(configPaths({ home, env: {} }).workspacePath, "utf-8").trim(), "wrk_console");
});

test("dashboard: renders data-slot usage items into canonical windows", () => {
  const html = `
    <div data-slot="usage-item">
      <span data-slot="usage-label">Rolling usage</span>
      <span data-slot="usage-value">42.5%</span>
      <span data-slot="reset-time">Resets in 2 hours 30 minutes</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Weekly usage</span>
      <span data-slot="usage-value">71%</span>
      <span data-slot="reset-time">Resets in 3 days</span>
    </div>
    <div data-slot="usage-item">
      <span data-slot="usage-label">Monthly usage</span>
      <span data-slot="usage-value">88%</span>
      <span data-slot="reset-time">Resets in 12 days</span>
    </div>`;
  const parsed = parseGoDashboard(html, { now: NOW });

  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 42.5);
  assert.equal(parsed.windows[0].remainingPercent, 57.5);
  assert.equal(parsed.windows[0].resetsInSec, 9000);
  assert.equal(parsed.windows[1].resetsInSec, 259200);
  assert.deepEqual(parsed.strategies, ["usage-item"]);
});

test("dashboard: falls back to hydration state when markup changes", () => {
  const html = `<script>const s={"rollingUsage":{"usagePercent":12,"resetInSec":600},
    "weeklyUsage":{"usagePercent":33,"resetInSec":86000},
    "monthlyUsage":{"usagePercent":44,"resetInSec":900000}};</script>`;
  const parsed = parseGoDashboard(html, { now: NOW });

  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 12);
  assert.equal(parsed.windows[2].usedPercent, 44);
  assert.deepEqual(parsed.strategies, ["hydration"]);
});

test("dashboard: a page with no recognizable windows returns nothing instead of throwing", () => {
  const parsed = parseGoDashboard("<html><body>Sign in</body></html>", { now: NOW });
  assert.deepEqual(parsed.windows, []);
  assert.deepEqual(parsed.strategies, []);
  assert.deepEqual(parseGoDashboard("", { now: NOW }).windows, []);
  assert.deepEqual(parseGoDashboard(null, { now: NOW }).windows, []);
});

test("dashboard: percentages and reset phrases are parsed defensively", () => {
  assert.equal(parsePercent("42.5%"), 42.5);
  assert.equal(parsePercent(7), 7);
  assert.equal(parsePercent("n/a"), null);
  assert.equal(parsePercent("190%"), 100);

  assert.equal(parseResetSeconds("Resets in 5 hours 10 minutes"), 18600);
  assert.equal(parseResetSeconds("resets in 3 days"), 259200);
  assert.equal(parseResetSeconds("Resets now"), 0);
  assert.equal(parseResetSeconds(""), null);
  assert.equal(parseResetSeconds(1200), 1200);

  assert.equal(htmlToText("<span>42% &amp; more</span>"), "42% & more");
});

test("workspace ids are discovered without picking up route segments", () => {
  const html = `<a href="/workspace/ws_abc12345/go">Go</a><a href="/workspace/settings">s</a>
    <script>{"workspaceId":"ws_zzz99999"}</script>`;
  const ids = findWorkspaceIds(html);
  assert.equal(ids.includes("ws_abc12345"), true);
  assert.equal(ids.includes("ws_zzz99999"), true);
  assert.equal(ids.includes("settings"), false);
});

test("cookie resolution prefers the environment, then the config file, and never a browser scan there", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-oc-"));
  const paths = configPaths({ home, env: {} });

  const empty = resolveCookie({ home, env: {}, stores: [], allowBrowser: false });
  assert.equal(empty.found, false);
  assert.equal(empty.origin, null);

  const written = writeSecretFile(paths.path, "cookie-from-config");
  assert.equal(written.ok, true);
  const fromConfig = resolveCookie({ home, env: {}, stores: [], allowBrowser: false });
  assert.equal(fromConfig.found, true);
  assert.equal(fromConfig.origin, "config");
  assert.equal(fromConfig.value, "cookie-from-config");

  const fromEnv = resolveCookie({ home, env: { OPENCODE_GO_AUTH_COOKIE: "cookie-from-env" } });
  assert.equal(fromEnv.origin, "env");
  assert.equal(fromEnv.value, "cookie-from-env");
});

test("cookie resolution explains why nothing was found", () => {
  const stores = [
    { browser: "chromium", path: "/nope", profile: "windows:Chrome/Default", readability: "encrypted" },
  ];
  const result = resolveCookie({ env: {}, home: "/nonexistent", stores });
  assert.equal(result.found, false);
  assert.equal(result.encryptedOnly, true);
  assert.match(result.detail, /DPAPI/);
});

test("firefox roots on native Windows include %APPDATA%\\Mozilla\\Firefox", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-ff-win-"));
  const appDataRoot = join(home, "AppData", "Roaming", "Mozilla", "Firefox");
  const profileDir = join(appDataRoot, "Profiles", "release.default");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(appDataRoot, "profiles.ini"),
    "[Profile0]\nName=release\nIsRelative=1\nPath=Profiles/release.default\nDefault=1\n",
  );
  writeFileSync(join(profileDir, "cookies.sqlite"), "");

  const stores = discoverCookieStores({ home, appData: join(home, "AppData", "Roaming"), platform: "win32" });
  assert.equal(stores.length, 1);
  assert.equal(stores[0].browser, "firefox");
  assert.equal(stores[0].profile, "windows:Profile0 (default)");
  assert.equal(stores[0].path, join(profileDir, "cookies.sqlite"));
});

test("macOS Firefox profile discovery resolves ~/Library/Application Support/Firefox", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-quota-mac-"));
  const macRoot = join(home, "Library", "Application Support", "Firefox");
  const profileDir = join(macRoot, "Profiles", "mac.default");
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    join(macRoot, "profiles.ini"),
    "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/mac.default\nDefault=1\n",
  );
  writeFileSync(join(profileDir, "cookies.sqlite"), "");

  const stores = discoverCookieStores({ home, platform: "darwin" });
  assert.equal(stores.length, 1);
  assert.equal(stores[0].browser, "firefox");
  assert.equal(stores[0].profile, "mac:Profile0 (default)");
  assert.equal(stores[0].path, join(profileDir, "cookies.sqlite"));
});

test("the Firefox reader works on a copied database and is read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-ff-"));
  const db = join(dir, "cookies.sqlite");
  const writer = new DatabaseSync(db);
  writer.exec("create table moz_cookies (host text, name text, value text, path text)");
  writer.prepare("insert into moz_cookies values (?, ?, ?, ?)").run(".opencode.ai", "auth", "session-abc", "/");
  writer.prepare("insert into moz_cookies values (?, ?, ?, ?)").run("example.com", "other", "nope", "/");
  writer.close();

  const rows = readFirefoxCookies(db, { hostLike: "%opencode.ai%", name: "auth" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, "session-abc");
  assert.equal(rows[0].host, ".opencode.ai");

  // A missing database is a clean empty result, never a throw.
  assert.deepEqual(readFirefoxCookies(join(dir, "missing.sqlite"), { hostLike: "%" }), []);
});

test("a malformed browser database does not break the lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-bad-"));
  mkdirSync(dir, { recursive: true });
  const db = join(dir, "cookies.sqlite");
  writeFileSync(db, "not a sqlite database");
  assert.deepEqual(readFirefoxCookies(db, { hostLike: "%" }), []);
});

test("workspace ids are recovered from browser history, newest first", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { extractWorkspaceIds, findRecentWorkspaceIds, pathOnly, readVisitedUrls } = await import("../src/browser/history.js");
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-places-"));
  const db = join(dir, "places.sqlite");
  const writer = new DatabaseSync(db);
  writer.exec("create table moz_places (url text, title text, last_visit_date integer)");
  const insert = writer.prepare("insert into moz_places values (?, ?, ?)");
  insert.run("https://opencode.ai/workspace/wrk_NEWER/go", "go", 2000);
  insert.run("https://opencode.ai/workspace/wrk_OLDER/usage", "usage", 1000);
  insert.run("https://opencode.ai/workspace/settings", "s", 3000);
  insert.run("https://example.com/workspace/wrk_NOTOURS", "x", 4000);
  writer.close();

  const urls = readVisitedUrls(db, { urlLike: "%opencode.ai/workspace/%" });
  assert.deepEqual(extractWorkspaceIds(urls), ["wrk_NEWER", "wrk_OLDER"]);
  assert.deepEqual(extractWorkspaceIds([
    "https://opencode.ai/console/wrk_CONSOLE",
    "https://opencode.ai/console/login",
    "https://opencode.ai/console/auth",
  ]), ["wrk_CONSOLE"]);

  const found = findRecentWorkspaceIds({ stores: [{ profile: "test", path: db }] });
  assert.equal(found.ids[0], "wrk_NEWER");
  assert.equal(found.profile, "test");

  // Query strings never survive, so no token can leak through a URL.
  assert.equal(pathOnly("https://opencode.ai/auth/callback?code=secret&state=x"), "/auth/callback");
});

test("a missing history database yields no ids instead of throwing", async () => {
  const { findRecentWorkspaceIds } = await import("../src/browser/history.js");
  const found = findRecentWorkspaceIds({ stores: [{ profile: "test", path: "/definitely/not/here.sqlite" }] });
  assert.deepEqual(found.ids, []);
  assert.equal(found.profile, null);
});

test("the live page labels are matched, including the hyphenated 5-hour window", () => {
  // Verbatim labels from the real dashboard capture.
  const html = `
    <div data-slot="usage-item"><span data-slot="usage-label">5-hour Usage</span>
      <span data-slot="usage-value">1.9%</span>
      <span data-slot="reset-time">Resets in 4 hours 33 minutes</span></div>
    <div data-slot="usage-item"><span data-slot="usage-label">Weekly Usage</span>
      <span data-slot="usage-value">69%</span>
      <span data-slot="reset-time">Resets in 1 day 6 hours</span></div>
    <div data-slot="usage-item"><span data-slot="usage-label">Monthly Usage</span>
      <span data-slot="usage-value">34.5%</span>
      <span data-slot="reset-time">Resets in 10 days 1 hour</span></div>`;

  const parsed = parseGoDashboard(html, { now: NOW });
  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 1.9);
  assert.equal(parsed.windows[0].remainingPercent, 98.1);
  assert.equal(parsed.windows[0].resetsInSec, 16380);
  assert.equal(parsed.windows[2].usedPercent, 34.5);
});

test("a partial render is completed from the hydration state instead of hiding a window", () => {
  // Only two items are rendered; the 5h window exists only in the serialized state.
  const html = `
    <div data-slot="usage-item"><span data-slot="usage-label">Weekly Usage</span>
      <span data-slot="usage-value">69%</span><span data-slot="reset-time">Resets in 1 day</span></div>
    <div data-slot="usage-item"><span data-slot="usage-label">Monthly Usage</span>
      <span data-slot="usage-value">34.5%</span><span data-slot="reset-time">Resets in 10 days</span></div>
    <script>const s = {"rollingUsage":{"usagePercent":1.9,"resetInSec":16380}};</script>`;

  const parsed = parseGoDashboard(html, { now: NOW });
  assert.deepEqual(parsed.windows.map((window) => window.id), ["5h", "weekly", "monthly"]);
  assert.equal(parsed.windows[0].usedPercent, 1.9);
  assert.deepEqual(parsed.strategies.sort(), ["hydration", "usage-item"]);
});

test("label aliases accept the spellings the plan uses", () => {
  const cases = [
    ["5-hour Usage", "5h"],
    ["5h Usage", "5h"],
    ["5 hr limit", "5h"],
    ["Rolling usage", "5h"],
    ["Five Hour Limit Remaining", "5h"],
    ["Weekly Usage", "weekly"],
    ["7-day limit", "weekly"],
    ["Monthly Usage", "monthly"],
    ["30 day limit", "monthly"],
  ];
  for (const [label, expected] of cases) {
    const html = `<div data-slot="usage-item"><span data-slot="usage-label">${label}</span>
      <span data-slot="usage-value">10%</span><span data-slot="reset-time">Resets in 1 hour</span></div>`;
    const parsed = parseGoDashboard(html, { now: NOW });
    assert.equal(parsed.windows.length, 1, `label ${label}`);
    assert.equal(parsed.windows[0].id, expected, `label ${label}`);
  }
});
