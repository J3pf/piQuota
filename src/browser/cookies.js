/**
 * Read-only browser cookie access.
 *
 * Only used to obtain the opencode.ai session cookie that Pi does not store.
 * Guarantees:
 *   - the browser database is never opened in place: it is copied to a private
 *     temporary directory (including `-wal`/`-shm`) and opened read-only there;
 *   - cookie values are returned to the caller but never logged, printed or
 *     written to the cache;
 *   - Chromium cookie databases are copied before read-only access; Linux OSCrypt
 *     values are decrypted in memory, while unsupported platform encryption is
 *     reported instead of guessed.
 */

import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const WINDOWS_USERS_ROOT = "/mnt/c/Users";

/**
 * @typedef {Object} CookieStore
 * @property {"firefox" | "chromium"} browser
 * @property {string} path              Path to the cookie database.
 * @property {string} profile           Human profile label.
 * @property {"plaintext" | "encrypted" | "unknown"} readability
 * @property {string} [note]
 * @property {string} [app]
 */

/**
 * Firefox roots: ~/.mozilla/firefox, plus native Windows %APPDATA% profiles,
 * plus every Windows profile reachable from WSL.
 *
 * @param {{ home?: string, appData?: string, usersRoot?: string, platform?: string }} [options]
 * @returns {string[]}
 */
export function firefoxRoots(options = {}) {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  /** @type {string[]} */
  const roots = [];

  if (platform === "win32") {
    // Windows keeps profiles under %APPDATA%\Mozilla\Firefox, not ~/.mozilla/firefox.
    const appData = options.appData ?? env.APPDATA ?? join(home, "AppData", "Roaming");
    roots.push(join(appData, "Mozilla", "Firefox"));
  } else if (platform === "darwin") {
    roots.push(join(home, "Library", "Application Support", "Firefox"));
  } else {
    roots.push(
      join(home, ".mozilla", "firefox"),
      join(home, ".config", "mozilla", "firefox"),
      join(home, "Library", "Application Support", "Firefox"),
    );
    if (env.XDG_CONFIG_HOME) {
      roots.push(join(env.XDG_CONFIG_HOME, "mozilla", "firefox"));
    }
    if (existsSync(WINDOWS_USERS_ROOT)) {
      let entries = [];
      try {
        entries = readdirSync(options.usersRoot ?? WINDOWS_USERS_ROOT, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (["Default", "Default User", "All Users", "Public"].includes(entry.name)) continue;
        roots.push(join(options.usersRoot ?? WINDOWS_USERS_ROOT, entry.name, "AppData", "Roaming", "Mozilla", "Firefox"));
      }
    }
  }
  return roots.filter((root) => existsSync(join(root, "profiles.ini")));
}

/**
 * Parse `profiles.ini` for profile directories.
 *
 * @param {string} root
 * @returns {Array<{ label: string, dir: string, isDefault: boolean }>}
 */
export function parseFirefoxProfiles(root) {
  let text;
  try {
    text = readFileSync(join(root, "profiles.ini"), "utf-8");
  } catch {
    return [];
  }

  /** @type {Array<{ label: string, dir: string, isDefault: boolean, relative: boolean }>} */
  const profiles = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      if (current) profiles.push(current);
      current = { label: line.replace(/[[\]]/g, ""), dir: "", isDefault: false, relative: true };
      continue;
    }
    if (!current) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (key === "Path") current.dir = value;
    if (key === "IsRelative") current.relative = value !== "0";
    if (key === "Default") current.isDefault = value === "1";
  }
  if (current) profiles.push(current);

  return profiles
    .filter((profile) => profile.dir)
    .map((profile) => ({
      label: profile.label,
      isDefault: profile.isDefault,
      dir: profile.relative ? join(root, profile.dir) : profile.dir,
    }))
    .filter((profile) => existsSync(join(profile.dir, "cookies.sqlite")));
}

/**
 * Every readable cookie store, most readable first.
 *
 * @param {{ home?: string, usersRoot?: string, platform?: string, env?: Record<string, string | undefined>, secretTool?: (args: string[]) => string | null }} [options]
 * @returns {CookieStore[]}
 */
