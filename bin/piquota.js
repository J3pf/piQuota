#!/usr/bin/env node
/**
 * piquota — independent, read-only quota for the credentials Pi already owns.
 *
 *   piquota                      panel for Claude, Codex, Antigravity, OpenCode Go
 *   piquota --json               normalized report
 *   piquota --compact | --status | --explain
 *   piquota auth opencode        open the OpenCode login and capture the session
 *   piquota auth status          show which credential sources are reachable
 *   piquota moshi push           publish the quota to the paired Moshi host
 *   piquota moshi watch          keep publishing on an interval
 *   piquota moshi artifact       write the local Moshi-shaped artifact
 *   piquota moshi service ...    install/remove the user service that runs `moshi watch`
 *   piquota moshi takeover       become the only usage publisher on the paired host
 *   piquota moshi release        hand usage publishing back to moshi-hook's own poller
 *   piquota gentle-pi <status|apply|revert>
 *                                the rail slot gentle-pi needs to paint the quota card
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { collectQuota, FAMILIES } from "../src/engine.js";
import { clearCache, describeCache, resolveCachePath, withCache } from "../src/cache.js";
import { parseArgs } from "../src/cli/args.js";
import { ansiPalette } from "../src/render/theme.js";
import { renderBoxWidget, renderCompact, renderPanel, renderStatusLine } from "../src/render/panel.js";
import { describeStore, loadPiCredentials, resolveAuthPaths } from "../src/auth/pi-auth.js";
import { redact } from "../src/http.js";
import { humanReset } from "../src/model.js";
import { discoverCookieStores, findCookie } from "../src/browser/cookies.js";
import { OPENCODE_COOKIE_NAMES, configPaths, discoverWorkspaceId, readGoPlan, resolveCookie, writeSecretFile } from "../src/opencode/session.js";
import { buildUsagePayload, discoverBaseUrl, moshiPaths, pushUsage, readHostCredentials } from "../src/moshi/client.js";
import { buildArtifact, resolveArtifactPath, writeArtifact } from "../src/moshi/artifact.js";
import { effectiveUsageCollection, readUsageCollection } from "../src/moshi/settings.js";
import { CLAUDE_TTL_SEC, collectWithCadence, resolveFamilyTtls } from "../src/refresh.js";
import { clearTakeover, readTakeover, setMoshiUsageCollection, writeTakeover } from "../src/moshi/takeover.js";
import { confirmDaemonUsageCollection, resolveHookLogPath, restartMoshiDaemon } from "../src/moshi/daemon.js";
import { describeClaudeCodeSource } from "../src/auth/claude-code-auth.js";
import { loadLastPublished, mergeLastGood, mergeSticky, saveLastPublished } from "../src/moshi/sticky.js";
import { applyRailPatch, inspectRailPatch, resolveGentlePiLayout, revertRailPatch } from "../src/gentle-pi/rail-patch.js";

const VERSION = "0.5.0";
const OPENCODE_LOGIN_URL = "https://opencode.ai/auth";
const WINDOWS_FIREFOX = [
  "/mnt/c/Program Files/Mozilla Firefox/firefox.exe",
  "/mnt/c/Program Files (x86)/Mozilla Firefox/firefox.exe",
];

const FAMILY_ALIASES = {
  claude: "claude",
  anthropic: "claude",
  codex: "codex",
  "openai-codex": "codex",
  chatgpt: "codex",
  antigravity: "antigravity",
  google: "antigravity",
  agy: "antigravity",
  "opencode-go": "opencode-go",
  opencode: "opencode-go",
  go: "opencode-go",
  zen: "opencode-go",
};

const HELP = `piquota ${VERSION} — read-only quota from Pi's provider credentials

Usage:
  piquota [families...] [flags]
  piquota auth <opencode|status> [flags]
  piquota moshi <push|watch|artifact|status|service|takeover|release> [flags]
  piquota gentle-pi <status|apply|revert>

Quota:
  --json             Emit the normalized report as JSON
  --compact, -c      One line per provider
  --status           Single line with rings
  --box              Compact right-aligned 5-row box widget
  --no-color         Disable ANSI colors
  --no-cache         Skip the local cache
  --force            Ignore a still-fresh cache entry
  --ttl <seconds>    Cache TTL (default 60)
  --timeout <ms>     Per-request timeout (default 15000)
  --no-refresh       Never refresh Antigravity's token in memory
  --explain          Show which stores/fields are read (names only)
  --clear-cache      Delete the local cache and exit
  --version          Print the version and exit

Auth (OpenCode Go session, the only credential Pi does not store):
  piquota auth opencode            open the login in Firefox and capture the cookie
  piquota auth opencode --paste    read the cookie from stdin instead
  piquota auth opencode --no-browser
                                   print the URL without launching a browser
  piquota auth opencode --wait <s> how long to wait for the login (default 180)
  piquota auth status              report every credential source

Moshi:
  piquota moshi push               publish once to the paired host channel
  piquota moshi watch              publish every --interval seconds (default 30)
                                   refetch every --fetch-ttl seconds (default 60)
                                   Claude refetches every --claude-ttl seconds (default 300)
  piquota moshi artifact           write the local artifact (--print to stdout)
  piquota moshi status             pairing, publisher mode and usage-collection state
  piquota moshi service install    run \`moshi watch\` as a systemd user service
  piquota moshi service uninstall  remove that service
  piquota moshi takeover           stop moshi-hook's own poller so only these cards exist
  piquota moshi release            restore moshi-hook's own poller and stop overriding it

Guarantees:
  * ~/.pi/agent/auth.json is opened read-only. Never written, synced or refreshed.
  * Antigravity's access token may be refreshed in memory; it is never persisted.
  * Browser cookie databases are copied and opened read-only; values are never logged.
  * Only percentages, window labels, reset times and plan names leave this machine.
  * \`gentle-pi\` is the one file this tool edits outside its own state: it appends
    piQuota's part to gentle-pi's rail allowlist so the card can be painted there.
    The edit is one array literal, it is reversible with \`piquota gentle-pi revert\`,
    and the previous revision is kept next to the file as a \`.pi-quota-backup\`.
`;

/**
 * @param {string[]} positionals
 */
