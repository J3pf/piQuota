# Change Proposal — make-moshi-pi-approvals-reliable

**Phase:** Proposal (SDD, Auto Mode, Artifact Store: OpenSpec, Delivery: ask-on-risk, Review Budget: 400 lines)  
**Date:** 2026-09-13  
**Target Package:** `piQuota` (`pi-quota`)  
**Status:** Proposal Ready for Review  

---

## 1. Intent & Business Problem

Guarded-command approval requests triggered in Pi (`gentle-pi` bash safety guard) are mirrored to the Moshi mobile app via `extensions/moshi-approvals.ts`. While the phone receives the approval notification card correctly, tapping **Approve** on the phone fails to resolve Pi's terminal prompt in 7 out of 8 live trials (12.5% success rate). The Moshi daemon logs:

```
tui bridge: pending-action.open sent   actionId=… source=pi
tui bridge: remote action executed     type=action.approve status=verification_failed
  reason="approval fingerprint no longer present on screen"
```

The Moshi daemon validates terminal state by comparing a terminal pane fingerprint captured when the approval card is published against a fresh capture when the remote approval arrives. Because Pi's TUI remains active while waiting on `ctx.ui.confirm()`, dynamic visual elements (primarily the working loader/spinner animation) modify the pane contents, invalidating the daemon's screen fingerprint and rejecting the remote action.

**Objective:** Transform Moshi phone approvals for Pi guarded commands from an unreliable baseline (1/8) into a dependable workflow (≥90% success rate in live trials), while preserving strict security invariants, zero credential leakage, and the terminal prompt as an authoritative fallback.

---

## 2. Scope Boundaries & Non-Goals

### In Scope
- **Tiered resolution protocol:**
  1. Inspect installed `moshi-hook` version and upstream releases for supported Pi improvements.
  2. Implement Pi-local render stabilization in `piQuota` (`extensions/moshi-approvals.ts`) by halting TUI animation (working indicator freeze/hide) during blocking prompt lifecycles.
  3. Strict refusal-to-ship gate: Mandate upstream escalation to `gentle-pi` or `moshi-hook` if local stabilization cannot meet the reliability target.
- **Safety & security preservation:** Zero bypass of human confirmation, zero auto-approval, zero synthetic keystroke injection, zero token/secret exposure, terminal prompt remains primary fallback.
- **Automated test coverage:** Unit and mock-socket integration tests covering lifecycle events, working indicator state transitions, and socket envelope serialization.
- **Live verification protocol:** Measurable live trial protocol (≥10 phone approvals) proving real runtime reliability against the daemon.

### Non-Goals (Out of Scope)
- **Unknown gateway POST endpoints:** Probing or sending payloads to unverified daemon endpoints (`POST /v1/prompt`, `POST /v1/keys`) is prohibited.
- **Synthetic keystroke injection:** Directly piping keystrokes into Pi's stdin or TTY without Moshi daemon verification is out of scope.
- **Patching auto-generated files:** Direct edits to `~/.pi/agent/extensions/moshi-hooks.ts` are forbidden (overwritten on `moshi-hook install`).
- **Modifying gentle-pi in this change:** Upstream changes to `gentle-pi` belong in a separate repository and authority line; this change targets `piQuota` first.
- **Altering command preview redaction policy:** Pre-existing command preview behavior (truncated to 256 chars) is kept unchanged without new exposure.

---

## 3. Affected Areas & Architecture

### Affected Repository Files
- `extensions/moshi-approvals.ts`:
  - Listen to Pi prompt lifecycle events (`ui_prompt_start`, `ui_prompt_end`).
  - Coordinate visual stabilization: call `ctx.ui.setWorkingVisible(false)` / `ctx.ui.setWorkingIndicator({ frames: [] })` on prompt start, and restore normal state on prompt end.
  - Maintain defensive, silent-failure error handling so prompt hooks never interrupt the agent's turn.
- `tests/approvals.test.mjs`:
  - Extend test harness with mock UI context and prompt lifecycle events.
  - Assert that working indicator is safely frozen on prompt start and restored on prompt end.
  - Assert that envelope generation and terminal context resolution remain intact.

### External / Upstream Surfaces (Observation & Escalation Only)
- `gentle-pi` (`confirmCommand` in `extensions/gentle-ai.ts`): Emits `pi-permission-system:permission-request`. If Tier 2 fails, upstream proposal targets static prompt overlay (`ctx.ui.custom()`) or direct local approval channel.
- `moshi-hook` daemon (`~/.local/bin/moshi-hook` v0.3.21): Closed-source Go binary managing the TUI bridge and screen fingerprinting.

---

## 4. Tiered Path Strategy

