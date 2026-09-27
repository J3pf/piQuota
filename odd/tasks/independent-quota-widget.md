# Independent quota widget

## Goal
Make the Pi quota widget render through Pi's native extension widget surface without depending on gentle-pi's experimental sidebar internals.

## Tasks

- [x] Record the current failure mode and scope.
- [x] Remove direct gentle-pi sidebar state/cache coupling from `extensions/quota-panel.ts` while preserving the right-aligned box fallback.
- [x] Update focused extension tests so the regression is pinned.
- [x] Run focused verification and record results.

## Evidence

- Removed use of `gentle-pi.experimental-sidebar.state` and `gentle-pi.experimental-sidebar.cache` from `extensions/quota-panel.ts`.
- Added a regression test that renders the widget with those symbols present and active, expecting quota content instead of suppression.
- Verification: `node --test tests/extension.test.mjs` passed 20/20.
- Native review start was declined for this candidate by the host-owned consent path; no lineage was created.
- Independent verifier subagent launch did not progress beyond startup and was cancelled; no separate verifier evidence was produced.

## Root cause (confirmed after the first report still failed)

The first fix reached the repository but not the running Pi process: Pi loads
`~/.pi/agent/extensions/quota-panel.ts`, which `install.sh` copies, and that copy
was still the previous revision containing the gentle-pi suppression branch.

- `~/.pi/agent/extensions/quota-panel.ts` mtime was 11:38 and still contained
  `experimental-sidebar`; the repository revision was 14:22.
- Installing the repository revision (hash-identical copy) removed the last
  reference to the gentle-pi sidebar symbols.

## Why painting order is not the problem

Pi mounts the widget containers inside the chat viewport dock, which gentle-pi
does not replace:

- `chat-viewport.js`: `root = VStack[transcript, dock]`, and
  `dock = VStack[pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer]`.
- `gentle-pi/lib/shell-sidebar-layout.ts`: `root[NODE]` becomes
  `hstack[left(root), scroll(rail)]`, so the dock — and `widgetsAbove` — stays in
  the left column untouched.

The old extension returned `[]` while gentle-pi's sidebar was active, so the box
was suppressed by piQuota itself, not erased by gentle-pi. No gentle-pi patch and
no paint-order hack is required, which is why a gentle-pi update cannot undo it.

## Installer staleness (fixed)

`install.sh --link` copied the extension instead of linking it, so a repository
edit never reached Pi. Verified on this machine:

- plain `ln -sfn` under Git Bash creates a real copy when the platform denies
  symlinks (Windows without Developer Mode): the target has no reparse point.
- `MSYS=winsymlinks:nativestrict ln -sfn` fails with `Operation not permitted`.

`install_extension()` now attempts the link, verifies it with `[[ -L ]]`, and
falls back to a copy that says so explicitly and tells the operator to re-run the
installer. A first attempt was rejected by verification: `local a=1 b=$a` leaves
`$a` unset because bash expands every right-hand side of one `local` before
assigning any of them, so the assignments are now separate statements.

Verified in both modes with temporary `PI_QUOTA_PREFIX`/`PI_QUOTA_EXT_DIR`:
link mode reports the honest copy fallback, copy mode installs normally, and
`bash -n install.sh` passes.

## Rail placement is blocked upstream

gentle-pi 3.3.0 renders a hardcoded rail allowlist:

```ts
const sections = ["footer", "agents", "todo"].map((key) => { /* ... */ });
```

Registered parts in the installed package are `footer`, `changes`
(gentle-shell) and `todo` (gentle-todo). So `changes` is registered but never
rendered, and `agents` is rendered although nothing registers it: the allowlist
has already drifted from both the registering code and the documentation, which
describes the rail as `Status -> Changes -> TODO`.

Consequences:

- A `quota` part is registered but never painted, so a rail card cannot appear
  below Status/TODO without a gentle-pi change.
- Patching `node_modules/gentle-pi` is wiped by every gentle-pi update.
- Taking over a rendered key (for example `todo`) loses the race against
  gentle-todo's own re-registration and would hide the TODO card.