export function discoverCookieStores(options = {}) {
  /** @type {CookieStore[]} */
  const stores = [];
  for (const root of firefoxRoots(options)) {
    for (const profile of parseFirefoxProfiles(root)) {
      let platformPrefix = "linux";
      if (root.includes("Application Support")) platformPrefix = "mac";
      else if (root.endsWith("Firefox")) platformPrefix = "windows";
      stores.push({
        browser: "firefox",
        path: join(profile.dir, "cookies.sqlite"),
        profile: `${platformPrefix}:${profile.label}${profile.isDefault ? " (default)" : ""}`,
        readability: "plaintext",
      });
    }
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin") {
    for (const store of linuxChromiumStores(options)) stores.push(store);
  }

  // Chromium on Windows encrypts values with DPAPI; surface it so the user gets
  // an explanation instead of a silent failure.
  for (const userRoot of windowsChromiumRoots(options)) {
    for (const browserName of ["Google/Chrome", "Microsoft/Edge", "BraveSoftware/Brave-Browser"]) {
      const base = join(userRoot, browserName, "User Data");
      if (!existsSync(base)) continue;
      for (const profile of ["Default", "Profile 1", "Profile 2"]) {
        const db = join(base, profile, "Network", "Cookies");
        if (!existsSync(db)) continue;
        stores.push({
          browser: "chromium",
          path: db,
          profile: `windows:${browserName.split("/").pop()}/${profile}`,
          readability: "encrypted",
          note: "Chromium on Windows encrypts cookies with DPAPI, which is not available from WSL. Use Firefox for opencode.ai.",
        });
      }
    }
  }

  return stores;
}

const LINUX_CHROMIUM_BROWSERS = [
  { directory: "google-chrome", label: "Google Chrome", app: "chrome" },
  { directory: "google-chrome-beta", label: "Google Chrome Beta", app: "chrome" },
  { directory: "google-chrome-unstable", label: "Google Chrome Unstable", app: "chrome" },
  { directory: "chromium", label: "Chromium", app: "chromium" },
  { directory: "microsoft-edge", label: "Microsoft Edge", app: "microsoft-edge" },
  { directory: "microsoft-edge-dev", label: "Microsoft Edge Dev", app: "microsoft-edge" },
  { directory: "BraveSoftware/Brave-Browser", label: "Brave", app: "brave" },
];

/**
 * @param {{ home?: string, env?: Record<string, string | undefined>, secretTool?: (args: string[]) => string | null }} [options]
 * @returns {CookieStore[]}
 */
function linuxChromiumStores(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config");
  /** @type {CookieStore[]} */
  const stores = [];
  const seen = new Set();

  for (const browser of LINUX_CHROMIUM_BROWSERS) {
    const browserDir = join(configRoot, browser.directory);
    if (!existsSync(browserDir)) continue;
    const profiles = ["Default"];
    try {
      profiles.push(...readdirSync(browserDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("Profile "))
        .map((entry) => entry.name));
    } catch {
      // A browser directory may disappear while discovery is running.
    }

    for (const profile of profiles) {
      for (const relative of [join(profile, "Cookies"), join(profile, "Network", "Cookies")]) {
        const dbPath = join(browserDir, relative);
        if (seen.has(dbPath) || !existsSync(dbPath)) continue;
        seen.add(dbPath);
        const status = chromiumStoreReadability(dbPath, browser.app, options);
        stores.push({
          browser: "chromium",
          path: dbPath,
          profile: `linux:${browser.label}/${profile}`,
          app: browser.app,
          ...status,
        });
      }
    }
  }
  return stores;
}

/**
 * @param {{ usersRoot?: string, platform?: string }} [options]
 * @returns {string[]}
 */
function windowsChromiumRoots(options = {}) {
  if ((options.platform ?? process.platform) === "win32") return [];
  const usersRoot = options.usersRoot ?? WINDOWS_USERS_ROOT;
  if (!existsSync(usersRoot)) return [];
  /** @type {string[]} */
  const roots = [];
  try {
    for (const entry of readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (["Default", "Default User", "All Users", "Public"].includes(entry.name)) continue;
      roots.push(join(usersRoot, entry.name, "AppData", "Local"));
    }
  } catch {
    return [];
  }
  return roots;
}

const secretStoragePasswords = new Map();

/**
 * Look up the Linux Chromium Safe Storage password without exposing it outside
 * this process. Both common Secret Service attributes are attempted.
 *
 * @param {string} app
 * @param {{ secretTool?: (args: string[]) => string | null }} [options]
 * @returns {string | null}
 */
