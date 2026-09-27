# Project Context: piQuota (pi-quota)

## Overview
`piQuota` (`pi-quota`) is a read-only quota monitor and Moshi integration bridge for AI provider credentials that Pi already owns (Codex, Claude, Antigravity, OpenCode Zen). It provides:
- Terminal CLI (`bin/piquota.js` via `npm run quota`)
- Pi TUI status line / panel extension (`extensions/quota-panel.ts`)
- Moshi usage metrics pushing and takeover management (`src/moshi/`)
- Moshi phone approval mirroring for Pi (`extensions/moshi-approvals.ts`)

## Technical Stack
- **Language / Runtime:** Node.js `>= 20.0.0`, ECMAScript Modules (`"type": "module"`), TypeScript for Pi extensions (`extensions/*.ts`)
- **Dependencies:** Minimal / zero external runtime dependencies; uses Node standard library (`node:test`, `node:child_process`, `node:net`, `node:fs`, `node:crypto`, `node:path`, `node:os`)
- **Test Runner:** Built-in Node test runner (`node --test tests/*.test.mjs`, executed via `npm test`)
- **Skill Registry:** `.atl/skill-registry.md` exists and indexes project and agent skills.

## Moshi Approvals Architecture & Context
- Current approval extension: `extensions/moshi-approvals.ts`.
- Subscribes to Pi inter-extension event bus (`pi.events.on("pi-permission-system:permission-request")`).
- Sends `PermissionRequest` and `PermissionResolved` envelopes via Unix domain socket / named pipe (`resolveSocketPath()`, default `/tmp/moshi-hook.sock` or `MOSHI_SOCKET_PATH`).
- Terminal context is captured via `resolveTerminalContext()` (`tmux`, `zellij`, `herdr`).
- Problem statement / Change intent: Make Moshi phone approvals reliably resolve Pi guarded-command confirmation prompts without screen-fingerprint flakiness.
