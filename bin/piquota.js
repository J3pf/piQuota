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

import { clearCache, withCache } from "../src/cache.js";
import { parseArgs } from "../src/cli/args.js";
import { runAuthCommand } from "../src/cli/commands/auth.js";
import { runGentlePiCommand } from "../src/cli/commands/gentle-pi.js";
import { runMoshiCommand } from "../src/cli/commands/moshi.js";
import { explainLines, resolveFamilies } from "../src/cli/explain.js";
import { err, out } from "../src/cli/output.js";
import { collectQuota, FAMILIES } from "../src/engine.js";
import { redact } from "../src/http.js";
import { mergeLastGood } from "../src/moshi/sticky.js";
import { renderBoxWidget, renderCompact, renderPanel, renderStatusLine } from "../src/render/panel.js";
import { ansiPalette } from "../src/render/theme.js";

const VERSION = "0.7.0";

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

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
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

  if (args.unknown.length > 0) {
    err(`unknown flag: ${args.unknown.join(" ")}\n`);
    process.stdout.write(HELP);
    return 2;
  }

  if (command === "auth") {
    const sub = bare[1] ?? "status";
    return runAuthCommand(sub, argv);
  }

  if (command === "gentle-pi") {
    const sub = bare[1] ?? "status";
    return runGentlePiCommand(sub);
  }

  if (command === "moshi") {
    const sub = bare[1] ?? "status";
    return runMoshiCommand(sub, argv, { agentMode, refresh, timeoutMs: args.timeoutMs });
  }

  const { families, unknown } = resolveFamilies(
    command === "quota" ? bare.slice(1) : bare.filter((value) => value !== "moshi" && value !== "quota"),
  );

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
    const result = await withCache({ ttlMs: args.ttlMs, force: args.force, families: selected }, load);
    report = result.report;
    cached = result.cached;
    ageMs = result.ageMs;
  }

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