function linuxChromiumPassword(app, options = {}) {
  const candidates = [app];
  if (app !== "chromium") candidates.push("chromium");
  if (app !== "chrome") candidates.push("chrome");

  if (typeof options.secretTool === "function") {
    for (const candidate of candidates) {
      for (const args of [
        ["lookup", "application", candidate],
        ["lookup", "service", `${candidate} Safe Storage`],
      ]) {
        try {
          const value = options.secretTool(args)?.replace(/[\r\n]+$/, "");
          if (value) return value;
        } catch {
          // Try the alternate Secret Service attribute.
        }
      }
    }
    return null;
  }
  if (secretStoragePasswords.has(app)) return secretStoragePasswords.get(app);

  let password = null;
  for (const candidate of candidates) {
    for (const args of [
      ["lookup", "application", candidate],
      ["lookup", "service", `${candidate} Safe Storage`],
    ]) {
      try {
        const value = execFileSync("secret-tool", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2000,
        }).replace(/[\r\n]+$/, "");
        if (value.length > 0) {
          password = value;
          break;
        }
      } catch {
        // Missing secret-tool, locked keyrings and absent entries are expected.
      }
    }
    if (password) break;
  }
  secretStoragePasswords.set(app, password);
  return password;
}

/**
 * Decrypt a Linux Chromium OSCrypt cookie value. The `password` option allows
 * callers/tests to supply an already-resolved Safe Storage password.
 *
 * @param {Buffer | Uint8Array} encryptedValue
 * @param {{ app?: string, password?: string | null, secretTool?: (args: string[]) => string | null }} [options]
 * @returns {string | null}
 */
export function decryptLinuxChromiumCookie(encryptedValue, options = {}) {
  const encrypted = Buffer.from(encryptedValue);
  const version = encrypted.subarray(0, 3).toString("ascii");
  if ((version !== "v10" && version !== "v11") || encrypted.length <= 3) return null;

  let password;
  if (version === "v10") password = "peanuts";
  else if (Object.hasOwn(options, "password")) password = options.password;
  else password = linuxChromiumPassword(options.app ?? "chromium", options);
  if (typeof password !== "string" || password.length === 0) return null;

  try {
    const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const payload = version === "v11" ? decrypted.subarray(32) : decrypted;
    if (payload.length === 0) return null;
    if (version === "v11") {
      const knownPrefix = payload.subarray(0, 6).toString("ascii").startsWith("Fe26.2")
        || payload.subarray(0, 3).toString("ascii") === "st_";
      if (!knownPrefix && !isPrintableAscii(payload)) return null;
    }
    return payload.toString("utf8");
  } catch {
    return null;
  }
}

/** @param {Buffer} bytes */
function isPrintableAscii(bytes) {
  return bytes.length > 0 && bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
}

/**
 * Decide whether the encrypted values in a Linux Chromium database are
 * supported by this process. v10 uses the documented legacy password; v11
 * requires a password from the browser's Secret Service entry.
 *
 * @param {string} dbPath
 * @param {string} app
 * @param {{ secretTool?: (args: string[]) => string | null }} [options]
 * @returns {{ readability: "plaintext" | "encrypted", note?: string }}
 */
function chromiumStoreReadability(dbPath, app, options = {}) {
  const copy = withCopy(dbPath);
  let database;
  try {
    database = new DatabaseSync(copy.db, { readOnly: true });
    const rows = database.prepare("select encrypted_value from cookies where encrypted_value is not null and length(encrypted_value) > 0").all();
    for (const row of rows) {
      const encrypted = Buffer.from(row.encrypted_value);
      const version = encrypted.subarray(0, 3).toString("ascii");
      if (version === "v10") continue;
      if (version === "v11" && linuxChromiumPassword(app, options)) continue;
      return {
        readability: "encrypted",
        note: "Chromium OSCrypt cookies need a supported v10 value or an unlocked Secret Service Safe Storage entry for this browser.",
      };
    }
    return { readability: "plaintext" };
  } catch {
    return {
      readability: "encrypted",
      note: "Chromium cookie database could not be inspected; its encrypted values may require the browser's Secret Service Safe Storage entry.",
    };
  } finally {
    try { database?.close(); } catch {}
    copy.cleanup();
  }
}

const activeCookieCleanups = new Set();
if (typeof process !== "undefined" && typeof process.on === "function") {
  const runCleanups = () => {
    for (const fn of activeCookieCleanups) {
      try { fn(); } catch {}
    }
    activeCookieCleanups.clear();
  };
  process.once("exit", runCleanups);
  process.once("SIGINT", () => {
    runCleanups();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    runCleanups();
    process.exit(143);
  });
}

