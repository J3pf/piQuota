# Technical Design — make-moshi-pi-approvals-reliable

**Status:** upstream-gated; no implementation is authorized by this design alone.  
**Scope:** `piQuota`, with an explicitly removable local adapter and escalation requests to Pi, gentle-pi, and moshi-hook.  
**Review budget forecast:** local adapter/tests/evidence, 180 changed lines maximum; upstream work is a separate authority line and rollback boundary.

## 1. Decision summary

Tier 1 is complete and produces no operational action. The official Homebrew formula at `https://raw.githubusercontent.com/rjyo/homebrew-moshi/main/Formula/moshi-hook.rb` declares `version "0.3.21"`, which matches the installed daemon. There is no newer official version to install, test, or document as an update path.

The proposed `ui_prompt_start` / `ui_prompt_end` approach is **not a timing guarantee**. Pi documents those events as notification-only, best-effort handlers that are not awaited before the dialog opens or closes. Pi also coalesces nested prompts into one outer span. Therefore, a handler may hide the loader only after `ctx.ui.confirm()` has painted; it cannot establish the required stable fingerprint capture boundary.

More importantly, the released Pi `ExtensionUIContext` exposes only write APIs:

- `setWorkingVisible(boolean)` mutates one global `workingVisible` value;
- `setWorkingIndicator(options?)` mutates one global indicator configuration;
- neither API exposes the prior visibility nor the user/other-extension indicator configuration.

Calling `setWorkingVisible(true)` at prompt end would blindly overwrite a pre-existing hidden selection. Calling `setWorkingIndicator()` to restore defaults would erase a user-selected/custom indicator. The local extension must not do either. Consequently, the current Pi API cannot support a correct production stabilizer, and this change must not ship a best-effort hide/restore workaround.

The durable path is an upstream, caller-owned prompt lease: gentle-pi acquires a Pi-managed temporary working-loader suppression synchronously **before** it calls `ctx.ui.confirm()` and releases it in `finally`. The Pi host, not an extension, preserves the baseline selection and composes overlapping leases. moshi-hook should also make its verification Pi-aware and region-scoped rather than fingerprinting a mutable whole pane.

## 2. Existing flow and boundaries

```text
gentle-pi confirmCommand
  ├─ emits permission-request: waiting ──> piQuota moshi-approvals ──> Unix socket
  └─ await ctx.ui.confirm(...)            ──> Pi TUI prompt
                                                    │
Moshi phone tap ──> moshi-hook TUI bridge ──> screen verification ──> native terminal input
```

`extensions/moshi-approvals.ts` only mirrors a request and its terminal outcome. It does not create, resolve, or inject input into the confirmation. The terminal prompt remains the sole local authority; Moshi remains an independently verified remote human action. The local socket schema, command preview ceiling (256 characters), terminal-context resolution, and silent-failure convention are unchanged.

The proposed upstream lease belongs at the `confirmCommand()` call site because that is the only component that can place suppression before `ctx.ui.confirm()` is entered. The piQuota extension cannot establish that ordering by observing a later lifecycle notification.

## 3. Required Pi host contract

Pi needs a temporary, composable UI override API. Names are illustrative; the semantics below are normative for the escalation request.

```ts
interface ExtensionUIContext {
  acquireWorkingVisibilityOverride(visible: boolean): { release(): void };
}
```

### Host-owned state model

Pi maintains these separately:

- `workingVisibleBase`: the current user/normal-extension visibility selection.
- `workingIndicatorOptions`: the current user/normal-extension indicator frames and interval.
- `workingVisibilityLeases`: active opaque leases, each requesting a visibility value.
- `effectiveWorkingVisible`: false when any active lease requests false; otherwise `workingVisibleBase`.

`setWorkingVisible(value)` updates `workingVisibleBase`, even while a lease is active, then recomputes the effective value. A lease never changes `workingIndicatorOptions`. `setWorkingIndicator(options)` continues to update only the indicator options and is not reset when a lease is released. `release()` is idempotent, removes only its own lease, and recomputes effective visibility from the *then-current* base state.

This precisely preserves selections:

| Initial base | During lease | A concurrent base change | Final release result |
|---|---|---|---|
| visible | hidden | none | visible with untouched custom frames |
| hidden | hidden | none | hidden |
| visible | hidden | set hidden | hidden |
| hidden | hidden | set visible | visible |

The host must request a render after every effective-value change. It must not infer state from whether an indicator row happens to be rendered; streaming state and visibility are distinct.

### Caller timing and cleanup contract