function resolveFamilies(positionals) {
  /** @type {string[]} */
  const families = [];
  /** @type {string[]} */
  const unknown = [];
  for (const positional of positionals) {
    if (positional === "all") continue;
    const family = FAMILY_ALIASES[positional.toLowerCase()];
    if (!family) {
      unknown.push(positional);
      continue;
    }
    if (!families.includes(family)) families.push(family);
  }
  return { families, unknown };
}

/**
 * @param {string[]} families
 * @returns {string[]}
 */
function explainLines(families) {
  const paths = resolveAuthPaths({});
  const lines = ["", "Credential resolution:"];
  if (paths.length === 0) {
    lines.push("  no Pi auth store found (looked for $PI_AUTH_PATH, ~/.pi/agent/auth.json, /mnt/c/Users/*/.pi/agent/auth.json)");
  }
  for (const path of paths) {
    const store = describeStore(path);
    lines.push(`  store  ${path}  exists=${store.exists} file=${store.isFile} bytes=${store.sizeBytes ?? "?"}`);
  }

  const loaded = loadPiCredentials({});
  const counts = new Map();
  for (const credential of loaded.credentials) counts.set(credential.family, (counts.get(credential.family) ?? 0) + 1);
  lines.push("  credentials: " + FAMILIES.map((family) => `${family}=${counts.get(family) ?? 0}`).join(" "));
  lines.push("  fields read from auth.json: type, access, refresh, expires, accountId, projectId, email, key");
  lines.push("  derived from the Codex JWT (payload only): chatgpt_account_id, chatgpt_plan_type, email");

  const cookie = resolveCookie({});
  lines.push(`  opencode.ai cookie: ${cookie.found ? `found via ${cookie.origin} (${cookie.detail})` : `not found (${cookie.detail})`}`);
  // Claude has two sources, and which one is in use is the single most useful
  // diagnostic for a provider that answers 400 or "not configured".
  const claudeCode = describeClaudeCodeSource({});
  lines.push("");
  lines.push("Claude source resolution:");
  lines.push(`  preference: ${process.env.PI_QUOTA_CLAUDE_SOURCE ?? "auto"} (auto prefers the Claude Code CLI)`);
  lines.push(`  Claude Code store: ${claudeCode.path ?? "none found"}`);
  if (claudeCode.path) {
    lines.push(
      `    access token: ${claudeCode.hasAccessToken ? "yes" : "no"}` +
        ` · refresh token present: ${claudeCode.hasRefreshToken ? "yes (never read, never used)" : "no"}` +
        ` · expires in: ${claudeCode.expiresInMin === null ? "unknown" : `${claudeCode.expiresInMin}m`}` +
        ` · plan: ${claudeCode.plan ?? "unknown"}`,
    );
  } else if (claudeCode.error) {
    lines.push(`    ${redact(claudeCode.error)}`);
  }
  lines.push("  fields read from that store: claudeAiOauth.accessToken, expiresAt, subscriptionType, rateLimitTier");
  lines.push("  never read from that store: the refresh token value, and nothing is ever written back");
  lines.push(`  cache: ${resolveCachePath({})} (${describeCache({}).exists ? "present" : "absent"})`);
  lines.push(`  families requested: ${families.join(", ")}`);
  for (const warning of loaded.warnings) lines.push(`  warn: ${redact(warning)}`);
  lines.push("");
  return lines;
}

