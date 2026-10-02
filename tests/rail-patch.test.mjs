/**
 * Rail patch contract tests.
 *
 * These pin the properties that keep a third-party package safe to edit: the edit
 * is narrow, idempotent, reversible, and refused outright when the file does not
 * look like the revision this module knows. The fixture reproduces the real
 * gentle-pi 3.3.0 shape, including a decoy `quota` string that must not be touched.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GENTLE_PI_PART,
  applyRailPatch,
  ensureRailPatch,
  inspectRailPatch,
  resolveGentlePiLayout,
  revertRailPatch,
} from "../src/gentle-pi/rail-patch.js";

const LAYOUT_RELATIVE = join("lib", "shell-sidebar-layout.ts");

/** The real allowlist line, surrounded by enough context to prove nothing else moves. */
const FIXTURE = `import { ScrollView, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { sidebarState } from "./shell-sidebar.ts";

export const SIDEBAR_BREAKPOINT = 140;
const RAIL_WIDTH = 50;
const QUOTA_HINT = "quota is not a rail key in this revision";
const unrelated = ["quota"];

export function installSidebar(tui, theme) {
  const prepare = (width, root) => {
    const sections = ["footer", "agents", "todo"].map((key) => {
      const component = state.parts.get(key);
      return { key, component, lines: [] };
    }).filter((section) => section.component !== undefined);
    const railLines = [];
    for (const section of sections) railLines.push(...section.lines);
    return railLines;
  };
  return prepare;
}
`;

/**
 * @param {string} contents
 * @returns {{ dir: string, layoutPath: string }}
 */
function fixture(contents = FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-rail-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "gentle-pi", version: "3.3.0" }), "utf-8");
  mkdirSync(join(dir, "lib"), { recursive: true });
  const layoutPath = join(dir, LAYOUT_RELATIVE);
  writeFileSync(layoutPath, contents, "utf-8");
  return { dir, layoutPath };
}

test("resolveGentlePiLayout uses an explicit dir and reports a missing layout", () => {
  const present = fixture();
  const found = resolveGentlePiLayout({ dir: present.dir });
  assert.equal(found.present, true);
  assert.equal(found.layoutPath, present.layoutPath);

  const empty = mkdtempSync(join(tmpdir(), "pi-quota-rail-empty-"));
  const absent = resolveGentlePiLayout({ dir: empty });
  assert.equal(absent.present, false);
  assert.equal(absent.layoutPath, join(empty, LAYOUT_RELATIVE));
});

test("resolveGentlePiLayout honours PI_QUOTA_GENTLE_PI_DIR", () => {
  const target = fixture();
  const previous = process.env.PI_QUOTA_GENTLE_PI_DIR;
  process.env.PI_QUOTA_GENTLE_PI_DIR = target.dir;
  try {
    const found = resolveGentlePiLayout();
    assert.equal(found.layoutPath, target.layoutPath);
    assert.equal(found.present, true);
  } finally {
    if (previous === undefined) delete process.env.PI_QUOTA_GENTLE_PI_DIR;
    else process.env.PI_QUOTA_GENTLE_PI_DIR = previous;
  }
});

test("inspectRailPatch reads the real allowlist as unpatched", () => {
  const { layoutPath } = fixture();
  const inspected = inspectRailPatch({ layoutPath });
  assert.equal(inspected.state, "unpatched");
  assert.deepEqual(inspected.sections, ["footer", "agents", "todo"]);
});

test("applyRailPatch appends the part and leaves every other byte identical", () => {
  const { layoutPath } = fixture();
  const before = readFileSync(layoutPath, "utf-8");
  const result = applyRailPatch({ layoutPath });

  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.state, "patched");

  const after = readFileSync(layoutPath, "utf-8");
  assert.ok(after.includes(`const sections = ["footer", "agents", "todo", "${GENTLE_PI_PART}"]`));
  assert.equal(after, before.replace('["footer", "agents", "todo"]', `["footer", "agents", "todo", "${GENTLE_PI_PART}"]`));
  assert.deepEqual(inspectRailPatch({ layoutPath }).sections, ["footer", "agents", "todo", "quota"]);
});

