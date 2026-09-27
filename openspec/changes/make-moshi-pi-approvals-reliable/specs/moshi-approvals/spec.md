# Moshi Approvals Reliability Specification

## Purpose

Guarded-command approval requests raised by Pi's guard (gentle-pi's
`confirmCommand`) are mirrored to the Moshi mobile app by
`extensions/moshi-approvals.ts`. Today, tapping **Approve** on the phone
resolves the terminal prompt in only ~1 of 8 live trials because the Moshi
daemon's screen-fingerprint verification is invalidated by Pi's own TUI
animation while the prompt is open. This specification defines the testable
behavior required to raise phone-approval reliability to a proven ≥90% live
success rate, without weakening any existing security or fallback guarantee,
and without silently mutating the operator's `moshi-hook` installation.

## Requirements

### Requirement: Moshi-hook version audit is read-only and human-gated

The system MUST provide an operational, human-supervised procedure to check
the installed `moshi-hook` daemon version and available upstream releases
before any Pi-local code change is authored. Following that read-only audit,
a version-pinned update to the specific newer target version the audit
identifies is pre-authorized by the human record for verification purposes,
provided (a) the update targets an exact, named version (never a floating
"latest"), and (b) a documented rollback path (Section: rollback
requirement below) is recorded before the update is applied. No code,
script, or extension in this repository MUST ever perform a `moshi-hook`
version change automatically; every update remains a manual, human-executed
action carried out after the audit, never a side effect of running,
installing, or loading this extension or its tests.
(Previously: any update required a separate, per-instance explicit human
authorization event; now a version-pinned update is pre-authorized once the
audit names an exact target version and a rollback path is documented, while
automated/code-triggered updates remain forbidden.)

#### Scenario: Version audit is inspection-only

- GIVEN the operator runs the moshi-hook version audit procedure
- WHEN the procedure queries the installed daemon version and the latest
  available upstream release
- THEN it MUST only read version metadata (e.g. `moshi-hook --version`,
  `/v1/version`, release notes) and MUST NOT invoke any install, update, or
  uninstall command as part of the audit

#### Scenario: Version-pinned update is pre-authorized but always human-executed

- GIVEN the read-only audit identifies a specific newer `moshi-hook` version
  and a rollback path for it has been documented
- WHEN the operator decides to verify that target version
- THEN the operator MAY run the update manually, pinned to that exact
  version, without needing a further separate authorization request, but no
  script, hook, extension code, or agent action MUST invoke the update
  automatically on the operator's behalf

#### Scenario: No code silently updates or reinstalls moshi-hook

- GIVEN any file changed by this effort (extension code, tests, scripts)
- WHEN that code executes, at any lifecycle point (install, load, runtime,
  test)
- THEN it MUST NOT invoke `moshi-hook update`, `moshi-hook install`, or any
  equivalent daemon-mutating command as a side effect, regardless of whether
  a version-pinned update has been pre-authorized for manual execution

### Requirement: Moshi-hook rollback path is defined and verified before adoption

If a `moshi-hook` version change is authorized and applied as part of
resolving this defect, the system MUST have a documented, tested rollback
path back to the previously installed version before the new version is
relied upon for the live verification gate.

#### Scenario: Rollback command is known and recorded before upgrading

- GIVEN a human authorizes upgrading the installed `moshi-hook` daemon
- WHEN the upgrade is performed
- THEN the exact command and prior version identifier needed to roll back
  MUST be recorded in the change artifacts before the upgrade is treated as
  the new baseline

#### Scenario: Rollback restores prior behavior without residual state

- GIVEN the daemon was rolled back to its previously installed version
- WHEN the guarded-command approval flow is exercised afterward
- THEN daemon behavior (fingerprint verification, socket protocol, service
  status) MUST match the state observed before the upgrade, with no leftover
  configuration or state from the newer version affecting verification

### Requirement: Auto-generated moshi-hook extension is never patched in place

The system MUST NOT directly edit `~/.pi/agent/extensions/moshi-hooks.ts` or
any other file that `moshi-hook install` regenerates, because such edits are
silently overwritten and create an undetected drift between reviewed code
and running code.

#### Scenario: Stabilization logic lives outside the generated file

- GIVEN the need to stabilize Pi's TUI during a blocking approval prompt
- WHEN the fix is implemented
- THEN all new logic MUST be added to `extensions/moshi-approvals.ts` (or
  another repository-owned file), and the generated `moshi-hooks.ts` MUST
  remain byte-for-byte as produced by `moshi-hook install`

### Requirement: Working indicator is hidden entirely, never frozen on a static frame, for the full duration of a blocking prompt

While any blocking UI prompt is open in Pi (`ui_prompt_start` has fired and
the matching `ui_prompt_end` has not yet fired), the extension MUST fully
hide the working indicator/animation rather than freeze it on a static
frame, so that the terminal pane content does not change due to Pi's own
rendering while a human decision is pending.
(Previously: either hiding the indicator or freezing it on a static frame
(`setWorkingIndicator({ frames: [] })`) was treated as an acceptable
implementation choice; hiding is now the required behavior.)

