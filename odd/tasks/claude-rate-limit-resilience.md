# Claude Quota Resilience: Fix Indefinite Rate-Limited Upstream Lock

## Problem Analysis
1. Anthropic rate-limits (`429`) when polled more often than once every 5 minutes (`CLAUDE_TTL_SEC = 300`).
2. `piquota` on each minute polling triggered `429`, which locked Claude into `backoff.json` for 5+ minutes minimum.
3. `engine.js` blindly checked `throttle.active` without checking `options.force`, preventing any `--force` or `/quota refresh` from clearing the backoff.
4. `sticky.js` had a 30-minute ceiling (`DEFAULT_MAX_STICKY_AGE_MS = 30 * 60 * 1000`), after which it dropped the last-good data completely, leaving Claude stuck forever in `! rate-limited upstream`.
5. Background timers did not enforce family cadences, hammering Claude every 60s and re-locking it immediately upon backoff expiration.

## Plan
1. [x] `src/engine.js`: When `options.force` is true, clear the backoff and attempt a fresh fetch.
2. [x] `src/providers/backoff.js`: Ensure clean backoff clearing upon success or force, maintaining test contract.
3. [x] `src/moshi/sticky.js`: Allow extended last-good retention (up to 4 hours) during active transient throttling so the user never loses visibility.
4. [x] `extensions/quota-panel.ts` & `bin/piquota.js`: Respect 300s TTL for Claude in automatic background polling, while allowing explicit `/quota refresh` to bypass.
5. [x] Validate tests (59/59 unit tests pass) and live execution against Anthropic OAuth usage API.

## Verification Evidence
- `node --test tests/args.test.mjs`: 12/12 passed
- `node --test tests/render.test.mjs`: 20/20 passed
- `node --test tests/providers.test.mjs`: 11/11 passed
- `node --test tests/engine.test.mjs`: 16/16 passed
- Live verification: Claude returned 200 OK with 4% utilization and reset in 2h 19m.