test("applyRailPatch is idempotent", () => {
  const { layoutPath } = fixture();
  assert.equal(applyRailPatch({ layoutPath }).changed, true);
  const patched = readFileSync(layoutPath, "utf-8");

  const second = applyRailPatch({ layoutPath });
  assert.equal(second.ok, true);
  assert.equal(second.changed, false);
  assert.equal(readFileSync(layoutPath, "utf-8"), patched, "a second apply must not write again");
});

test("revertRailPatch restores the exact original bytes", () => {
  const { layoutPath } = fixture();
  const original = readFileSync(layoutPath, "utf-8");
  applyRailPatch({ layoutPath });

  const result = revertRailPatch({ layoutPath });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.state, "unpatched");
  assert.equal(readFileSync(layoutPath, "utf-8"), original, "the revert must be byte-exact");
});

test("revertRailPatch is a no-op when the part is already absent", () => {
  const { layoutPath } = fixture();
  const before = readFileSync(layoutPath, "utf-8");
  const result = revertRailPatch({ layoutPath });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(layoutPath, "utf-8"), before);
});

test("an unrecognized shape is reported instead of rewritten", () => {
  const { layoutPath } = fixture("const sections = readSections();\nconst other = 1;\n");
  const before = readFileSync(layoutPath, "utf-8");

  const inspected = inspectRailPatch({ layoutPath });
  assert.equal(inspected.state, "unknown");

  const result = applyRailPatch({ layoutPath });
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(layoutPath, "utf-8"), before, "an unknown shape must never be written");
});

test("two candidate allowlists are refused rather than guessed at", () => {
  const { layoutPath } = fixture(
    'const sections = ["footer", "agents", "todo"].map((key) => key);\nconst sections = ["footer", "todo"].map((key) => key);\n',
  );
  const before = readFileSync(layoutPath, "utf-8");

  assert.equal(inspectRailPatch({ layoutPath }).state, "unknown");
  assert.equal(applyRailPatch({ layoutPath }).ok, false);
  assert.equal(readFileSync(layoutPath, "utf-8"), before);
});

test("a missing layout file is reported and never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-quota-rail-missing-"));
  const layoutPath = join(dir, LAYOUT_RELATIVE);

  assert.equal(inspectRailPatch({ layoutPath }).state, "missing");
  const applied = applyRailPatch({ layoutPath });
  assert.equal(applied.ok, false);
  assert.equal(applied.changed, false);
  assert.equal(revertRailPatch({ layoutPath }).ok, false);
  assert.equal(ensureRailPatch({ layoutPath }).ok, false);
});

test("an allowlist with different keys still receives the part", () => {
  const { layoutPath } = fixture('const sections = ["footer", "changes", "todo"].map((key) => key);\n');
  const result = applyRailPatch({ layoutPath });
  assert.equal(result.ok, true);
  assert.deepEqual(inspectRailPatch({ layoutPath }).sections, ["footer", "changes", "todo", "quota"]);
});

test("an empty allowlist becomes a single entry", () => {
  const { layoutPath } = fixture("const sections = [].map((key) => key);\n");
  assert.equal(applyRailPatch({ layoutPath }).ok, true);
  assert.deepEqual(inspectRailPatch({ layoutPath }).sections, ["quota"]);
  assert.equal(revertRailPatch({ layoutPath }).ok, true);
  assert.deepEqual(inspectRailPatch({ layoutPath }).sections, []);
});

test("the backup keeps the pre-patch bytes and is written once", () => {
  const { layoutPath } = fixture();
  const original = readFileSync(layoutPath, "utf-8");
  const backupPath = `${layoutPath}.pi-quota-backup`;

  const first = applyRailPatch({ layoutPath });
  assert.equal(first.backupPath, backupPath);
  assert.equal(readFileSync(backupPath, "utf-8"), original);

  revertRailPatch({ layoutPath });
  applyRailPatch({ layoutPath });
  assert.equal(readFileSync(backupPath, "utf-8"), original, "a later apply must not overwrite the backup");
});