To ensure changes are minimal, supported, and refuse to ship flaky workarounds, implementation follows a strict 3-tier hierarchy:

```
[Tier 1: Supported / Versioned Check]
  │
  ├─► Check moshi-hook version & release notes
  │   Does a supported update eliminate fingerprint flakiness?
  │     ├─► YES: Adopt supported version update & document.
  │     └─► NO: Proceed to Tier 2.
  ▼
[Tier 2: Pi-Local Render Stabilization]
  │
  ├─► Freeze working indicator on `ui_prompt_start` -> restore on `ui_prompt_end`
  ├─► Run live trial verification protocol (≥10 trials)
  │     ├─► PASS (≥90% success, ≥9/10): Ship Tier 2 local stabilization.
  │     └─► FAIL (<90% success): REFUSE TO SHIP LOCAL SLICE. Proceed to Tier 3.
  ▼
[Tier 3: Upstream Escalation (Mandatory Fallback)]
  │
  └─► Escalate to gentle-pi (static overlay / local answer channel)
      and/or moshi-hook (issue for Pi prompt fingerprint inclusion / region scoping).
```

### Tier 1 — Supported / Versioned Integration
- Inspect current daemon version (`moshi-hook v0.3.21`). Check if an official update (`moshi-hook update --version` or upstream release) natively supports Pi prompt handling or allows relaxed verification.
- Inspect official `~/.pi/agent/extensions/moshi-hooks.ts` for updated Pi integration patterns.
- If upstream natively resolves the defect, verify and document without custom workarounds.

### Tier 2 — Pi-Local Render Stabilization (piQuota)
- In `extensions/moshi-approvals.ts`, intercept prompt opening via `ui_prompt_start` and prompt closure via `ui_prompt_end`.
- During active prompt wait, suppress visual animation:
  ```ts
  ctx.ui.setWorkingVisible(false);
  // or setWorkingIndicator({ frames: [] });
  ```
- On `ui_prompt_end`, restore standard working indicator state.
- Validate that the terminal screen remains static between `pending-action.open` and phone tap.
- Subject Tier 2 to the strict live trial verification gate.

### Tier 3 — Upstream Escalation (Mandatory Fallback)
- If Tier 2 does not achieve the target reliability threshold (≥90%), local changes are reverted.
- Upstream changes are required:
  - **gentle-pi upstream:** Render guarded confirmation prompts via a static `ctx.ui.custom()` widget that guarantees zero screen movement, or implement a local promise-racing approval channel.
  - **moshi-hook upstream:** Submit issue with reproduction traces requesting that the daemon include Pi prompt text in its fingerprint table and exclude peripheral status rows from screen fingerprinting.

---

## 5. Security & Safety Invariants

Every candidate implementation must preserve all of the following invariants:
1. **Human Authority Only:** An approval is only granted by an explicit human action (phone tap in Moshi or keypress in Pi terminal). No synthetic approvals, no heuristic auto-approval.
2. **Authoritative Terminal Fallback:** If the Moshi mobile notification is delayed, ignored, or fails verification, the interactive terminal prompt in Pi remains open, responsive, and fully capable of approving or denying.
3. **Zero Credential / Token Exposure:** No tokens, API keys, session secrets, or full transcript payloads are read or transmitted across the socket.
4. **Command Preview Ceiling:** The existing ≤256-character truncated command preview is maintained; no unredacted environment variables or sensitive arguments are added.
5. **Fail-Safe & Non-Blocking:** All extension hook operations fail silently without interrupting Pi's CLI turn or crashing the agent session.

---

## 6. Measurable Acceptance Criteria & Verification Protocol

### Acceptance Criteria
1. **Automated Unit Tests:**
   - 100% pass on `npm test`.
   - Tests verify `ui_prompt_start` and `ui_prompt_end` handlers freeze and restore indicator state without throwing if UI context methods are missing.
   - Tests verify socket envelopes (`PermissionRequest` and `PermissionResolved`) continue to conform to daemon schema.
2. **Live Trial Protocol (The Delivery Gate):**
   - Execute **10 consecutive live guarded-command approval trials** using the Moshi mobile app against a real Pi session in Herdr/tmux.
   - **Pass Threshold:** ≥ 9 out of 10 approvals (≥90%) must successfully resolve the terminal prompt and execute the guarded command.
   - **Daemon Logs:** Zero `verification_failed` occurrences attributable to screen movement.
   - **Terminal Fallback Check:** At least 2 negative control trials where the phone card is left unanswered and the terminal is answered manually (`Enter` or `Esc`); verify clean resolution and prompt closure.
