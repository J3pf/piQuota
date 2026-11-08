/**
 * Atomic writer for Omarchy agent usage records.
 *
 * This is the one place piQuota writes outside its own cache and state
 * directories, and it is opt-in (`piquota omarchy`). It only ever creates or
 * removes files named `pi-<family>.json` in Omarchy's usage directory, so
 * Omarchy's own `claude.json` / `codex.json` records are never touched.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
 * Compare two serialized Omarchy records ignoring `updatedAt` so identical
 * quota snapshots do not trigger redundant disk writes and `inotify` reloads.
 *
 * @param {string} existingRaw
 * @param {Record<string, unknown>} nextRecord
 * @returns {boolean}
 */
function recordsEqualIgnoringTimestamp(existingRaw, nextRecord) {
  try {
    const existing = JSON.parse(existingRaw);
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
    return (
      JSON.stringify({ ...existing, updatedAt: "" }) ===
      JSON.stringify({ ...nextRecord, updatedAt: "" })
    );
  } catch {
    return false;
  }
}

/**
 * @param {string} dir
 * @param {string} id
 * @param {Record<string, unknown>} record
 * @returns {{ path: string, created: boolean }}
 */
function writeRecord(dir, id, record) {
  const target = join(dir, `${id}.json`);
  const content = `${JSON.stringify(record)}\n`;
  const existed = existsSync(target);
  if (existed) {
    try {
      const existingRaw = readFileSync(target, "utf-8");
      if (existingRaw === content || recordsEqualIgnoringTimestamp(existingRaw, record)) {
        return { path: target, created: false };
      }
    } catch {}
  }
  // The temp name does not end in `.json`, so Omarchy's `*.json` watcher never
  // sees a half-written file.
  const temp = join(dir, `.${id}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, content, { mode: 0o644 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { path: target, created: !existed };
}

/** @type {Array<{ file: string, buf: Buffer }> | null} */
let cachedSvgAssets = null;

/**
 * Load bundled SVG assets from `src/omarchy/assets/` once per process.
 *
 * @returns {Array<{ file: string, buf: Buffer }>}
 */
function loadBundledSvgAssets() {
  if (cachedSvgAssets) return cachedSvgAssets;
  const assetsSrc = fileURLToPath(new URL("assets", import.meta.url));
  if (!existsSync(assetsSrc)) return [];
  const entries = [];
  try {
    for (const file of readdirSync(assetsSrc)) {
      if (!file.endsWith(".svg")) continue;
      entries.push({ file, buf: readFileSync(join(assetsSrc, file)) });
    }
    cachedSvgAssets = entries;
  } catch {}
  return entries;
}

/**
 * Copy a buffer only if the target does not exist or its content differs.
 * This is critical when writing to directories watched by inotify, such as
 * Omarchy's plugins directory, where redundant writes trigger full shell reloads.
 *
 * @param {Buffer} srcBuf
 * @param {string} dstPath
 * @returns {boolean} Whether the file was written.
 */
function writeBufferIfChanged(srcBuf, dstPath) {
  const tempPath = join(dirname(dstPath), `.${basename(dstPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    try {
      const dstStat = statSync(dstPath);
      if (dstStat.size === srcBuf.length) {
        const dstBuf = readFileSync(dstPath);
        if (srcBuf.equals(dstBuf)) return false;
      }
    } catch {}
    writeFileSync(tempPath, srcBuf, { mode: 0o644 });
    renameSync(tempPath, dstPath);
    return true;
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {}
    return false;
  }
}

/**
 * Synchronize provider SVG icons into Omarchy agent/stats plugin assets directories if present.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string }} [options]
 * @returns {string[]} Paths of written assets.
 */
export function syncOmarchyAssets(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? (env.HOME || homedir());
  const pluginsDir = join(home, ".config", "omarchy", "plugins");
  if (!existsSync(pluginsDir)) return [];

  const svgAssets = loadBundledSvgAssets();
  if (svgAssets.length === 0) return [];

  const copied = [];
  try {
    for (const plugin of readdirSync(pluginsDir)) {
      if (!/agent|stat|quota|usage/i.test(plugin)) continue;
      const pluginDir = join(pluginsDir, plugin);
      const manifestPath = join(pluginDir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      const targetAssetsDir = join(pluginDir, "assets");
      if (!existsSync(targetAssetsDir)) {
        mkdirSync(targetAssetsDir, { recursive: true });
      }

      for (const { file, buf } of svgAssets) {
        const dstPath = join(targetAssetsDir, file);
        const piDstPath = join(targetAssetsDir, `pi-${file}`);
        if (writeBufferIfChanged(buf, dstPath)) copied.push(dstPath);
        if (writeBufferIfChanged(buf, piDstPath)) copied.push(piDstPath);
      }
    }
  } catch {}
  return copied;
}

/**
 * Best-effort notification to the running Omarchy shell (`omarchy.agents`) so
 * newly created or deleted `pi-*.json` files are discovered immediately without
 * waiting for the 15-minute `refreshIntervalSec` rescan timer.
 */
function notifyOmarchyShell() {
  try {
    const child = spawn("omarchy-shell", ["-q", "omarchy.agents", "refresh"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/**
 * Write the given records and remove stale `pi-*.json` files whose provider is
 * no longer present.
 *
 * @param {Array<{ id: string, record: Record<string, unknown> }>} records
 * @param {{ dir?: string, env?: Record<string, string | undefined>, home?: string, notify?: boolean, notifyFn?: (info: { dir: string, created: string[], removed: string[] }) => void }} [options]
 * @returns {{ dir: string, written: string[], created: string[], removed: string[] }}
 */
export function publishRecords(records, options = {}) {
  const dir = options.dir ?? resolveOmarchyDir(options);
  mkdirSync(dir, { recursive: true });

  const written = [];
  const created = [];
  for (const { id, record } of records) {
    if (!isPiRecordId(id)) continue;
    const outcome = writeRecord(dir, id, record);
    written.push(outcome.path);
    if (outcome.created) created.push(outcome.path);
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

  if (created.length > 0 || removed.length > 0) {
    if (typeof options.notifyFn === "function") {
      try {
        options.notifyFn({ dir, created, removed });
      } catch {}
    } else if (options.notify === true) {
      notifyOmarchyShell();
    }
  }

  return { dir, written, created, removed };
}