test("other occurrences of the word quota are never touched", () => {
  const { layoutPath } = fixture();
  applyRailPatch({ layoutPath });
  const after = readFileSync(layoutPath, "utf-8");

  assert.ok(after.includes('const QUOTA_HINT = "quota is not a rail key in this revision";'));
  assert.ok(after.includes('const unrelated = ["quota"];'), "a different array must not be rewritten");
  assert.equal(after.match(/"quota"/g)?.length, 2, "only the decoy array and the appended part carry the quoted key");
});

test("ensureRailPatch reports a repair only when a wipe was actually undone", () => {
  const { layoutPath } = fixture();

  const first = ensureRailPatch({ layoutPath });
  assert.equal(first.repaired, true);
  assert.equal(first.state, "patched");

  const second = ensureRailPatch({ layoutPath });
  assert.equal(second.repaired, false);
  assert.equal(second.ok, true);

  // Simulate a gentle-pi update replacing the file with the stock revision.
  writeFileSync(layoutPath, FIXTURE, "utf-8");
  assert.equal(inspectRailPatch({ layoutPath }).state, "unpatched");

  const third = ensureRailPatch({ layoutPath });
  assert.equal(third.repaired, true);
  assert.equal(third.ok, true);
  assert.equal(inspectRailPatch({ layoutPath }).state, "patched");
});

test("gentle-shell 4.0.0 pipeline with .filter().map() is recognized and patched cleanly", () => {
  const v4Fixture = `export function installSidebar(tui, theme) {
    const sections = ["footer", "agents", "todo"].filter((key) => key !== "todo" || state.visibility?.todo !== false).map((key) => {
      const component = state.parts.get(key);
      return { key, component, lines: [] };
    });
    return sections;
  }`;
  const { layoutPath } = fixture(v4Fixture);

  const inspected = inspectRailPatch({ layoutPath });
  assert.equal(inspected.state, "unpatched");
  assert.deepEqual(inspected.sections, ["footer", "agents", "todo"]);

  const applied = applyRailPatch({ layoutPath });
  assert.equal(applied.ok, true);
  assert.equal(applied.changed, true);
  assert.equal(applied.state, "patched");

  const content = readFileSync(layoutPath, "utf-8");
  assert.ok(content.includes('const sections = ["footer", "agents", "todo", "quota"].filter('));
  assert.ok(content.includes('.filter((key) => key !== "todo" || state.visibility?.todo !== false).map('));

  const reverted = revertRailPatch({ layoutPath });
  assert.equal(reverted.ok, true);
  assert.equal(readFileSync(layoutPath, "utf-8"), v4Fixture);
});

test("single-quoted and multiline allowlists are recognized and patched", () => {
  const multilineFixture = `const sections = [
    'footer',
    'agents',
    'todo'
  ].map((k) => k);`;
  const { layoutPath } = fixture(multilineFixture);

  const inspected = inspectRailPatch({ layoutPath });
  assert.equal(inspected.state, "unpatched");
  assert.deepEqual(inspected.sections, ["footer", "agents", "todo"]);

  const applied = applyRailPatch({ layoutPath });
  assert.equal(applied.ok, true);
  assert.equal(applied.state, "patched");

  const content = readFileSync(layoutPath, "utf-8");
  assert.ok(content.includes("'quota'"));

  const reverted = revertRailPatch({ layoutPath });
  assert.equal(reverted.ok, true);
  assert.deepEqual(inspectRailPatch({ layoutPath }).sections, ["footer", "agents", "todo"]);
});

test("un-chained sections array declaration is recognized", () => {
  const simpleFixture = 'const sections = ["footer", "agents", "todo"];\nfor (const s of sections) {}';
  const { layoutPath } = fixture(simpleFixture);

  assert.equal(inspectRailPatch({ layoutPath }).state, "unpatched");
  assert.equal(applyRailPatch({ layoutPath }).ok, true);
  assert.deepEqual(inspectRailPatch({ layoutPath }).sections, ["footer", "agents", "todo", "quota"]);
  assert.equal(revertRailPatch({ layoutPath }).ok, true);
  assert.deepEqual(inspectRailPatch({ layoutPath }).sections, ["footer", "agents", "todo"]);
});