/**
 * @param {string} text
 */
function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * @param {string} text
 */
function err(text) {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * A non-fatal problem worth showing without hiding the rest of the output.
 *
 * @param {string} text
 */
function warn(text) {
  process.stderr.write(`warning: ${text.endsWith("\n") ? text : `${text}\n`}`);
}

/**
 * Launch Firefox at the login URL. Returns how it was launched.
 *
 * @param {string} url
 * @returns {{ launched: boolean, via: string, error?: string }}
 */
function openLogin(url) {
  for (const candidate of WINDOWS_FIREFOX) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, [url], { stdio: "ignore", detached: true });
    if (!result.error) return { launched: true, via: `Windows Firefox (${candidate})` };
  }
  for (const command of ["firefox", "firefox-esr", "firefox-bin"]) {
    const result = spawnSync("which", [command], { encoding: "utf-8" });
    if (result.status !== 0) continue;
    const launched = spawnSync(command, [url], { stdio: "ignore", detached: true });
    if (!launched.error) return { launched: true, via: `Firefox (${command})` };
  }
  return { launched: false, via: "none", error: "no Firefox binary found" };
}

/**
 * @param {number} seconds
 */
function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function authOpenCode(argv) {
  const paste = argv.includes("--paste");
  const noBrowser = argv.includes("--no-browser");
  const waitIndex = argv.indexOf("--wait");
  const waitSeconds = waitIndex >= 0 ? Number(argv[waitIndex + 1]) || 180 : 180;

  const paths = configPaths({});
  out("OpenCode Go session");
  out(`  config file: ${paths.path}`);

  if (paste) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString("utf-8").trim();
    if (value === "") {
      err("no cookie received on stdin");
      return 2;
    }
    const written = writeSecretFile(paths.path, value);
    if (!written.ok) {
      err(`could not write ${paths.path}: ${written.error}`);
      return 2;
    }
    out(`  stored (0600): ${paths.path}`);
    return verifyGoPlan({});
  }

  const stores = discoverCookieStores({});
  out("  browser stores found:");
  if (stores.length === 0) {
    out("    (none)");
  }
  for (const store of stores) {
    const readable = store.readability === "plaintext";
    out(`    ${readable ? "readable " : "ENCRYPTED"} ${store.browser} ${store.profile}`);
    if (!readable && store.note) out(`              ${store.note}`);
  }

  const before = resolveCookie({ allowBrowser: false });
  if (before.found) {
    out(`  a session is already available via ${before.origin} (${before.detail})`);
  }

  const readableFirefox = stores.filter((store) => store.browser === "firefox" && store.readability === "plaintext");
  if (readableFirefox.length === 0) {
    err("");
    err("No readable Firefox cookie store found. Log in with Firefox, or paste the cookie:");
    err("  piquota auth opencode --paste   (get `auth` for opencode.ai from your browser devtools)");
    return 2;
  }

  out("");
  if (!noBrowser) {
    const opened = openLogin(OPENCODE_LOGIN_URL);
    out(opened.launched ? `  opened ${OPENCODE_LOGIN_URL} in ${opened.via}` : `  could not launch a browser (${opened.error})`);
    if (!opened.launched) out(`  open manually: ${OPENCODE_LOGIN_URL}`);
  } else {
    out(`  open this URL in Firefox: ${OPENCODE_LOGIN_URL}`);
  }
  out("  log in with GitHub, Google or Apple, then click Authorize on the consent screen.");
  out(`  Waiting up to ${waitSeconds}s for the session...`);

  const deadline = Date.now() + waitSeconds * 1000;
  let found = null;
  while (Date.now() < deadline) {
    await sleep(3);
    for (const name of OPENCODE_COOKIE_NAMES) {
      const hit = findCookie({ host: "opencode.ai", name, stores: readableFirefox });
      if (hit.found && hit.value) {
        found = hit;
        break;
      }
    }
    if (found) break;
  }

  if (!found) {
    err("");
    err(`No "${OPENCODE_COOKIE_NAME}" cookie for opencode.ai appeared within ${waitSeconds}s.`);
    err("Check that you completed the login in Firefox, then re-run this command.");
    return 1;
  }

  out(`  session captured from ${found.store?.browser} ${found.store?.profile}`);
  out("  the cookie is read live from the browser store; it is not copied anywhere");
  const code = await verifyGoPlan({ stores: readableFirefox });
  if (code !== 0) {
    out("");
    out("If the workspace id could not be found, open https://opencode.ai/ once in Firefox");
    out("(the app lands on /workspace/<id>), then run: piquota auth opencode");
  }
  return code;
}