3. **Refusal-to-Ship Policy:**
   - If fewer than 9/10 trials succeed under Tier 2, **the local change will NOT be merged or released**. Tier 2 will be discarded, and the defect will be escalated to Tier 3.

---

## 7. Risk Analysis & Failure Modes

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| **Daemon verification algorithm relies on string matching, not just static screen** | Tier 2 fails because daemon looks for Claude/Codex strings | Pre-tested via Tier 2 trials; if failures persist on static screen, trigger Tier 3 upstream escalation immediately. |
| **`setWorkingVisible(false)` leaves UI stuck hidden after prompt** | Pi appears frozen during subsequent tool execution | Wrap state restoration in `try/finally` and hook both `ui_prompt_end` and `session_shutdown`. |
| **Herdr workspace ID live renumbering** | Mismatched terminal context in envelope | Keep per-instance environment resolution in `resolveTerminalContext()`; never cache IDs across sessions. |
| **Unknown POST gateway endpoints cause side effects** | Potential unintended command execution | Explicitly out of scope; forbidden in this change. |
| **Review budget overrun** | PR too large to review safely | Changes are confined to ~40 lines in `moshi-approvals.ts` and ~60 lines of tests; total < 200 lines (well under 400). |

---

## 8. Rollback Plan

- **Worktree Isolation:** All implementation work is conducted on a dedicated git branch (`change/make-moshi-pi-approvals-reliable`).
- **Clean Rollback Boundary:** Only `extensions/moshi-approvals.ts` and `tests/approvals.test.mjs` are modified. Reverting the commit restores the exact pre-change behavior immediately.
- **Zero Persistent Side Effects:** No database migrations, no configuration schema modifications, and no daemon-side persistent state.
- **Fallback Operational State:** If reverted, Pi guarded-command prompts continue working via terminal confirmation as they do today.

---

## 9. RDD Defect Workflow Matrix

In accordance with the `rdd-defect-workflow` skill:

- **`rdd_mode`:** `unmanaged` (repository uses OpenSpec SDD auto mode; RDD kill switch is unmanaged/advisory for external receipt reviews).
- **`issue_pr`:** Internal change `make-moshi-pi-approvals-reliable`.
- **`causal_invariant`:** Pane visual instability during active prompt invalidates Moshi daemon screen fingerprint. Authority boundary separates visual stabilization (piQuota) from approval execution (daemon/user).
- **`operator_flows`:**
  1. *Phone Approve Flow:* Guarded command triggers prompt -> card sent to phone -> human taps Approve -> daemon validates static screen -> Pi unblocks command.
  2. *Terminal Fallback Flow:* Guarded command triggers prompt -> card sent to phone -> human approves in terminal -> Pi unblocks command -> resolution envelope sent.
  3. *Negative Control Flow:* Phone approval arrives after terminal prompt already resolved -> safely discarded by daemon; no duplicate execution.
- **`journey_runtime_evidence`:** Real runtime E2E proof: 10 live phone approval trials with real Moshi daemon and mobile app. Synthetic proxies are explicitly rejected as proof.
- **`changed_line_budget`:** Forecasted ~100–140 total additions plus deletions (<400 lines limit; no chain or exception required).
- **`tests`:** `npm test` covering unit and socket integration + 10 live trial validation matrix.
- **`rollback`:** Revert commit affecting `extensions/moshi-approvals.ts` and `tests/approvals.test.mjs`.
- **`unresolved_authority_decisions`:** None; orchestrator confirmed safety invariants and exclusion of synthetic key injection / unknown POST gateway endpoints.

---

## 10. Proposal Question Round & Assumptions Needing User Review

### Working Assumptions
1. Freezing the working indicator via `ctx.ui.setWorkingVisible(false)` or `setWorkingIndicator({ frames: [] })` on `ui_prompt_start` will halt the predominant visual changes on screen while Pi waits for input.
2. The installed Moshi daemon (v0.3.21) performs terminal fingerprint verification over the entire active pane; making the pane static satisfies the verification check.
3. If Tier 2 fails the 9/10 live trial threshold, closing this local attempt without shipping code and opening an upstream issue with gentle-pi/moshi is the desired outcome.

### Questions for Confirmation
1. **Tier 1 Version Update:** If `moshi-hook update` shows a newer version (e.g. v0.3.22+) that fixes TUI bridge verification, are we authorized to run the upgrade on the host service to verify Tier 1?
2. **Working Indicator Style Preference:** While a prompt is waiting, is completely hiding the working indicator preferable, or freezing it on a single static dot/frame? (Hiding is typically cleaner for terminal fingerprinting).
3. **Trial Quorum:** Is 10 consecutive live trials with a 90% pass threshold accepted as the definitive gate before shipping Tier 2?
