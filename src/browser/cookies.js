/**
 * Read-only browser cookie access.
 *
 * Only used to obtain the opencode.ai session cookie that Pi does not store.
 * Guarantees:
 *   - the browser database is never opened in place: it is copied to a private
 *     temporary directory (including `-wal`/`-shm`) and opened read-only there;
 *   - cookie values are returned to the caller but never logged, printed or
 *     written to the cache;
 *   - nothing is decrypted that the platform does not allow: Chrome on Windows
 *     encrypts cookie values with DPAPI, which is unavailable from WSL, so that
 *     case is reported instead of guessed.
 */

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
  } else {
    roots.push(
      join(home, ".mozilla", "firefox"),
      join(home, ".config", "mozilla", "firefox"),
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
 * @param {{ home?: string, usersRoot?: string, platform?: string }} [options]
 * @returns {CookieStore[]}
 */
export function discoverCookieStores(options = {}) {
  /** @type {CookieStore[]} */
  const stores = [];
  for (const root of firefoxRoots(options)) {
    for (const profile of parseFirefoxProfiles(root)) {
      stores.push({
        browser: "firefox",
        path: join(profile.dir, "cookies.sqlite"),
        profile: `${root.endsWith("Firefox") ? "windows" : "linux"}:${profile.label}${profile.isDefault ? " (default)" : ""}`,
        readability: "plaintext",
      });
    }
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
 * Find one cookie across every readable store.
 *
 * @param {{
 *   host: string,
 *   name: string,
 *   stores?: CookieStore[],
 *   home?: string,
 *   usersRoot?: string,
 *   platform?: string,
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
    const rows = readFirefoxCookies(store.path, { hostLike: `%${options.host}%`, name: options.name });
    const match = rows.find((row) => row.value && row.value.length > 0);
    if (match) return { found: true, value: match.value, store, candidates: scanned, encryptedOnly: false };
  }

  return {
    found: false,
    candidates: scanned,
    encryptedOnly: scanned === 0 && stores.length > 0,
  };
}
