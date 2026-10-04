# AGENTS.md

Instructions, architecture rules, and testing guidelines for AI coding agents working on `piQuota`.

## Project Overview

`piQuota` is a standalone, zero-dependency quota monitor for AI providers configured in the [Pi Coding Agent](https://github.com/earendil-works/pi) ecosystem. It aggregates real-time quota, reset countdowns, and subscription tiers across multiple AI providers (Claude, OpenAI Codex, Antigravity, OpenCode Go) across multiple surfaces:
- **Terminal CLI**: `piquota` (boxed widget, compact line, status, JSON).
- **Pi TUI Extension**: `/quota`, custom editor rail widget, and gentle-pi sidebar integration.
- **Moshi Mobile Synchronization**: Background publisher and approval card reflection.

### Core Philosophy
1. **Credentials Pi Already Owns**: Do not duplicate authentication or invent new login workflows when credentials already exist in `~/.pi/agent/auth.json` or `~/.claude/.credentials.json`.
2. **Strict Read-Only Guarantee**: Never mutate credential files on disk.
3. **Zero Runtime Dependencies**: Written entirely in vanilla ES Modules targeting Node.js `>=20.0.0` using native `node:sqlite`, `node:fs`, and global `fetch`.

## Setup & Dev Environment

- **Prerequisites**: Node.js `>=20.0.0`.
- **Dependencies**: No external npm packages. `npm install` does not fetch any third-party production or dev runtime packages.
- **Development symlink**:
  ```bash
  ./install.sh --link
  ```
  This creates a symlink from `~/.local/bin/piquota` pointing directly to your working checkout.
- **Running the CLI locally**:
  ```bash
  node bin/piquota.js
  node bin/piquota.js --json
  node bin/piquota.js --explain
  ```

## Testing Instructions

The project uses Node.js's built-in test runner (`node:test` and `node:assert/strict`).

- **Run all tests**:
  ```bash
  npm test
  # or directly:
  node --test tests/*.test.mjs
  ```
- **Run a single test file**:
  ```bash
  node --test tests/args.test.mjs
  node --test tests/extension.test.mjs
  ```
- **Run a specific test by name**:
  ```bash
  node --test --test-name-pattern="rail" tests/rail-patch.test.mjs
  ```
- **Documentation integrity tests**:
  ```bash
  node --test tests/docs.test.mjs
  ```
  `tests/docs.test.mjs` verifies markdown tables, code fences, relative links, anchor links, and published test counters across documentation.

### Test Invariants
- Tests must **never access live external network services**. All HTTP requests are mocked or intercepted.
- SQLite operations in tests run against temporary, synthetic in-memory or fixture databases.
- All tests must pass cleanly before any code is committed.

## Hard Architectural Rules & Guarantees

Any modification to this codebase MUST uphold these non-negotiable guarantees:

1. **Read-Only Credential Access**:
   - `~/.pi/agent/auth.json` is opened strictly with `flag: "r"`. It must never be written, synced, or modified.
   - `~/.claude/.credentials.json` is opened read-only.
2. **Token Refresh Invariants**:
   - **Antigravity**: Access tokens may be refreshed in memory using Google's public client, because Google refresh tokens do not rotate. The refreshed token must NEVER be written back to disk.
   - **Claude and Codex**: NEVER refresh access tokens. Both Anthropic and OpenAI rotate refresh tokens; refreshing a token would invalidate the credentials owned by external CLI tools.
   - **Claude Code Store**: The refresh token from `~/.claude/.credentials.json` is never loaded into memory.
3. **Zero Secret Leakage**:
   - Never print, log, cache, or transmit tokens, refresh tokens, session keys, or API keys.
   - Redact email addresses and identity markers in exported JSON artifacts and Moshi payloads via `src/http.js:redact`.
4. **Filesystem Boundaries**:
   - Caches and state files are restricted to `~/.cache/pi-quota/` and `~/.local/state/pi-quota/`.
   - File writes must be atomic (write to temporary file, then `renameSync`).
   - Explicit opt-in exception: `piquota omarchy` may write (and remove stale) `pi-*.json` records, and only those, in Omarchy's agents usage directory (`${XDG_STATE_HOME:-~/.local/state}/omarchy/agents/usage/` or `PI_QUOTA_OMARCHY_DIR`), atomically. Records contain plan names, percentages, window labels and reset times, never tokens or account identifiers. Omarchy's own records are never touched.
5. **Graceful Degradation**:
   - Provider failures (network timeouts, 401s, 429 rate limits, malformed payloads) must degrade gracefully into typed error states (`isTransient`, `isAuthFailure`, `isThrottled`, `notConfigured`), never throwing unhandled exceptions that crash the CLI or the Pi TUI.

## Code Conventions

- **Module System**: Pure ES Modules (`"type": "module"` in `package.json`). Use `.js` for source, `.mjs` for tests, and `.ts` for Pi extensions.
- **Node Built-ins**: Use `node:` protocol imports (e.g., `import fs from "node:fs"`).
- **Commit Messages**: Strictly follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g., `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `perf:`). **Always include a detailed commit body/description** explaining *why* the change was made and the technical approach taken; never use bare one-line commit summaries.
- **Attribution Policy**: **Never add "Co-Authored-By", AI signatures, or AI tool attribution** in commits, PR descriptions, or source code.
