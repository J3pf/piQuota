/**
 * Atomic writer for Omarchy agent usage records.
 *
 * This is the one place piQuota writes outside its own cache and state
 * directories, and it is opt-in (`piquota omarchy`). It only ever creates or
 * removes files named `pi-<family>.json` in Omarchy's usage directory, so
 * Omarchy's own `claude.json` / `codex.json` records are never touched.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPiRecordId, RECORD_PREFIX } from "./record.js";

/**
 * `PI_QUOTA_OMARCHY_DIR` wins; otherwise Omarchy's own location under
 * `$XDG_STATE_HOME` (default `~/.local/state`).
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string}
 */
export function resolveOmarchyDir(options = {}) {
  const env = options.env ?? process.env;
  if (env.PI_QUOTA_OMARCHY_DIR) return env.PI_QUOTA_OMARCHY_DIR;
  const state = env.XDG_STATE_HOME || join(options.home ?? homedir(), ".local", "state");
  return join(state, "omarchy", "agents", "usage");
}

/**
 * @param {string} dir
 * @param {string} id
 * @param {Record<string, unknown>} record
 * @returns {string} The final path.
 */
function writeRecord(dir, id, record) {
  const target = join(dir, `${id}.json`);
  const content = `${JSON.stringify(record)}\n`;
  if (existsSync(target)) {
    try {
      if (readFileSync(target, "utf-8") === content) {
        return target;
      }
    } catch {}
  }
  // The temp name does not end in `.json`, so Omarchy's `*.json` watcher never
  // sees a half-written file.
  const temp = join(dir, `.${id}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, content, { mode: 0o644 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return target;
}

/**
 * Copy a file only if the target does not exist or its content differs.
 * This is critical when writing to directories watched by inotify, such as
 * Omarchy's plugins directory, where redundant writes trigger full shell reloads.
 *
 * @param {string} srcPath
 * @param {string} dstPath
 * @returns {boolean} Whether the file was written.
 */
function copyIfChanged(srcPath, dstPath) {
  try {
    if (existsSync(dstPath)) {
      const srcBuf = readFileSync(srcPath);
      const dstBuf = readFileSync(dstPath);
      if (srcBuf.equals(dstBuf)) return false;
    }
    copyFileSync(srcPath, dstPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synchronize provider SVG icons into Omarchy plugin assets directories if present.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string[]} Paths of written assets.
 */
export function syncOmarchyAssets(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? (env.HOME || homedir());
  const pluginsDir = join(home, ".config", "omarchy", "plugins");
  if (!existsSync(pluginsDir)) return [];

  const assetsSrc = fileURLToPath(new URL("assets", import.meta.url));
  if (!existsSync(assetsSrc)) return [];

  const copied = [];
  try {
    for (const plugin of readdirSync(pluginsDir)) {
      const pluginDir = join(pluginsDir, plugin);
      const manifestPath = join(pluginDir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const targetAssetsDir = join(pluginDir, "assets");
      if (!existsSync(targetAssetsDir)) {
        mkdirSync(targetAssetsDir, { recursive: true });
      }

      for (const file of readdirSync(assetsSrc)) {
        if (!file.endsWith(".svg")) continue;
        const srcPath = join(assetsSrc, file);
        const dstPath = join(targetAssetsDir, file);
        const piDstPath = join(targetAssetsDir, `pi-${file}`);
        if (copyIfChanged(srcPath, dstPath)) copied.push(dstPath);
        if (copyIfChanged(srcPath, piDstPath)) copied.push(piDstPath);
      }
    }
  } catch {}
  return copied;
}

/**
 * Write the given records and remove stale `pi-*.json` files whose provider is
 * no longer present.
 *
 * @param {Array<{ id: string, record: Record<string, unknown> }>} records
 * @param {{ dir?: string, env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {{ dir: string, written: string[], removed: string[] }}
 */
export function publishRecords(records, options = {}) {
  const dir = options.dir ?? resolveOmarchyDir(options);
  mkdirSync(dir, { recursive: true });

  const written = [];
  for (const { id, record } of records) {
    if (!isPiRecordId(id)) continue;
    written.push(writeRecord(dir, id, record));
  }

  const keep = new Set(records.map(({ id }) => `${id}.json`));
  const removed = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(RECORD_PREFIX) || !name.endsWith(".json")) continue;
    if (!isPiRecordId(name.slice(0, -".json".length)) || keep.has(name)) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(join(dir, name));
  }

  syncOmarchyAssets(options);

  return { dir, written, removed };
}
