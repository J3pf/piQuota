/**
 * Gentle-pi subcommands: inspect, apply, or revert rail patch.
 */

import {
  applyRailPatch,
  inspectRailPatch,
  resolveGentlePiLayout,
  revertRailPatch,
} from "../../gentle-pi/rail-patch.js";
import { err, out } from "../output.js";

/**
 * @param {string} sub
 * @returns {number}
 */
export function runGentlePiCommand(sub) {
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
