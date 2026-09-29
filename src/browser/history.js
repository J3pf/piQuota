/**
 * Read-only Firefox history lookup.
 *
 * Needed because opencode.ai serves the workspace app only at
 * `/workspace/<id>/...`: there is no listing page at `/workspace` (it answers
 * 404 even when authenticated), so the id has to be observed. Firefox records
 * the URL the OAuth flow lands on, which makes its history the reliable source.
 *
 * Read-only: `places.sqlite` (with `-wal`/`-shm`) is copied to a private temp
 * directory and opened there. Only URLs are read, and query strings are never
 * returned to callers.
 */

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { firefoxRoots, parseFirefoxProfiles } from "./cookies.js";

/**
 * @param {{ home?: string, usersRoot?: string, platform?: string }} [options]
 * @returns {Array<{ profile: string, path: string }>}
 */
export function discoverHistoryStores(options = {}) {
  /** @type {Array<{ profile: string, path: string }>} */
  const stores = [];
  for (const root of firefoxRoots(options)) {
    for (const profile of parseFirefoxProfiles(root)) {
      const path = join(profile.dir, "places.sqlite");
      if (!existsSync(path)) continue;
      stores.push({ profile: `${root.endsWith("Firefox") ? "windows" : "linux"}:${profile.label}`, path });
    }
  }
  return stores;
}

/**
 * Strip the query string so no token can leak through a URL.
 *
 * @param {string} url
 * @returns {string}
 */
export function pathOnly(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return String(url).split("?")[0];
  }
}

/**
 * Extract workspace ids from a list of URLs, most recent first.
 *
 * @param {string[]} urls
 * @returns {string[]}
 */
export function extractWorkspaceIds(urls) {
  /** @type {string[]} */
  const ids = [];
  const ignored = new Set(["settings", "usage", "go", "keys", "members", "billing", "new", "login", "auth"]);
  for (const url of urls) {
    const match = pathOnly(url).match(/\/(?:workspace|console)\/([A-Za-z0-9_-]{4,})/);
    if (!match) continue;
    if (ignored.has(match[1])) continue;
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/**
 * Query one history database.
 *
 * @param {string} dbPath
 * @param {{ urlLike: string, limit?: number }} query
 * @returns {string[]}
 */
const activeHistoryCleanups = new Set();
if (typeof process !== "undefined" && typeof process.on === "function") {
  const runCleanups = () => {
    for (const fn of activeHistoryCleanups) {
      try { fn(); } catch {}
    }
    activeHistoryCleanups.clear();
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

export function readVisitedUrls(dbPath, query) {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-history-"));
  const target = join(dir, "places.sqlite");
  const cleanupFn = () => {
    activeHistoryCleanups.delete(cleanupFn);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  };
  activeHistoryCleanups.add(cleanupFn);

  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const source = `${dbPath}${suffix}`;
      if (existsSync(source)) {
        try {
          copyFileSync(source, `${target}${suffix}`);
        } catch {
          // A locked sidecar is not fatal.
        }
      }
    }
    let database;
    try {
      database = new DatabaseSync(target, { readOnly: true });
    } catch {
      database = new DatabaseSync(target);
    }
    try {
      const rows = database
        .prepare("select url from moz_places where url like ? order by last_visit_date desc limit ?")
        .all(query.urlLike, query.limit ?? 50);
      return /** @type {Array<{ url: string }>} */ (rows).map((row) => row.url).filter(Boolean);
    } finally {
      try {
        database.close();
      } catch {
        // Ignore.
      }
    }
  } catch {
    return [];
  } finally {
    cleanupFn();
  }
}

/**
 * Find recently visited workspace ids, newest first.
 *
 * @param {{
 *   stores?: Array<{ profile: string, path: string }>,
 *   home?: string,
 *   usersRoot?: string,
 *   platform?: string,
 * }} [options]
 * @returns {{ ids: string[], profile: string | null, scanned: number }}
 */
export function findRecentWorkspaceIds(options = {}) {
  const stores = options.stores ?? discoverHistoryStores(options);
  let scanned = 0;
  for (const store of stores) {
    scanned += 1;
    const urls = readVisitedUrls(store.path, { urlLike: "%opencode.ai/%", limit: 100 });
    const ids = extractWorkspaceIds(urls);
    if (ids.length > 0) return { ids, profile: store.profile, scanned };
  }
  return { ids: [], profile: null, scanned };
}
