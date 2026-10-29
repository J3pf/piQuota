# Claude Code credentials from the macOS Keychain

## Problem
On macOS Claude Code keeps its OAuth blob in the login Keychain (`Claude Code-credentials`), not in `~/.claude/.credentials.json`. piquota only read the file, so Claude showed `no claude credential` and the Pi quota panel had no Claude row.

## Plan
1. [x] `src/auth/claude-code-auth.js`: on darwin, when no credentials file resolves, read the Keychain item read-only via `security find-generic-password -s ... -w`.
2. [x] Skip the Keychain when `PI_QUOTA_CLAUDE_CODE_CREDENTIALS` or `CLAUDE_CONFIG_DIR` is set (Claude Code uses another service name for a relocated dir), or when `home` is substituted without an injected reader (hermetic tests).
3. [x] Refresh token is parsed but never carried into the credential.
4. [x] `--explain` reports the Keychain source (presence flags only).
5. [x] Tests with an injected `keychainReader`; README source table and test counter.

## Verification Evidence
- `node --test tests/*.test.mjs`: 247/247 passed
- Live: `piquota claude` returned 5h + weekly windows, plan pro, from the Keychain.

## Log
- 2026-10-28: implemented on `feat/claude-keychain-macos`.
