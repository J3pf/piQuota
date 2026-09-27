/**
 * gentle-pi paints its right rail from a hardcoded allowlist, so a part that
 * another extension registers under any other key is never rendered. This module
 * owns the single anchored edit that appends piQuota's part to that allowlist,
 * plus the detection that tells a patch wiped by a package update apart from an
 * unrecognized gentle-pi revision.
 *
 * The edit is deliberately narrow: it rewrites one array literal and leaves every
 * other byte of the file untouched. An unrecognized shape is reported instead of
 * guessed at, because a wrong rewrite of another extension's layout would break
 * the whole rail.
 *
 * CLI (used by install.sh and available for manual repair):
 *   node src/gentle-pi/rail-patch.js --status | --apply | --revert [--dir <path>]
 */

import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The rail part piQuota registers, and the key this module adds to the allowlist. */
export const GENTLE_PI_PART = "quota";

const LAYOUT_RELATIVE = join("lib", "shell-sidebar-layout.ts");
const BACKUP_SUFFIX = ".pi-quota-backup";
const TEMP_SUFFIX = ".pi-quota-tmp";

/** Default package roots, in the order a Pi installation is likely to have them. */
const PACKAGE_ROOTS = [
  join(homedir(), ".pi", "agent", "npm", "node_modules", "gentle-pi"),
  join(homedir(), ".pi", "agent", "gentle-ai", "node_modules", "gentle-pi"),
];

/**
 * @typedef {"patched" | "unpatched" | "unknown" | "missing"} RailPatchState
 * @typedef {{ state: RailPatchState, sections: string[], detail: string }} RailPatchInspection
 * @typedef {{ ok: boolean, changed: boolean, state: RailPatchState, detail: string, backupPath?: string }} RailPatchResult
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function reason(error) {
  const message = /** @type {{ message?: string }} */ (error)?.message;
  return message ?? String(error);
}

/**
 * Every `const sections = [...]` allowlist in the file, each with its own offsets
 * so a rewrite can replace exactly one of them.
 *
 * @param {string} text
 * @returns {Array<{ text: string, inner: string, index: number }>}
 */
function findSectionAllowlists(text) {
  const pattern = /const\s+sections\s*=\s*\[([^\]]*)\](?=\s*\.map\()/g;
  /** @type {Array<{ text: string, inner: string, index: number }>} */
  const found = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.push({ text: match[0], inner: match[1], index: match.index });
  }
  return found;
}

/**
 * @param {string} inner
 * @returns {string[]}
 */
function keysOf(inner) {
  const pattern = /"([^"]+)"/g;
  /** @type {string[]} */
  const keys = [];
  let match;
  while ((match = pattern.exec(inner)) !== null) keys.push(match[1]);
  return keys;
}

/**
 * Append a key while preserving the spacing of the entries already present.
 *
 * @param {string} inner
 * @param {string} part
 * @returns {string}
 */
function appendPart(inner, part) {
  const trimmed = inner.replace(/\s+$/, "");
  return trimmed === "" ? `"${part}"` : `${trimmed}, "${part}"`;
}

/**
 * Drop a key together with the comma that joined it, so the remaining entries keep
 * their original text and `["a", "b", "quota"]` becomes `["a", "b"]` rather than a
 * list with a dangling separator.
 *
 * @param {string} inner
 * @param {string} part
 * @returns {string}
 */
function dropPart(inner, part) {
  const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailing = new RegExp(`,\\s*"${escaped}"\\s*$`);
  if (trailing.test(inner)) return inner.replace(trailing, "");
  const leading = new RegExp(`"${escaped}"\\s*,\\s*`);
  if (leading.test(inner)) return inner.replace(leading, "");
  // The part can be the only entry, and then there is no comma to remove with it.
  const only = new RegExp(`^\\s*"${escaped}"\\s*$`);
  if (only.test(inner)) return "";
  return inner;
}

/**
 * @param {string} layoutPath
 * @param {string} text
 */
function writeAtomically(layoutPath, text) {
  const temp = `${layoutPath}${TEMP_SUFFIX}`;
  try {
    writeFileSync(temp, text, "utf-8");
    renameSync(temp, layoutPath);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // The temp file is either gone or unreachable; the caller reports the real failure.
    }
    throw error;
  }
}

