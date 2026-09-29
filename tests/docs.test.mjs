/**
 * Documentation structure.
 *
 * These files are edited by inserting blocks into an indented list, which is how a
 * table row once lost its two leading spaces, fell out of its list item, and merged
 * with the paragraph above: the README rendered a flat run of pipes instead of a
 * table. Nothing in the suite noticed, because nothing was reading the docs.
 *
 * So this checks the shape rather than the prose: table rows that keep one
 * indentation, a header separator where a table starts, balanced code fences, and
 * every relative link and anchor actually resolving.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = ["README.md", "AGENTS.md", "docs/AUTH-FIELDS.md", "docs/MOSHI.md", "docs/OS-COMPATIBILITY.md"];

/** @param {string} path */
function linesOf(path) {
  return readFileSync(join(ROOT, path), "utf-8").split("\n");
}

/**
 * GitHub's heading anchor rules: lowercase, drop anything that is not a word
 * character, a space or a hyphen, then spaces become hyphens.
 *
 * @param {string} heading
 * @returns {string}
 */
function slugOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** @param {string} line */
function indentOf(line) {
  return line.length - line.trimStart(" ").length;
}

/** @param {string} line */
function isTableRow(line) {
  return line.trimStart().startsWith("|");
}

/** @returns {Array<{ path: string, line: number, text: string, inFence: boolean }>} */
function eachLine() {
  const out = [];
  for (const path of DOCS) {
    let inFence = false;
    linesOf(path).forEach((text, index) => {
      const opensFence = text.trim().startsWith("```");
      out.push({ path, line: index + 1, text, inFence: inFence && !opensFence });
      if (opensFence) inFence = !inFence;
    });
  }
  return out;
}

test("every table row keeps the indentation of the table it belongs to", () => {
  const offenders = [];
  for (const path of DOCS) {
    const lines = linesOf(path);
    let inFence = false;
    let previousIndent = null;
    lines.forEach((line, index) => {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      if (!isTableRow(line)) {
        previousIndent = null;
        return;
      }
      const indent = indentOf(line);
      if (previousIndent !== null && indent !== previousIndent) {
        offenders.push(`${path}:${index + 1} is indented ${indent}, the row above is ${previousIndent}`);
      }
      previousIndent = indent;
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("a table always starts with a header separator row", () => {
  const offenders = [];
  for (const path of DOCS) {
    const lines = linesOf(path);
    let inFence = false;
    lines.forEach((line, index) => {
      if (line.trim().startsWith("```")) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      if (!isTableRow(line)) return;
      const previous = index > 0 ? lines[index - 1].trimStart() : "";
      if (previous.startsWith("|")) return; // not the first row of this table
      const next = index + 1 < lines.length ? lines[index + 1].trimStart() : "";
      if (!/^\|[\s:|-]+\|$/.test(next)) {
        offenders.push(`${path}:${index + 1} starts a table without a separator row`);
      }
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("no code fence is left open", () => {
  for (const path of DOCS) {
    const fences = linesOf(path).filter((line) => line.trim().startsWith("```")).length;
    assert.equal(fences % 2, 0, `${path} has ${fences} fences, which is an odd number`);
  }
});

test("every relative link points at a file that exists", () => {
  const offenders = [];
  for (const path of DOCS) {
    const from = dirname(join(ROOT, path));
    for (const match of readFileSync(join(ROOT, path), "utf-8").matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:\/\//.test(target) || target.startsWith("#")) continue;
      const [file] = target.split("#");
      if (!file) continue;
      if (!existsSync(resolve(from, file))) offenders.push(`${path} -> ${target}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("every anchor link points at a heading that exists", () => {
  /** @type {Map<string, Set<string>>} */
  const anchors = new Map();
  for (const path of DOCS) {
    anchors.set(
      path,
      new Set(linesOf(path).filter((line) => line.startsWith("#")).map((line) => slugOf(line.replace(/^#+\s*/, "")))),
    );
  }

  const offenders = [];
  for (const path of DOCS) {
    for (const match of readFileSync(join(ROOT, path), "utf-8").matchAll(/\]\(([^)\s]+#([^)\s]+))\)/g)) {
      const [file, anchor] = [match[1].split("#")[0], match[2]];
      const target = file || path;
      if (!DOCS.includes(target)) continue;
      if (!anchors.get(target)?.has(anchor)) offenders.push(`${path} -> ${target}#${anchor}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("the published test count matches the tests that exist", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
  const match = readme.match(/#\s*(\d+)\s+tests/);
  assert.ok(match, "the README no longer states how many tests exist");

  // Counted from the sources, because a suite cannot enumerate itself. Every suite
  // here declares its tests as literal `test(` calls at the start of a line.
  const dir = join(ROOT, "tests");
  let actual = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".test.mjs")) continue;
    actual += readFileSync(join(dir, name), "utf-8").split("\n").filter((line) => line.startsWith("test(")).length;
  }

  assert.equal(Number(match[1]), actual, `the README says ${match[1]} tests and ${actual} are declared`);
});