/**
 * @param {{ stores?: import("../src/browser/cookies.js").CookieStore[] }} [options]
 * @returns {Promise<number>}
 */
async function verifyGoPlan(options = {}) {
  const cookie = resolveCookie({ stores: options.stores, allowBrowser: true });
  if (!cookie.found) {
    err(`no opencode.ai session found (${cookie.detail})`);
    return 1;
  }

  const workspace = await discoverWorkspaceId({});
  if (!workspace.workspaceId) {
    err(`session found but no workspace id (${workspace.error})`);
    return 1;
  }
  out(`  workspace: ${workspace.workspaceId}${workspace.origin ? ` (from ${workspace.origin})` : ""}`);

  const plan = await readGoPlan({ cookie: cookie.value, workspaceId: workspace.workspaceId });
  if (!plan.ok) {
    err(`  dashboard read failed: ${plan.error}`);
    return 1;
  }
  out("  Go plan windows:");
  for (const window of plan.windows) {
    const remaining = window.remainingPercent === null ? "n/a" : `${Math.round(window.remainingPercent)}% left`;
    const reset = window.resetsInSec === null ? "" : ` · ${humanReset(window.resetsInSec)}`;
    out(`    ${window.label.padEnd(16)} ${remaining}${reset}`);
  }
  return 0;
}

async function authStatus() {
  out("Credential sources");
  const paths = resolveAuthPaths({});
  for (const path of paths) {
    const store = describeStore(path);
    out(`  pi store   ${path} (${store.sizeBytes ?? "?"} bytes)`);
  }
  const cookie = resolveCookie({});
  out(`  opencode   ${cookie.found ? `session via ${cookie.origin} — ${cookie.detail}` : `no session — ${cookie.detail}`}`);
  const workspace = configPaths({}).workspacePath;
  out(`  workspace  ${existsSync(workspace) ? "cached" : "not cached"}`);

  const stores = discoverCookieStores({});
  out("  browser stores:");
  for (const store of stores) {
    out(`    ${store.readability === "plaintext" ? "readable " : "ENCRYPTED"} ${store.browser} ${store.profile}`);
  }
  return 0;
}

/**
 * @param {import("../src/engine.js").PiQuotaReport} report
 * @param {{ agentMode?: "pi" | "native", quiet?: boolean }} [options]
 * @returns {Promise<number>}
 */
async function moshiPush(report, options = {}) {
  // `alreadyMerged` lets the watcher do the merging once and still count what it
  // is about to publish, instead of reporting a pre-restore number.
  const { report: carried, reused } = options.alreadyMerged
    ? { report, reused: [] }
    : mergeSticky(options.previous ?? loadLastPublished({}), report);
  // A transient failure falls back to the last *healthy* values per family, so a
  // throttle can never leave a card blank.
  const { report: sticky, restored } = options.alreadyMerged ? { report: carried, restored: [] } : mergeLastGood(carried);
  const payload = buildUsagePayload(sticky, { agentMode: options.agentMode });
  if (payload.snapshots.length === 0) {
    if (!options.quiet) out("nothing to publish: no provider returned usage windows");
    return 0;
  }
  const result = await pushUsage(payload, {});
  if (!result.ok) {
    err(`moshi push failed: ${result.error}`);
    return 1;
  }
  saveLastPublished(sticky);
  if (reused.length > 0 && !options.quiet) {
    out(`(kept the previous snapshot for: ${reused.join(", ")} — transient upstream error)`);
  }
  if (restored.length > 0 && !options.quiet) {
    out(`(showing the last known values for: ${restored.join(", ")})`);
  }
  if (!options.quiet) {
    out(`published ${result.pushed} snapshot(s) to the paired Moshi host`);
    for (const snapshot of payload.snapshots) {
      out(`  ${snapshot.accountLabel.padEnd(20)} ${snapshot.windows.map((w) => `${w.label} ${w.usedPercentage}% used`).join(" · ")}`);
    }
  }
  return 0;
}