In gentle-pi, the guarded confirmation path must have this form (pseudocode):

```ts
const lease = ctx.ui.acquireWorkingVisibilityOverride(false);
try {
  return await ctx.ui.confirm("Allow guarded command?", preview);
} finally {
  lease.release();
}
```

The acquisition is synchronous and occurs in the same call stack before `confirm()`, so it is testable as an ordering requirement. `finally` covers approval, denial, cancellation, UI exception, and abort. Pi destroys all session-bound leases on `session_shutdown`; releases after destruction are harmless no-ops. Multiple pending confirmations compose without a premature re-show because each owns a separate lease.

This is intentionally not built from `ui_prompt_start/end`. Those events can remain observability signals for integrations, but cannot be used as the correctness mechanism.

## 4. piQuota-local design and removability

### Current-platform behavior

No production change may call `setWorkingVisible` or `setWorkingIndicator` from `extensions/moshi-approvals.ts` while the required Pi lease API is absent. The extension will continue to mirror `PermissionRequest` and `PermissionResolved` exactly as today. This avoids clobbering global UI state and makes the local repository safe to remove or revert without changing approval authority.

### Future optional adapter

If the Pi lease API is released, add a small, isolated `PromptRenderLease` adapter in `extensions/moshi-approvals.ts` (or a sibling repository-owned helper if it grows beyond roughly 70 lines). The adapter must:

1. Feature-detect `ctx.ui.acquireWorkingVisibilityOverride`; it must never emulate the API with `setWorkingVisible` or `setWorkingIndicator`.
2. Hold at most one lease for the Pi-coalesced `ui_prompt_start/end` span, using `active: boolean`, not a prompt counter.
3. Acquire only after `ui_prompt_start` for generic prompts as best-effort observability; it must be documented as non-authoritative and must not claim pre-paint stabilization.
4. Release exactly that lease on `ui_prompt_end` or `session_shutdown`, with idempotent `releaseOnce()` cleanup. Duplicate ends and ends after shutdown do nothing.
5. Catch all adapter errors locally and never alter envelopes, input streams, or terminal prompt behavior.

The generic adapter is not a substitute for the gentle-pi caller lease. It is removable in one commit and should not ship as the claimed reliability fix unless the caller-owned ordering test and live gate both pass.

## 5. Upstream escalation artifact

Implementation must add `openspec/changes/make-moshi-pi-approvals-reliable/evidence/upstream-escalation.md` before any release decision. It is the handoff record, not an automated action, and contains:

1. **Observed evidence:** installed `moshi-hook` 0.3.21; official formula also 0.3.21; eight baseline trials (one success, seven `verification_failed`); the exact daemon reason `approval fingerprint no longer present on screen`; rejected quota-refresh and delayed-envelope hypotheses.
2. **Pi request:** implement the lease API and its base/override semantics from Section 3, plus host tests for base-state preservation, custom indicator preservation, overlapping leases, shutdown disposal, and a synchronous-before-confirm ordering test.
3. **gentle-pi request:** change only `confirmCommand()` to acquire/release the lease around its existing native `ctx.ui.confirm()`. Preserve the existing permission event and `finally` resolution emission. No remote decision channel, auto-approval, or synthetic terminal input is requested.
4. **moshi-hook request:** recognize Pi's native prompt (`Allow guarded command?`) and verify a bounded prompt region or a daemon-owned stable anchor instead of a whole-pane hash. Request diagnostic fields that distinguish an absent prompt, changed prompt region, and unrelated pane movement. Do not request relaxed verification or an undocumented POST endpoint.
5. **Reproduction package:** Pi/gentle-pi/moshi-hook versions, terminal kind and non-secret identifiers, test command, trial table, timestamps/durations, `pending-action.open` and result log excerpts, and pane-diff evidence when safely collected. The document must omit socket paths that identify users, credentials, full commands, and all tokens.
6. **Acceptance contract:** caller lease acquired before `confirm`, prompt remains terminal-resolvable, 10 consecutive real phone trials with at least 9 verified phone resolutions and zero screen-motion `verification_failed` entries, plus two terminal-only negative controls. A mocked or static capture test alone cannot satisfy this gate.

If the local/static attempt records fewer than 9 successes, leaves unexplained movement, or cannot prove the caller ordering, the evidence file is completed and the local slice is not merged or released as a fix.

## 6. Test design

### Extension loading with a Pi mock

Extend `tests/approvals.test.mjs` rather than starting Pi. It already dynamically imports `extensions/moshi-approvals.ts` and invokes the default extension factory. Its harness becomes the canonical Pi mock:

- `pi.on(name, handler)` stores lifecycle handlers in a `Map`.
- `pi.events.on(channel, handler)` stores the inter-extension listener and returns an unsubscribe closure.
- `emitLifecycle(name, event, ctx)` invokes a stored handler and captures thrown errors, so tests can assert silent failure.
- `ctx` includes only the APIs under test: session metadata and `ui` methods implemented as spies.
- the existing throwaway Unix socket remains the integration boundary for envelope assertions; no Moshi daemon, terminal, credential, or phone is needed for unit tests.

For the future API, the mock provides a faithful `acquireWorkingVisibilityOverride` model with `baseVisible`, unchanged `indicatorOptions`, active leases, idempotent release, and `setWorkingVisible` changing the base. It must not make the nonexistent current API appear available in tests that target the currently installed Pi version.

### Required automated cases

1. Existing request/resolution envelope schema tests remain byte/field equivalent, including 256-character preview truncation and secret-negative checks.
2. With only current Pi UI methods present, lifecycle emissions neither call `setWorkingVisible` nor `setWorkingIndicator`, and do not throw. This prevents an unsafe fallback from being introduced.
3. With the proposed lease API mock, one coalesced start/end acquires and releases one lease; the indicator options object is never reset or replaced.
4. A base-visible and a base-hidden fixture each end in their own original/base-selected state; a base change during suppression wins when the lease releases.
5. Repeated start/end, end without start, and shutdown followed by end produce at most one release and no global reset.
6. Simulated overlapping lease owners keep the effective loader hidden until the final release, proving that session shutdown of one owner cannot reveal another owner’s prompt.
7. A separate upstream gentle-pi test spies on the ordered calls and proves `acquire -> confirm -> release`, including resolve, reject, and cancellation paths. This is the only automated proof of pre-confirm ordering.

`npm test` must pass, but it is not evidence of phone approval reliability.

### Live verification and static-render evidence

After upstream support exists, run 10 consecutive guarded-command trials against a real TUI Pi session, real moshi-hook, and paired phone. Record one row per trial: candidate/version, request ID redacted to a suffix, prompt-open timestamp, phone-action timestamp, result, command execution count, and relevant daemon log excerpt. At least two designated trials leave the phone unanswered and are resolved manually in the terminal (one approval and one denial where feasible). A late phone response after terminal resolution must cause no duplicate execution.

A pane-diff capture is diagnostic evidence only and must use a safe terminal-native capture or a previously established read-only capture method. The unknown `POST /v1/prompt` and `POST /v1/keys` endpoints are not used. The live gate passes only at 9/10 or better with zero screen-motion verification failures; otherwise escalation is the deliverable.

## 7. Security, rollout, and rollback

- No code invokes `moshi-hook update`, install, uninstall, or gateway POST routes. Tier 1 confirmed there is no update to adopt.
- No code writes stdin/TTY, sends synthetic approval, races a promise with a remote answer, changes permission authority, or expands the envelope.
- The terminal confirmation remains available while a caller lease is active.
- The local rollback boundary is `extensions/moshi-approvals.ts`, `tests/approvals.test.mjs`, and the change-local escalation evidence. Reverting it restores current mirroring behavior with no daemon state or configuration migration.
- Pi, gentle-pi, and moshi-hook changes must be independently reviewed and released; they are not authorized as edits in this repository by this change.

## 8. RDD result fields

- **rdd_mode:** unmanaged; this OpenSpec design does not claim receipt authority.
- **issue_pr:** `make-moshi-pi-approvals-reliable`; upstream requests are separate authority lines.
- **causal_invariant:** whole-pane fingerprinting cannot safely accept a mutable TUI, and a best-effort observer cannot establish pre-paint state or restore unobservable global state.
- **operator_flows:** verified phone approval, terminal approval/denial fallback, and late-phone-answer discard without duplicate execution.
- **journey_runtime_evidence:** real TUI/daemon/phone 10-trial protocol only; unit mocks prove contracts but not the runtime bridge.
- **changed_line_budget:** local forecast <=180 additions plus deletions; upstream work is excluded and must receive its own forecast.
- **tests:** `npm test`, upstream ordering/lease tests, and recorded live trials.
- **rollback:** revert the isolated local adapter/evidence commit; independently revert any upstream lease change.
- **unresolved_authority_decisions:** maintainers must accept the Pi lease API and decide whether moshi-hook implements region-scoped verification, a stable Pi anchor, or both.
