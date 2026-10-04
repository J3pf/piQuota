/**
 * Atomic writer for Omarchy agent usage records.
 *
 * This is the one place piQuota writes outside its own cache and state
 * directories, and it is opt-in (`piquota omarchy`). It only ever creates or
 * removes files named `pi-<family>.json` in Omarchy's usage directory, so
 * Omarchy's own `claude.json` / `codex.json` records are never touched.
 */

import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  // The temp name does not end in `.json`, so Omarchy's `*.json` watcher never
  // sees a half-written file.
  const temp = join(dir, `.${id}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o644 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return target;
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
  return { dir, written, removed };
}
