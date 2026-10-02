# Resilient gentle-shell right rail integration

Release: v0.8.0

## Goal

Render piQuota in gentle-shell's right rail without changing gentle-shell files during extension startup. An existing native `quota` slot is used when present; otherwise the extension chains the quota card into the live footer component in memory. The above-editor widget returns no lines when the live sidebar state is active or a 140+ column terminal is in fullscreen mode.

## Architecture

- Session startup inspects the installed rail layout read-only. It never calls the patcher's write/repair path and never warns users to restart.
- A patched layout uses the native `quota` rail part.
- An unpatched layout stays byte-for-byte unchanged. When the sidebar is active, the extension wraps `rawState.parts.get("footer")` in memory and restores the original component when disposed.
- The above-editor widget is suppressed whenever the live sidebar state is active, regardless of `ownsHost()`, or a 140+ column terminal is in fullscreen mode.
- Explicit CLI patch commands remain separate from extension startup.

## Tasks

- [x] Task 1: Harden `src/gentle-pi/rail-patch.js` to support gentle-shell v4+ syntax (`.filter()`, chained calls, single/double quotes, multiline).
- [x] Task 2: Add test coverage in `tests/rail-patch.test.mjs` for gentle-shell 4.0.0 layout shapes and update existing tests.
- [x] Task 3: Use read-only rail inspection at startup and retain the in-memory footer chaining fallback for unpatched layouts.
- [x] Task 4: Cover native patched mode, unpatched zero-touch runtime rendering, update resilience, and above-editor suppression in `tests/extension.test.mjs`.
- [x] Task 5: Keep package-file patching opt-in; extension startup does not modify installed gentle-shell files.
- [x] Task 6: Run the focused extension test suite.
- [x] Task 7: Keep the five-row box as the default surface, preserve `/quota line` as an explicit opt-in, and verify `/quota box` restores the box.
- [x] Task 8: Prevent the above-editor quota widget from duplicating the rail card when `ownsHost()` is false or absent, including wide fullscreen mode.

## Verification Evidence

- `node --test tests/extension.test.mjs`: 25 tests passed, 0 failed.
- The default-surface and inactive-rail tests confirm the five-row box remains selected by default; `/quota line` switches to one row, and `/quota box` restores the box.
- The unpatched-layout test confirms the fixture remains byte-for-byte equal to the stock layout, no patch backup is created, no restart warning is emitted, the runtime footer chain renders the quota card, and the above-editor widget returns `[]` while the sidebar owns the host.
- The patched-layout test confirms native rail registration and that startup leaves the already-patched fixture unchanged.
- Bugfix: above-editor rendering now checks the live sidebar state without consulting `ownsHost()`, and also suppresses the widget for a 140+ column fullscreen terminal.
- `node --test tests/extension.test.mjs tests/rail-patch.test.mjs`: 44 tests passed, 0 failed.
- The todo rail-mounting regression test verifies suppression after live sidebar state changes, when `ownsHost()` is false or absent, and for 140-column fullscreen mode.