async function moshiStatus() {
  const paths = moshiPaths({});
  out("Moshi");
  out(`  state dir: ${paths.stateDir}`);
  const credentials = readHostCredentials({});
  out(`  pairing:   ${credentials.ok ? `paired as "${credentials.hostName}" (${credentials.hostId})` : credentials.error}`);
  out(`  base url:  ${discoverBaseUrl({}) ?? "(moshi-hook default)"}`);
  const setting = readUsageCollection({});
  out(`  usage-collection: ${setting.enabled ? "on" : "off"} (${setting.path}${setting.raw ? ` = ${setting.raw}` : ""})`);

  const effective = effectiveUsageCollection({});
  const takeover = readTakeover({});
  if (takeover.active) {
    out(`  publisher:  piQuota (takeover recorded ${takeover.takenAt ?? "unknown"} in ${takeover.path})`);
    out("              `piquota moshi release` hands publishing back to moshi-hook");
    if (effective.duplicateRisk) {
      out("              WARNING: moshi-hook's own poller is on again while the takeover is recorded,");
      out("                       so both publishers will send usage for the same agents.");
    }
  } else {
    out("  publisher:  moshi-hook's own poller (piQuota follows its usage-collection switch)");
  }

  const applied = await confirmDaemonUsageCollection({});
  out(`  daemon log: ${resolveHookLogPath({})}`);
  out(`              ${applied.confirmed ? applied.detail : `unconfirmed (${applied.detail})`}`);
  const artifact = resolveArtifactPath({});
  out(`  artifact:  ${existsSync(artifact) ? artifact : `${artifact} (not written yet)`}`);
  return 0;
}

/**
 * Make piQuota the only publisher, or hand the job back.
 *
 * moshi-hook's own poller reads each agent's CLI-owned credential file, so simply
 * installing Claude Code is enough to produce a second, differently-attributed
 * Claude card. The takeover stops that poller, and the record lives in piQuota's
 * own state so that reading moshi-hook's switch off is not mistaken for an
 * instruction to stop publishing.
 *
 * @param {string} action
 * @returns {Promise<number>}
 */