/**
 * Copy a SQLite database (with its journal) to a private temp dir so the
 * browser's own file is never opened or locked by us.
 *
 * @param {string} dbPath
 * @returns {{ dir: string, db: string, cleanup: () => void }}
 */
function withCopy(dbPath) {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-cookies-"));
  const target = join(dir, "cookies.sqlite");
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) {
      try {
        copyFileSync(source, `${target}${suffix}`);
      } catch {
        // A locked sidecar is not fatal: the main database copy is usually enough.
      }
    }
  }
  const cleanupFn = () => {
    activeCookieCleanups.delete(cleanupFn);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  };
  activeCookieCleanups.add(cleanupFn);
  return {
    dir,
    db: target,
    cleanup: cleanupFn,
  };
}

/**
 * Query Firefox's `moz_cookies`.
 *
 * @param {string} dbPath
 * @param {{ hostLike: string, name?: string }} query
 * @returns {Array<{ host: string, name: string, value: string, path: string }>}
 */
export function readFirefoxCookies(dbPath, query) {
  const copy = withCopy(dbPath);
  let database;
  try {
    try {
      database = new DatabaseSync(copy.db, { readOnly: true });
    } catch {
      database = new DatabaseSync(copy.db);
    }
    const sql = query.name
      ? "select host, name, value, path from moz_cookies where host like ? and name = ?"
      : "select host, name, value, path from moz_cookies where host like ?";
    const statement = database.prepare(sql);
    const rows = query.name
      ? statement.all(query.hostLike, query.name)
      : statement.all(query.hostLike);
    return /** @type {Array<{ host: string, name: string, value: string, path: string }>} */ (rows);
  } catch {
    return [];
  } finally {
    try {
      database?.close();
    } catch {
      // Ignore.
    }
    copy.cleanup();
  }
}

/**
 * Query Chromium's `cookies` table from a private database copy.
 *
 * @param {string} dbPath
 * @param {{ hostLike: string, name?: string }} query
 * @returns {Array<{ host: string, name: string, value: string, encrypted_value: Buffer, path: string }>}
 */
function readChromiumCookies(dbPath, query) {
  const copy = withCopy(dbPath);
  let database;
  try {
    database = new DatabaseSync(copy.db, { readOnly: true });
    const sql = query.name
      ? "select host_key as host, name, value, encrypted_value, path from cookies where host_key like ? and name = ?"
      : "select host_key as host, name, value, encrypted_value, path from cookies where host_key like ?";
    const rows = query.name
      ? database.prepare(sql).all(query.hostLike, query.name)
      : database.prepare(sql).all(query.hostLike);
    return /** @type {Array<{ host: string, name: string, value: string, encrypted_value: Buffer, path: string }>} */ (rows);
  } catch {
    return [];
  } finally {
    try { database?.close(); } catch {}
    copy.cleanup();
  }
}

/**
 * Find one cookie across every readable store.
 *
 * @param {{
 *   host: string,
 *   name: string,
 *   stores?: CookieStore[],
 *   home?: string,
 *   usersRoot?: string,
 *   platform?: string,
 *   secretTool?: (args: string[]) => string | null,
 * }} options
 * @returns {{
 *   found: boolean,
 *   value?: string,
 *   store?: CookieStore,
 *   candidates: number,
 *   encryptedOnly: boolean,
 * }}
 */
export function findCookie(options) {
  const stores = options.stores ?? discoverCookieStores(options);
  const readable = stores.filter((store) => store.readability === "plaintext");
  let scanned = 0;

  for (const store of readable) {
    scanned += 1;
    const query = { hostLike: `%${options.host}%`, name: options.name };
    const rows = store.browser === "firefox"
      ? readFirefoxCookies(store.path, query)
      : readChromiumCookies(store.path, query);
    for (const row of rows) {
      if (row.value && row.value.length > 0) {
        return { found: true, value: row.value, store, candidates: scanned, encryptedOnly: false };
      }
      if (store.browser === "chromium" && row.encrypted_value?.length > 0) {
        const value = decryptLinuxChromiumCookie(row.encrypted_value, {
          app: store.app ?? "chromium",
          secretTool: options.secretTool,
        });
        if (value) return { found: true, value, store, candidates: scanned, encryptedOnly: false };
      }
    }
  }

  return {
    found: false,
    candidates: scanned,
    encryptedOnly: scanned === 0 && stores.length > 0,
  };
}
