/**
 * Moshi subcommands: push, watch, artifact, status, service, takeover, release.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { collectQuota, FAMILIES } from "../../engine.js";
import { buildArtifact, resolveArtifactPath, writeArtifact } from "../../moshi/artifact.js";
import { buildUsagePayload, discoverBaseUrl, moshiPaths, pushUsage, readHostCredentials } from "../../moshi/client.js";
import { confirmDaemonUsageCollection, resolveHookLogPath, restartMoshiDaemon } from "../../moshi/daemon.js";
import { effectiveUsageCollection, readUsageCollection } from "../../moshi/settings.js";
import { loadLastPublished, mergeLastGood, mergeSticky, saveLastPublished } from "../../moshi/sticky.js";
import { clearTakeover, readTakeover, setMoshiUsageCollection, writeTakeover } from "../../moshi/takeover.js";
import { writeSecretFile } from "../../opencode/session.js";
import { CLAUDE_TTL_SEC, collectWithCadence, resolveFamilyTtls } from "../../refresh.js";
import { err, out, sleep, warn } from "../output.js";

export const SERVICE_NAME = "pi-quota-moshi.service";

/**
 * @param {import("../../engine.js").PiQuotaReport} report
 * @param {{ agentMode?: "pi" | "native", quiet?: boolean, alreadyMerged?: boolean, previous?: import("../../engine.js").PiQuotaReport }} [options]
 * @returns {Promise<number>}
 */
export async function moshiPush(report, options = {}) {
  const { report: carried, reused } = options.alreadyMerged
    ? { report, reused: [] }
    : mergeSticky(options.previous ?? loadLastPublished({}), report);
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

/**
 * @returns {Promise<number>}
 */
export async function moshiStatus() {
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
 * @param {string} action
 * @returns {Promise<number>}
 */
export async function moshiPublisher(action) {
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
 * @param {import("../../engine.js").PiQuotaReport} report
 * @param {{ agentMode?: "pi" | "native", refresh?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function moshiWatch(argv, report, options = {}) {
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
    try {
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
          const pushed = buildUsagePayload(final.report, { agentMode: options.agentMode }).snapshots.length;
          out(`${stamp} published ${pushed} card(s)${note}`);
        } else {
          out(`${stamp} push failed${note}`);
        }
      }
    } catch (error) {
      const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[${stamp}] watch iteration failed: ${message}\n`);
    }
    await sleep(intervalSec);
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function moshiService(argv) {
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
ExecStart="${process.execPath}" "${cli}" moshi watch --interval 30 --fetch-ttl 60
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
    try {
      rmSync(unitPath, { force: true });
    } catch {
      // Best-effort removal.
    }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    out(`removed ${unitPath}`);
    return 0;
  }

  err(`unknown moshi service action: ${action}`);
  return 2;
}

/**
 * @param {string} sub
 * @param {string[]} argv
 * @param {{ agentMode?: "pi" | "native", refresh?: boolean, timeoutMs?: number }} options
 * @returns {Promise<number>}
 */
export async function runMoshiCommand(sub, argv, options = {}) {
  if (sub === "status") return moshiStatus();
  if (sub === "takeover" || sub === "release") return moshiPublisher(sub);
  if (sub === "service") return moshiService(argv.slice(argv.indexOf("service") + 1));

  const report = await collectQuota({ families: FAMILIES, timeoutMs: options.timeoutMs, refresh: options.refresh });
  if (sub === "push") return moshiPush(report, { agentMode: options.agentMode });
  if (sub === "watch") return moshiWatch(argv, report, { agentMode: options.agentMode, refresh: options.refresh });
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
