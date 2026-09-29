/**
 * Auth subcommands: OpenCode session capture and credential status inspection.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { describeStore, resolveAuthPaths } from "../../auth/pi-auth.js";
import { discoverCookieStores, findCookie } from "../../browser/cookies.js";
import { humanReset } from "../../model.js";
import {
  OPENCODE_COOKIE_NAME,
  OPENCODE_COOKIE_NAMES,
  configPaths,
  discoverWorkspaceId,
  readGoPlan,
  resolveCookie,
  writeSecretFile,
} from "../../opencode/session.js";
import { err, out, sleep } from "../output.js";

const OPENCODE_LOGIN_URL = "https://opencode.ai/auth";
const WINDOWS_FIREFOX = [
  "/mnt/c/Program Files/Mozilla Firefox/firefox.exe",
  "/mnt/c/Program Files (x86)/Mozilla Firefox/firefox.exe",
];

/**
 * Launch Firefox at the login URL. Returns how it was launched.
 *
 * @param {string} url
 * @returns {{ launched: boolean, via: string, error?: string }}
 */
export function openLogin(url) {
  for (const candidate of WINDOWS_FIREFOX) {
    if (!existsSync(candidate)) continue;
    const result = spawnSync(candidate, [url], { stdio: "ignore", detached: true });
    if (!result.error) return { launched: true, via: `Windows Firefox (${candidate})` };
  }
  if (process.platform === "darwin" || existsSync("/Applications/Firefox.app")) {
    const launched = spawnSync("open", ["-a", "Firefox", url], { stdio: "ignore", detached: true });
    if (!launched.error && launched.status === 0) return { launched: true, via: "macOS Firefox (open -a Firefox)" };
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
 * @param {{ stores?: import("../../browser/cookies.js").CookieStore[] }} [options]
 * @returns {Promise<number>}
 */
export async function verifyGoPlan(options = {}) {
  const cookie = resolveCookie({ stores: options.stores, allowBrowser: true });
  if (!cookie.found) {
    err(`no opencode.ai session found (${cookie.detail})`);
    return 1;
  }

  const workspace = await discoverWorkspaceId({ cookie: cookie.value, stores: options.stores });
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

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function authOpenCode(argv) {
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
 * @returns {Promise<number>}
 */
export async function authStatus() {
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
 * @param {string} sub
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function runAuthCommand(sub, argv) {
  if (sub === "opencode") return authOpenCode(argv);
  if (sub === "status") return authStatus();
  err(`unknown auth action: ${sub}`);
  return 2;
}
