# Refactor Pi Quota: Right-aligned Box Widget

## Context and Goal
Refactor the Pi quota widget to render on the right-hand side of the terminal above the editor as a compact box showing:
1. `Claude`: 5h window % and R:reset time
2. `Codex`: 5h window % and R:reset time
3. `Agy`: Antigravity Gemini 5h window % and R:reset time
4. `Agy C/G`: Antigravity Claude/GPT 5h window % and R:reset time
5. `OP-Go`: OpenCode Go 5h window % and R:reset time

Every line is colorized with brand colors for labels, semaphore threshold colors for used %, and muted reset timers, neatly enclosed in a rounded border box aligned to the right.

## Tasks
1. [x] Design data model extraction for the 5 target quota rows (Claude, Codex, Agy Gemini 5h, Agy Claude/GPT 5h, OP-Go) including reset countdowns.
2. [x] Implement `renderBox` formatting with brand colors, semaphore glyphs, percentage and `R:<time>` reset timers, right-aligned to terminal columns.
3. [x] Integrate into `extensions/quota-panel.ts` as primary widget display and sync to `~/.pi/agent/extensions/quota-panel.ts`.
4. [x] Validate live rendering and verify tests.

## Verification Evidence
- `node --test tests/args.test.mjs`: 12/12 passed (including `--box` flag test).
- `node --test tests/providers.test.mjs`: 11/11 passed.
- `node --test tests/render.test.mjs`: 20/20 passed.
- Live CLI run (`node bin/piquota.js --box`): Successfully rendered right-aligned 5-row box with accurate timers and percentages.
- Pi extension synchronized at `~/.pi/agent/extensions/quota-panel.ts`.