async function moshiPublisher(action) {
  const settings = readUsageCollection({});
  const takeover = readTakeover({});

  if (action === "takeover") {
    if (takeover.active && settings.enabled) {
      warn("a takeover is already recorded but moshi-hook's own poller is on again");
      warn("run `piquota moshi release` first, so the original setting is restored deliberately");
      return 1;
    }

    if (!takeover.active) {
      const applied = setMoshiUsageCollection("off");
      if (!applied.ok) {
        err(`could not change moshi-hook's setting: ${applied.error}`);
        err(`try \`${applied.argv.join(" ")}\` yourself, or \`moshi-hook set\` to list every setting`);
        return 1;
      }
      const written = writeTakeover({ previous: settings.raw ?? (settings.enabled ? "true" : "false") });
      if (!written.ok) {
        err(`usage-collection is off, but the takeover could not be recorded: ${written.error}`);
        err("run `piquota moshi release` to put the setting back before trying again");
        return 1;
      }
      out(`moshi-hook: usage-collection = off (was ${settings.raw ?? "unset"})`);
      out(`piQuota:    takeover recorded in ${written.path}`);
    } else {
      out(`piQuota:    takeover already recorded in ${takeover.path}`);
    }

    const restart = restartMoshiDaemon({});
    out(`daemon:     ${restart.ok ? restart.detail : `not restarted — ${restart.detail}`}`);

    // A restart returns before the daemon has logged its banner, so this waits for
    // a banner at least as new as the restart instead of reading a stale one.
    const applied = await confirmDaemonUsageCollection({ notBeforeMs: restart.restartedAtMs });
    if (!applied.confirmed) {
      warn(`verification: unconfirmed (${applied.detail})`);
    } else if (applied.applied === true) {
      warn("verification: the daemon still reports usage-collection on, so it has not picked the change up");
    } else {
      out(`verification: ${applied.detail}`);
    }

    out("");
    out("piQuota is now the only usage publisher. Moshi shows:");
    out("  Claude (Pi) · Codex (Pi) · Antigravity (Pi) · OpenCode Go (Pi)");
    out("");
    out("What this does and does not change:");
    out("  * the daemon's notification and approval bridge is untouched; only its usage poller stops.");
    out("  * Claude Code's own rate-limit notices inside Pi are untouched: they come from the plugin.");
    out("  * these cards use piQuota's own account ids (`pi:<family>`), so a usage-alert rule bound to");
    out("    moshi-hook's previous card has to be enabled again in the app, and the old card is left behind.");
    out("  * undo with `piquota moshi release`.");
    return 0;
  }

  if (action === "release") {
    const restored = takeover.previous ?? "true";
    const applied = setMoshiUsageCollection(restored);
    if (!applied.ok) {
      err(`could not restore moshi-hook's setting: ${applied.error}`);
      err(`run \`moshi-hook set usage-collection ${restored}\` yourself; the takeover record is kept until you do`);
      return 1;
    }
    const cleared = clearTakeover({});
    if (!cleared.ok) {
      err(`restored the setting, but the takeover record could not be removed: ${cleared.error}`);
      return 1;
    }
    out(`moshi-hook: usage-collection = ${restored}`);
    out(`piQuota:    takeover record ${cleared.removed ? "removed" : "was not present"}`);

    const restart = restartMoshiDaemon({});
    out(`daemon:     ${restart.ok ? restart.detail : `not restarted — ${restart.detail}`}`);

    const confirmed = await confirmDaemonUsageCollection({ notBeforeMs: restart.restartedAtMs });
    out(`verification: ${confirmed.confirmed ? confirmed.detail : `unconfirmed (${confirmed.detail})`}`);
    out("");
    out("moshi-hook publishes usage again. A card piQuota created under `pi:<family>` is left behind;");
    out("remove it from the app if you no longer want it.");
    return 0;
  }

  err(`unknown publisher action: ${action} (expected takeover or release)`);
  return 1;
}

/**
 * @param {string[]} argv
 * @param {import("../src/engine.js").PiQuotaReport} report
 * @param {{ agentMode?: "pi" | "native" }} [options]
 * @returns {Promise<number>}
 */
async function moshiWatch(argv, report, options = {}) {
  const intervalIndex = argv.indexOf("--interval");
  const intervalSec = intervalIndex >= 0 ? Number(argv[intervalIndex + 1]) || 30 : 30;
  const ttlIndex = argv.indexOf("--fetch-ttl");
  const fetchTtlSec = ttlIndex >= 0 ? Number(argv[ttlIndex + 1]) || 60 : 60;
  const claudeTtlIndex = argv.indexOf("--claude-ttl");
  const claudeTtlSec = claudeTtlIndex >= 0 ? Number(argv[claudeTtlIndex + 1]) || CLAUDE_TTL_SEC : CLAUDE_TTL_SEC;

  const ttls = resolveFamilyTtls({ defaultTtlSec: fetchTtlSec, claudeTtlSec });
  out(`moshi watch: publishing every ${intervalSec}s, refetching every ${ttls.codex}s (Ctrl-C to stop)`);
  out(`  Claude refetches every ${ttls.claude}s on its own clock: it is the one provider that`);
  out("  answers 429 when its usage endpoint is polled every minute.");

  let last = loadLastPublished({});
  for (;;) {
    const setting = effectiveUsageCollection({});
    if (!setting.enabled) {
      out(`usage-collection is off in ${setting.path}; pausing`);
    } else {
      const fetched = await collectWithCadence({
        families: FAMILIES,
        ttls,
        loader: (families) => collectQuota({ families, refresh: options.refresh }),
      });
      const carried = mergeSticky(last, fetched.report);
      const final = mergeLastGood(carried.report);
      last = final.report;

      const result = await moshiPush(final.report, { agentMode: options.agentMode, quiet: true, alreadyMerged: true });
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const carriedNames = [...carried.reused, ...final.restored];
      const notes = [];
      if (fetched.fetched.length > 0) notes.push(`refreshed ${fetched.fetched.join(", ")}`);
      if (carriedNames.length > 0) notes.push(`kept last values for ${carriedNames.join(", ")}`);
      const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";

      if (result === 0) {
        // What matters is how many cards the host accepted, not how many providers
        // happened to be healthy: a cycle where the sticky layer restored three of
        // four still published four, and the old message reported "1".
        const pushed = buildUsagePayload(final.report, { agentMode: options.agentMode }).snapshots.length;
        out(`${stamp} published ${pushed} card(s)${note}`);
      } else {
        out(`${stamp} push failed${note}`);
      }
    }
    await sleep(intervalSec);
  }
}

