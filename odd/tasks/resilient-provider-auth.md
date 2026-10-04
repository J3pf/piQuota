# Resilient Provider Authentication: OpenCode Go Browser Discovery & Codex Subscription Clarity

## Problem Analysis
1. **OpenCode Go**:
   - `piQuota`'s `src/browser/cookies.js` only checked Firefox roots on Linux, ignoring Chromium-based browsers (Chromium, Google Chrome, Microsoft Edge, Brave).
   - On Linux, Chromium-family browsers encrypt cookies with OSCrypt `v11` (AES-128-CBC with key derived from GNOME Keyring / Secret Service via `secret-tool`) or `v10` ("peanuts" fallback).
   - The user had an active `opencode.ai` session in Microsoft Edge and Chromium on Linux, but `piquota` could not discover or decrypt it, displaying `OP-Go: ! unavailable`.
   - OpenCode Console API (`/console/api/go/status` and `/console/api/orgs`) requires both `__Host-console_session` and `auth` cookies when both are present.
2. **OpenAI vs Codex**:
   - The user has an OpenAI platform credential (`"openai"` OAuth) in `~/.pi/agent/auth.json`, which authenticates to `https://api.openai.com/v1`.
   - OpenAI Platform API keys and general API OAuth tokens do not provide rolling quota windows (5h, weekly, %).
   - Codex quota windows come exclusively from ChatGPT Plus/Pro subscription OAuth tokens (`"openai-codex"` in `auth.json`, authenticated via `/login openai-codex` in Pi).
   - Missing `"openai-codex"` simply yielded `! no codex credential in the Pi store` / `! not configured`, confusing users who have `"openai"` configured in Pi.

## Plan
1. [x] `src/browser/cookies.js`: Add Linux Chromium-family cookie store discovery (Google Chrome, Chromium, Microsoft Edge, Brave) and OSCrypt decryption (`v11` via `secret-tool` / Secret Service PBKDF2-HMAC-SHA1 + AES-128-CBC; `v10` via "peanuts" fallback).
2. [x] `src/opencode/session.js`: Support multi-cookie extraction (combining `auth` and `__Host-console_session`) and pass complete headers to Console API and workspace resolution.
3. [x] `src/auth/pi-auth.js` & `src/engine.js`: Detect when `openai` is present in `auth.json` while `openai-codex` is absent, providing an actionable diagnosis explaining that quota % requires `/login openai-codex` in Pi.
4. [x] Tests & Documentation: Add unit tests for Linux Chromium cookie decryption and multi-cookie session resolution; update `docs/AUTH-FIELDS.md` and verify `tests/docs.test.mjs`.
5. [x] End-to-end verification: Verify `node bin/piquota.js --explain` pulls fresh OpenCode Go quota and accurately diagnoses Codex.

## Verification Evidence
- `node --test tests/*.test.mjs`: 256/256 passed cleanly (0 failed, 0 skipped).
- `node --test tests/docs.test.mjs`: 6/6 passed cleanly (integrity of markdown tables, fences, relative links, anchors, test counters).
- `node bin/piquota.js --explain --force`: OpenCode Go resolved live via Microsoft Edge (`chromium linux:Microsoft Edge/Default`), displaying:
  - 5h window: 100% left (used 0.09%, resets in 4h 28m)
  - Weekly window: 60% left (used 40.3%, resets in 26h)
  - Monthly window: 30% left (used 70.1%)
- Codex accurately reports: `! no codex credential in the Pi store (found 'openai' API; run /login openai-codex in Pi for subscription quota)`.