The durable fix is upstream: make the rail section list data-driven (render every
registered part in a defined order) and publish a capability signal so a consumer
can tell whether the rail accepts a part. piQuota would then render the rail card
when the capability is present and keep the native above-editor box otherwise.

## Decision: patch gentle-pi, but validate and re-apply

The user rejected a bare local patch and rejected the pure-native fallback. Chosen
approach: patch the installed gentle-pi rail allowlist AND ship a validator that
detects when the patch disappears and re-applies it.

Surfaces:

| Surface | Behaviour |
|---|---|
| gentle-pi absent | native above-editor box |
| gentle-pi present, patch applied, rail active | rail card below TODO, native box suppressed |
| gentle-pi present, patch applied, rail inactive (narrow or regular mode) | native box |
| gentle-pi present, patch wiped by an update | validator re-applies at session start; native box until then |
| gentle-pi shape unrecognized | no write, native box, explicit report |

Why the native box must stay conditional: the rail only exists in fullscreen at
140 columns or wider, so a static "rail mode" decision would leave the box
invisible in regular mode. The suppression therefore reuses gentle-pi's own
`state.active` and `state.ownsHost()`, and only when the patch is known applied.

Safety properties required of the patch:

- one anchored edit, idempotent, reversible, atomic write, one-time backup;
- refuse to write on an unrecognized shape instead of guessing;
- verification re-read after writing, with restore from backup on failure.

### Planned work units

1. `src/gentle-pi/rail-patch.js` plus `tests/rail-patch.test.mjs`: pure detect,
   apply, revert, ensure logic. No Pi, no network. **Done.**
2. Wiring: register the rail card and the conditional suppression in
   `extensions/quota-panel.ts`, expose the check through `bin/piquota.js`, and
   call it from `install.sh` on install and revert on uninstall. **Done.**
3. Harden `renderSidebarCard` width safety. **Done.**

## Evidence

Focused suites: `node --test tests/rail-patch.test.mjs tests/extension.test.mjs`
passed 38/38.

`tests/rail-patch.test.mjs` (15) pins: idempotent apply, byte-exact revert,
refusal on an unrecognized or ambiguous shape, a missing file that never throws,
different keys still receiving the part, an empty allowlist, a one-time backup,
unrelated `quota` occurrences left alone, and `ensureRailPatch` reporting a repair
only when a wipe was actually undone.

`tests/extension.test.mjs` (23) adds three rail tests that run against a throwaway
gentle-pi fixture through a throwaway CLI tree, so no test touches a real install:
the slot is patched in at session start and then owns the card; a patched rail that
is not active keeps the box; and a wiped slot is re-applied on the next session
with a notification.

Real installation, verified: the patch changed exactly one line of the installed
gentle-pi 3.3.0 layout (diffed before/after, one line in and one line out) and left
a backup. `install.sh --copy` on a temporary prefix applied the slot, and
`install.sh --uninstall` reverted the fixture to its exact original bytes. The
installed extension, rail-patch module, and CLI are hash-identical to the
repository copies.

Two defects were found and fixed by this work's own tests:

- `dropPart` only handled a part with a separating comma, so reverting a
  single-entry allowlist left the file patched and failed verification.
- A first `install.sh` attempt reported "linked" while Git Bash silently copied;
  it now verifies with `[[ -L ]]` and states the copy fallback.

### Verification fallbacks and gaps

- The `gentle-ai-worker` and `gentle-ai-verify` subagent launches did not progress
  past `starting` (0 turns) across three attempts, so this work was implemented and
  verified inline by the parent. No separate verifier agent produced evidence.
- Native review start was declined for the earlier candidate by the host-owned
  consent path; no lineage was created.
- `npm test` (full suite) is 224/238. The 14 failures are pre-existing and
  platform-specific, not caused by this change: 9 approval tests need a Unix socket
  (`EACCES` on Windows) plus one Windows ESM path failure, one Claude Code message
  asserts a `/` separator, one README table check fails on CRLF, one sticky-window
  assertion, and two file-mode assertions (`0666` vs `0600`).

## Remaining limitation

In fullscreen with the sidebar active, the card is painted in gentle-pi's own rail
column, below Status and TODO. That placement depends on the patched allowlist: if
the patch cannot be applied, the card falls back to the box above the editor rather
than disappearing.