const SERVICE_NAME = "pi-quota-moshi.service";

async function moshiService(argv) {
  const action = argv[0] ?? "status";
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, SERVICE_NAME);
  const cli = process.argv[1] ?? join(process.cwd(), "bin", "piquota.js");

  if (action === "status") {
    const result = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], { encoding: "utf-8" });
    out(`unit: ${unitPath}`);
    out(`installed: ${existsSync(unitPath) ? "yes" : "no"}`);
    out(`active: ${(result.stdout ?? "").trim() || "unknown"}`);
    return 0;
  }

  if (action === "install") {
    const unit = `[Unit]
Description=pi-quota -> Moshi usage publisher
After=moshi-hook.service

[Service]
Type=simple
ExecStart=${process.execPath} ${cli} moshi watch --interval 30 --fetch-ttl 60
Restart=always
RestartSec=15

[Install]
WantedBy=default.target
`;
    const written = writeSecretFile(unitPath, unit);
    if (!written.ok) {
      err(`could not write ${unitPath}: ${written.error}`);
      return 1;
    }
    out(`wrote ${unitPath}`);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    // `enable --now` starts a stopped unit and leaves a running one alone, so an
    // upgrade would keep the old binary and the old cadence until the next reboot.
    const wasActive = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], { encoding: "utf-8" }).stdout?.trim() === "active";
    const enabled = spawnSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME], { stdio: "inherit" });
    if (enabled.status !== 0) {
      err("systemctl enable failed; run it manually");
      return 1;
    }
    if (wasActive) {
      const restarted = spawnSync("systemctl", ["--user", "restart", SERVICE_NAME], { stdio: "inherit" });
      if (restarted.status !== 0) {
        err(`the unit is written, but the running service could not be restarted; run: systemctl --user restart ${SERVICE_NAME}`);
        return 1;
      }
      out("service restarted so the new unit takes effect");
    }
    out("service enabled and started");
    return 0;
  }

  if (action === "uninstall") {
    spawnSync("systemctl", ["--user", "disable", "--now", SERVICE_NAME], { stdio: "inherit" });
    spawnSync("rm", ["-f", unitPath]);
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    out(`removed ${unitPath}`);
    return 0;
  }

  err(`unknown moshi service action: ${action}`);
  return 2;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  // Only real positionals: filtering the raw argv by "starts with a dash" also kept
  // the *values* of value flags, so `--ttl 300` was read as a family named "300".
  const bare = args.positionals;
  const command = bare[0] ?? null;
  const agentMode = "native";
  const refresh = !argv.includes("--no-refresh");

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    out(`piquota ${VERSION}`);
    return 0;
  }
  if (args.clearCache) {
    const result = clearCache({});
    out(result.removed ? `cache cleared: ${result.path}` : `no cache at ${result.path}`);
    return 0;
  }

  // A flag nobody owns is a typo far more often than it is intentional, and
  // silently ignoring it turns `--stauts` into a confusing no-op.
  if (args.unknown.length > 0) {
    err(`unknown flag: ${args.unknown.join(" ")}\n`);
    process.stdout.write(HELP);
    return 2;
  }

  if (command === "auth") {
    const sub = bare[1] ?? "status";
    if (sub === "opencode") return authOpenCode(argv);
    if (sub === "status") return authStatus();
    err(`unknown auth action: ${sub}`);
    return 2;
  }

  // Handled before family resolution: `gentle-pi` is a subcommand, not a provider.
  if (command === "gentle-pi") {
    const sub = bare[1] ?? "status";
    if (sub !== "status" && sub !== "apply" && sub !== "revert") {
      err(`unknown gentle-pi action: ${sub}`);
      err("expected one of: status, apply, revert");
      return 2;
    }
    const layout = resolveGentlePiLayout();
    if (!layout.present) {
      out("gentle-pi: not installed");
      out("nothing to do: piQuota renders its own widget without the rail");
      return 0;
    }
    out(`gentle-pi: ${layout.layoutPath}`);
    if (sub === "status") {
      const inspected = inspectRailPatch({ layoutPath: layout.layoutPath });
      out(`rail patch: ${inspected.state} (${inspected.detail})`);
      if (inspected.state !== "patched") {
        out("run `piquota gentle-pi apply`, or let the extension repair it at session start");
      }
      return inspected.state === "unknown" ? 1 : 0;
    }
    const result = sub === "revert"
      ? revertRailPatch({ layoutPath: layout.layoutPath })
      : applyRailPatch({ layoutPath: layout.layoutPath });
    out(`rail patch: ${result.state} — ${result.detail}`);
    if (result.backupPath) out(`backup: ${result.backupPath}`);
    return result.ok ? 0 : 1;
  }

  const { families, unknown } = resolveFamilies(
    command === "quota" ? bare.slice(1) : bare.filter((value) => value !== "moshi" && value !== "quota"),
  );

  if (command === "moshi") {
    const sub = bare[1] ?? "status";
    if (sub === "status") return moshiStatus();
    if (sub === "takeover" || sub === "release") return moshiPublisher(sub);
    if (sub === "service") return moshiService(argv.slice(argv.indexOf("service") + 1));

    const report = await collectQuota({ families: FAMILIES, timeoutMs: args.timeoutMs, refresh });
    if (sub === "push") return moshiPush(report, { agentMode });
    if (sub === "watch") return moshiWatch(argv, report, { agentMode, refresh });
    if (sub === "artifact") {
      const artifact = buildArtifact(report);
      if (argv.includes("--print")) {
        out(JSON.stringify(artifact, null, 2));
      } else {
        const written = writeArtifact(artifact, resolveArtifactPath({}));
        out(written.ok ? `wrote ${written.path}` : `failed to write ${written.path}: ${written.error}`);
      }
      return 0;
    }
    err(`unknown moshi action: ${sub}`);
    err("expected one of: push, watch, artifact, status, service, takeover, release");
    return 2;
  }

  if (unknown.length > 0) {
    err(`unknown argument: ${unknown.join(" ")}\n`);
    process.stdout.write(HELP);
    return 2;
  }

  const selected = families.length > 0 ? families : FAMILIES;
  const load = () => collectQuota({ families: selected, timeoutMs: args.timeoutMs, refresh, force: args.force });

  let report;
  let cached = false;
  let ageMs = 0;
  if (args.noCache) {
    report = await load();
  } else {
    const result = await withCache({ ttlMs: args.ttlMs, force: args.force }, load);
    report = result.report;
    cached = result.cached;
    ageMs = result.ageMs;
  }

  // Same rule as the Moshi publisher: while a provider is throttled, surface its
  // last known real values (labelled with their age) instead of "n/a". Being
  // blind exactly while an endpoint is rate-limiting is the worst outcome, and
  // the terminal and the phone should not disagree.
  const { report: reportWithHistory, restored } = mergeLastGood(report, {});
  report = reportWithHistory;
  if (restored.length > 0 && !args.json && !args.compact && !args.status) {
    process.stderr.write(`note: showing last known values for ${restored.join(", ")}\n`);
  }

  const paint = ansiPalette({ color: args.color });

  if (args.json) {
    out(JSON.stringify({ ...report, cache: { used: cached, ageMs } }, null, 2));
    return report.providers.some((provider) => provider.ok) ? 0 : 1;
  }
  if (args.status) {
    out(renderStatusLine(report.providers, paint));
    return 0;
  }
  if (args.box) {
    for (const line of renderBoxWidget(report.providers, paint)) out(line);
  } else if (args.compact) {
    for (const line of renderCompact(report.providers, paint)) out(line);
  } else {
    for (const line of renderPanel(report.providers, paint, {
      generatedAt: report.generatedAt,
      warnings: report.warnings,
    })) {
      out(line);
    }
  }
  if (args.explain) {
    for (const line of explainLines(selected)) out(line);
  }

  return report.providers.some((provider) => provider.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    err(`piquota failed: ${redact(/** @type {{ message?: string }} */ (error)?.message ?? error)}`);
    process.exit(1);
  },
);