/**
 * @param {string} dir
 * @returns {{ dir: string, layoutPath: string, present: boolean }}
 */
function layoutFor(dir) {
  const layoutPath = join(dir, LAYOUT_RELATIVE);
  return { dir, layoutPath, present: existsSync(layoutPath) };
}

/**
 * Locate the installed gentle-pi package and the layout file this module edits.
 * An explicit `dir` or `PI_QUOTA_GENTLE_PI_DIR` is authoritative: when it holds no
 * layout file the answer is "not present" rather than a different installation.
 *
 * @param {{ dir?: string }} [options]
 * @returns {{ dir: string, layoutPath: string, present: boolean }}
 */
export function resolveGentlePiLayout(options = {}) {
  if (options.dir) return layoutFor(options.dir);
  const override = process.env.PI_QUOTA_GENTLE_PI_DIR;
  if (override) return layoutFor(override);
  for (const root of PACKAGE_ROOTS) {
    const layout = layoutFor(root);
    if (layout.present) return layout;
  }
  return layoutFor(PACKAGE_ROOTS[0]);
}

/**
 * @param {{ layoutPath: string }} options
 * @returns {RailPatchInspection}
 */
export function inspectRailPatch({ layoutPath }) {
  let text;
  try {
    text = readFileSync(layoutPath, "utf-8");
  } catch (error) {
    return { state: "missing", sections: [], detail: `cannot read ${layoutPath}: ${reason(error)}` };
  }

  const allowlists = findSectionAllowlists(text);
  if (allowlists.length === 0) {
    return { state: "unknown", sections: [], detail: "no rail section allowlist found; refusing to guess" };
  }
  if (allowlists.length > 1) {
    return { state: "unknown", sections: [], detail: `expected one rail section allowlist, found ${allowlists.length}` };
  }

  const sections = keysOf(allowlists[0].inner);
  if (sections.includes(GENTLE_PI_PART)) {
    return { state: "patched", sections, detail: `the rail already renders "${GENTLE_PI_PART}"` };
  }
  return { state: "unpatched", sections, detail: `the rail renders: ${sections.join(", ") || "(nothing)"}` };
}

/**
 * Append the part to the allowlist. Idempotent, atomic, and verified: the file is
 * re-read after the write and restored from the backup when the result does not
 * read back as patched.
 *
 * @param {{ layoutPath: string }} options
 * @returns {RailPatchResult}
 */
export function applyRailPatch({ layoutPath }) {
  const inspected = inspectRailPatch({ layoutPath });
  if (inspected.state === "patched") {
    return { ok: true, changed: false, state: "patched", detail: inspected.detail };
  }
  if (inspected.state !== "unpatched") {
    return { ok: false, changed: false, state: inspected.state, detail: inspected.detail };
  }

  let original;
  try {
    original = readFileSync(layoutPath, "utf-8");
  } catch (error) {
    return { ok: false, changed: false, state: "missing", detail: `cannot read ${layoutPath}: ${reason(error)}` };
  }

  const allowlist = findSectionAllowlists(original)[0];
  const replacement = `const sections = [${appendPart(allowlist.inner, GENTLE_PI_PART)}]`;
  const patched = original.slice(0, allowlist.index) + replacement + original.slice(allowlist.index + allowlist.text.length);

  const backupPath = `${layoutPath}${BACKUP_SUFFIX}`;
  try {
    if (!existsSync(backupPath)) copyFileSync(layoutPath, backupPath);
    writeAtomically(layoutPath, patched);
  } catch (error) {
    return { ok: false, changed: false, state: "unpatched", detail: `could not write ${layoutPath}: ${reason(error)}`, backupPath };
  }

  const verified = inspectRailPatch({ layoutPath });
  if (verified.state !== "patched") {
    try {
      copyFileSync(backupPath, layoutPath);
    } catch {
      // The restore is best effort; the report below is the authoritative outcome.
    }
    return { ok: false, changed: true, state: verified.state, detail: `the edit did not read back as patched (${verified.detail}); restored from backup`, backupPath };
  }
  return { ok: true, changed: true, state: "patched", detail: `added "${GENTLE_PI_PART}" to the rail allowlist`, backupPath };
}