#### Scenario: Indicator is fully hidden when a guarded-command prompt opens

- GIVEN Pi is about to block on `ctx.ui.confirm()` for a guarded command
- WHEN the `ui_prompt_start` lifecycle event fires
- THEN the extension MUST call the working-indicator visibility API (e.g.
  `ctx.ui.setWorkingVisible(false)`) to fully hide the indicator before the
  prompt is expected to be visible on screen, and MUST NOT instead leave a
  static frame rendered (e.g. via `setWorkingIndicator({ frames: [] })` or
  any single-frame substitute) while the prompt is open

#### Scenario: Indicator is restored exactly once when the prompt closes

- GIVEN the working indicator was suppressed for an open prompt
- WHEN the matching `ui_prompt_end` lifecycle event fires
- THEN the extension MUST restore the working indicator to its
  pre-suppression state, and MUST NOT restore it more than once for the
  same prompt instance

### Requirement: Prompt lifecycle handling is safe under nested and overlapping prompts

The extension MUST correctly track prompt open/close state when prompts are
nested or fire out of naive expected order, so that the working indicator is
never left permanently hidden or spuriously restored while another prompt is
still pending.

#### Scenario: Nested prompt does not cause premature restoration

- GIVEN a blocking prompt is already open and its indicator suppression is
  active
- WHEN a second `ui_prompt_start` fires before the first prompt's
  `ui_prompt_end`, followed later by two `ui_prompt_end` events
- THEN the working indicator MUST remain suppressed until the last
  outstanding prompt closes, and MUST be restored only after the final
  matching `ui_prompt_end`

#### Scenario: Unbalanced prompt-end does not restore prematurely or double-restore

- GIVEN internal prompt-tracking state counts active prompts
- WHEN more `ui_prompt_end` events are observed than `ui_prompt_start`
  events (e.g. due to a missed start event)
- THEN the extension MUST clamp its internal counter at a non-negative
  value and MUST NOT call the restore API when no prompt is tracked as
  active

### Requirement: Prompt lifecycle handling degrades safely when UI APIs are missing

The extension MUST NOT throw, crash the extension host, or interrupt the
user's turn when the working-indicator suppression or restoration APIs are
unavailable on the running Pi version or `ctx.ui` object.

#### Scenario: Missing setWorkingVisible does not throw

- GIVEN `ctx.ui.setWorkingVisible` is undefined or not a function on the
  running Pi version
- WHEN `ui_prompt_start` fires
- THEN the extension MUST detect the missing API defensively (e.g. a
  `typeof` check) and skip the hide call without throwing or logging an
  error that could interrupt the turn, and MUST NOT fall back to a
  static-frame freeze as a substitute for hiding

#### Scenario: Missing restoration API does not throw

- GIVEN the working indicator was suppressed using one API and the
  corresponding restoration API is unavailable at `ui_prompt_end` time
- WHEN the extension attempts to restore the indicator
- THEN it MUST catch any resulting error internally and MUST NOT propagate
  an exception out of the `ui_prompt_end` handler

#### Scenario: Session shutdown always clears suppression state

- GIVEN the working indicator is suppressed when the session ends
- WHEN `session_shutdown` fires
- THEN the extension MUST reset its internal prompt-tracking state and
  attempt to restore the working indicator (best-effort, silent-failure) so
  a future session or reload does not inherit a stuck-hidden indicator

### Requirement: Approval flow preserves human-authority and non-bypass invariants

No change made to satisfy this specification may weaken who is authorized to
approve a guarded command or how that approval is delivered.

#### Scenario: Only an explicit human action can approve

- GIVEN a guarded command is awaiting approval, mirrored to the phone
- WHEN the pending state is resolved
- THEN resolution MUST originate from either an explicit phone tap verified
  by the Moshi daemon or an explicit terminal keypress by the human operator,
  and MUST NOT originate from any heuristic, timer-based, or synthetic
  auto-approval added by this change

#### Scenario: No synthetic keystroke injection is introduced

- GIVEN the stabilization logic runs while a prompt is open
- WHEN it executes its suppression/restoration behavior
- THEN it MUST NOT write to Pi's stdin, TTY, or any input stream to
  simulate a keypress or answer the prompt programmatically

#### Scenario: No new secret or credential exposure

- GIVEN the envelope sent to the Moshi daemon for a permission request or
  resolution
- WHEN the envelope is constructed by the extension
- THEN it MUST NOT include any authentication token, API key, session
  secret, or full command/tool payload beyond the existing ≤256-character
  truncated command preview

#### Scenario: Unknown daemon gateway endpoints remain untouched

- GIVEN the Moshi daemon exposes undocumented POST endpoints (e.g.
  `/v1/prompt`, `/v1/keys`)