/**
 * Remove the part from the allowlist, restoring the original bytes for a file this
 * module patched.
 *
 * @param {{ layoutPath: string }} options
 * @returns {RailPatchResult}
 */
export function revertRailPatch({ layoutPath }) {
  const inspected = inspectRailPatch({ layoutPath });
  if (inspected.state === "missing" || inspected.state === "unknown") {
    return { ok: false, changed: false, state: inspected.state, detail: inspected.detail };
  }
  if (inspected.state === "unpatched") {
    return { ok: true, changed: false, state: "unpatched", detail: `the rail already excludes "${GENTLE_PI_PART}"` };
  }

  let original;
  try {
    original = readFileSync(layoutPath, "utf-8");
  } catch (error) {
    return { ok: false, changed: false, state: "missing", detail: `cannot read ${layoutPath}: ${reason(error)}` };
  }

  const allowlist = findSectionAllowlists(original)[0];
  const replacement = `const sections = [${dropPart(allowlist.inner, GENTLE_PI_PART)}]`;
  const reverted = original.slice(0, allowlist.index) + replacement + original.slice(allowlist.index + allowlist.text.length);

  const backupPath = `${layoutPath}${BACKUP_SUFFIX}`;
  try {
    writeAtomically(layoutPath, reverted);
  } catch (error) {
    return { ok: false, changed: false, state: "patched", detail: `could not write ${layoutPath}: ${reason(error)}`, backupPath };
  }

  const verified = inspectRailPatch({ layoutPath });
  if (verified.state !== "unpatched") {
    try {
      copyFileSync(backupPath, layoutPath);
    } catch {
      // The restore is best effort; the report below is the authoritative outcome.
    }
    return { ok: false, changed: true, state: verified.state, detail: `the revert did not read back as unpatched (${verified.detail}); restored from backup`, backupPath };
  }
  return { ok: true, changed: true, state: "unpatched", detail: `removed "${GENTLE_PI_PART}" from the rail allowlist`, backupPath };
}

/**
 * The validator the extension and the installer both call: report whether the rail
 * renders the part, and repair it when a gentle-pi update wiped the patch.
 *
 * @param {{ layoutPath: string }} options
 * @returns {RailPatchResult & { repaired: boolean }}
 */
export function ensureRailPatch({ layoutPath }) {
  const inspected = inspectRailPatch({ layoutPath });
  if (inspected.state === "patched") {
    return { repaired: false, ok: true, changed: false, state: "patched", detail: inspected.detail };
  }
  const applied = applyRailPatch({ layoutPath });
  return { ...applied, repaired: applied.changed === true };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function runCli(argv) {
  const action = argv.includes("--revert") ? "revert" : argv.includes("--apply") ? "apply" : "status";
  const dirIndex = argv.indexOf("--dir");
  const dir = dirIndex >= 0 ? argv[dirIndex + 1] : undefined;

  const layout = resolveGentlePiLayout(dir ? { dir } : {});
  if (!layout.present) {
    process.stdout.write(`gentle-pi not found at ${layout.layoutPath}\n`);
    process.stdout.write("nothing to do: piQuota renders its own widget without the rail\n");
    return 0;
  }

  if (action === "status") {
    const inspected = inspectRailPatch({ layoutPath: layout.layoutPath });
    process.stdout.write(`gentle-pi: ${layout.layoutPath}\n`);
    process.stdout.write(`rail patch: ${inspected.state} (${inspected.detail})\n`);
    if (inspected.state !== "patched") {
      process.stdout.write("run `piquota gentle-pi apply`, or let the extension repair it at session start\n");
    }
    return inspected.state === "unknown" ? 1 : 0;
  }

  const result = action === "revert" ? revertRailPatch({ layoutPath: layout.layoutPath }) : applyRailPatch({ layoutPath: layout.layoutPath });
  process.stdout.write(`gentle-pi: ${layout.layoutPath}\n`);
  process.stdout.write(`rail patch: ${result.state} — ${result.detail}\n`);
  if (result.backupPath) process.stdout.write(`backup: ${result.backupPath}\n`);
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exit(runCli(process.argv.slice(2)));