- WHEN the extension is modified to fix approval reliability
- THEN it MUST NOT send requests to any daemon HTTP endpoint whose request
  semantics have not been confirmed read-only or side-effect-free, and MUST
  continue to use only the existing Unix-socket/named-pipe envelope protocol

### Requirement: Terminal prompt remains an authoritative, always-available fallback

Regardless of Moshi phone-approval outcome, the interactive terminal prompt
MUST remain the primary and fully functional means of resolving a guarded
command.

#### Scenario: Terminal approval works when the phone never answers

- GIVEN a guarded-command approval card was sent to the phone and the phone
  answer never arrives
- WHEN the human answers the prompt directly in the terminal (approve or
  deny)
- THEN Pi MUST resolve the guarded command based on the terminal answer
  without waiting for or requiring any phone response

#### Scenario: Late phone answer after terminal resolution is discarded safely

- GIVEN the terminal prompt has already been resolved by the human
- WHEN a phone approval or denial for the same `requestId` arrives afterward
- THEN the system MUST NOT execute the guarded command a second time and
  MUST NOT reopen or reinterpret the already-closed prompt

#### Scenario: Working-indicator suppression never blocks terminal input

- GIVEN the working indicator is suppressed while a prompt is open
- WHEN the human interacts with the terminal to answer the prompt
- THEN the suppression logic MUST have no effect on Pi's ability to accept
  and process that terminal input

### Requirement: Extension hooks fail silently and never interrupt the agent turn

Consistent with the project's existing convention, every hook added or
modified for this change MUST treat all internal errors as non-fatal to the
user's turn.

#### Scenario: An exception inside the lifecycle handler is swallowed

- GIVEN any unexpected error occurs while handling `ui_prompt_start`,
  `ui_prompt_end`, or `session_shutdown` (e.g. a malformed event payload)
- WHEN that error is thrown internally
- THEN it MUST be caught within the extension and MUST NOT propagate to Pi's
  core event loop or interrupt the current agent turn

### Requirement: Live verification gate proves real-world reliability before release

Local unit and mock-socket tests are necessary but not sufficient. The
system MUST be proven against the real Moshi daemon and mobile app before
any Tier 2 local stabilization change is treated as shippable.

#### Scenario: Ten consecutive live trials are executed and recorded

- GIVEN a candidate Tier 2 stabilization change is ready for verification
- WHEN the live verification protocol is run
- THEN exactly 10 consecutive live guarded-command approval trials MUST be
  executed against a real Pi session and the real Moshi daemon/mobile app,
  with each trial's outcome (success/failure) and daemon log excerpt
  recorded in the change's verification evidence

#### Scenario: Nine or more successes out of ten is required to pass

- GIVEN the 10 live trials have been executed and recorded
- WHEN the pass/fail determination is made
- THEN the gate MUST require at least 9 of the 10 trials to resolve the
  terminal prompt via a verified phone approval with zero
  `verification_failed` daemon log entries attributable to screen movement,
  and any result below 9/10 MUST be recorded as a gate failure

#### Scenario: At least two negative-control trials validate terminal fallback

- GIVEN the 10-trial protocol is being executed
- WHEN at least 2 of the trials are designated as negative controls
- THEN those trials MUST leave the phone card unanswered and resolve the
  guarded command manually in the terminal, and the daemon MUST show clean
  resolution/discard behavior with no duplicate command execution

#### Scenario: Fewer than 9/10 successes blocks release and forces escalation

- GIVEN the live trial protocol result is below the 9-of-10 pass threshold
- WHEN the release decision is made
- THEN the Tier 2 local stabilization change MUST NOT be merged, released,
  or reported as resolving the defect, and the defect MUST instead be
  recorded for Tier 3 upstream escalation (gentle-pi and/or moshi-hook)

#### Scenario: Synthetic or mocked trials never substitute for live evidence

- GIVEN automated unit tests or mock-socket integration tests pass at 100%
- WHEN determining whether the live verification gate is satisfied
- THEN passing automated tests alone MUST NOT be treated as satisfying the
  live verification gate; only the recorded outcomes of real live trials
  against the actual daemon and mobile app count toward the 9-of-10
  threshold

### Requirement: Automated tests cover lifecycle handling and envelope integrity

The system MUST have automated unit and mock-socket integration tests that
exercise the new lifecycle behavior and confirm no regression to the
existing envelope protocol.

#### Scenario: Tests cover indicator freeze and restore transitions

- GIVEN the test suite for `extensions/moshi-approvals.ts`
- WHEN `npm test` is run
- THEN it MUST include tests asserting the working indicator is suppressed
  on `ui_prompt_start` and restored on `ui_prompt_end`, including the
  missing-API and nested-prompt scenarios above

#### Scenario: Tests confirm envelope schema is unchanged

- GIVEN the `PermissionRequest` and `PermissionResolved` socket envelopes
- WHEN the test suite runs
- THEN it MUST assert the envelope shape and required fields continue to
  match the daemon-expected schema after the lifecycle-handling change,
  with no new fields that leak secrets or expand the command preview beyond
  256 characters
