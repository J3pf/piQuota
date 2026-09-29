# pi-quota

One source of truth for quota: **the credentials Pi already owns**.

`pi-quota` is a standalone project. It does not import, invoke or modify
shuvquota, and it never writes to a credential file.

| Surface | Command |
| --- | --- |
| Terminal | `piquota` · `piquota --json` · `piquota --status` |
| Pi TUI | `/quota` · `/usage` |
| Moshi Usages tab | `piquota moshi push` (or the `moshi watch` user service) |
| Moshi notifications | `piquota moshi takeover` + the `moshi-approvals.ts` extension |

## Hard guarantees

* `~/.pi/agent/auth.json` is opened with `flag: "r"`. Never written, synced or
  refreshed. Verified with a checksum before and after every run.
* No token, refresh token, API key, session cookie or `sessionKey` is printed,
  logged, cached, or sent anywhere. E-mail identities are redacted in every
  artifact.
* Antigravity's access token **may** be refreshed, but only in memory. Google
  does not rotate that refresh token, so Pi's stored copy stays valid. Claude and
  Codex are never refreshed, because they **do** rotate and persisting a rotated
  token would break Pi.
* The Claude Code store (`~/.claude/.credentials.json`) is opened read-only too, and
  its refresh token is never even read into memory, so nothing here can rotate a
  token the installed `claude` owns. `~/.claude.json` is read only for the account
  e-mail and display name; its project history is never touched.
* Browser cookie databases are copied to a private temp dir and opened
  read-only. This is only used to fetch the opencode.ai session cookie that Pi
  does not store.
* `/quota` never injects quota into the LLM context: the extension only calls
  `ui.setStatus`, `ui.setWidget` and `ui.notify`.
* Nothing is written outside these paths:

  | Path | What |
  | --- | --- |
  | `~/.cache/pi-quota/usage.json` | the report cache |
  | `~/.cache/pi-quota/refresh-state.json` | each family's own refresh clock |
  | `~/.cache/pi-quota/last-published.json`, `last-good.json`, `backoff.json` | sticky snapshots and throttle state |
  | `~/.local/state/pi-quota/moshi-usage.json` | the local Moshi-shaped artifact |
  | `~/.local/state/pi-quota/moshi-takeover.json` | only after `piquota moshi takeover` |
  | `~/.config/pi-quota/opencode-cookie` | only after `piquota auth opencode`, mode `600` |
  | `~/.pi/agent/extensions/*.ts` | only by `install.sh` |

  `~/.config/moshi/config.toml` is changed **only** through moshi-hook's own CLI
  (`moshi-hook set`), never by editing the file.

## Status, verified against the live APIs

| Provider | Source | Endpoint | Result |
| --- | --- | --- | --- |
| Claude | Claude Code CLI store, else `anthropic.access` | `GET api.anthropic.com/api/oauth/usage` | ✅ 5h + weekly + plan |
| Codex | `openai-codex.access` + `accountId` | `GET chatgpt.com/backend-api/wham/usage` | ✅ 5h + weekly + plan |
| Antigravity | `antigravity.access` + `projectId` | `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | ✅ Gemini + Claude/GPT buckets, **with in-memory refresh** |
| OpenCode Go | opencode.ai session cookie | `GET opencode.ai/workspace/<id>/go` | ✅ weekly + monthly, verified live |

Four findings worth recording, each of which cost a wrong hypothesis:

1. **Antigravity needs the CLI `User-Agent`.** Without
   `User-Agent: antigravity/cli/...` the backend answers
   `403 You do not have a valid license of this product` for a healthy token.
2. **Pi's `opencode-go` entry is an OpenCode Zen API key, not a Go session.** It
   validates (`/zen/v1/models` → 200, 70 models) but exposes no usage, and every
   `/api/*` path on opencode.ai returns 404: the Go windows only exist in the
   authenticated SSR page.
3. **Moshi validates the `agent` field against a closed union of six values**
   (`claude-code`, `codex`, `opencode`, `kimi`, `grok`, `antigravity`). A custom
   `"pi"` agent is rejected with HTTP 422, so the Pi provenance is carried by
   `accountLabel` (`"Codex (Pi)"`) and the card keeps Moshi's own logo.
4. **Both Claude OAuth stores answer the same endpoint.** Pi's own `anthropic`
   entry and the Claude Code CLI store return identical windows, which is what
   makes the second source a drop-in replacement rather than a separate feature.

### Claude has two sources

There are two ways to be signed in to Claude, and a user may have either or both:

| Source | Store | Why it exists |
| --- | --- | --- |
| Claude Code CLI | `~/.claude/.credentials.json` (honours `CLAUDE_CONFIG_DIR`) | What `npm:pi-claude-code-provider` drives. A subscription with usage credits disabled answers `400` on Pi's own entry for every request, and this is the source that still works. |
| Pi's own entry | `~/.pi/agent/auth.json` → `anthropic` | `/login anthropic` in Pi, without the plugin installed. |

**The Claude Code CLI wins when both are present.** The choice is a *preference, not
a fallback*: only the selected source is tried, so a broken preferred source is
reported rather than silently masked by the other one. Override it with
`PI_QUOTA_CLAUDE_SOURCE=pi` or `=claude-code`; `--explain` prints which one was used
and why.

The Claude Code store is opened read-only, and its refresh token is deliberately
**never carried into memory**: Anthropic rotates refresh tokens, and a rotation
performed behind the CLI's back would sign the installed `claude` out. Refresh, if
any, stays the CLI's business.

## Prerequisites & Installation

* **Node.js >= 20.0.0** (native `node:sqlite` and global `fetch` support; zero npm dependencies).
* **[Pi Coding Agent](https://github.com/earendil-works/pi)** (`pi`).
* **[Gentle AI](https://github.com/Gentleman-Programming/gentle-pi)** (`gentle-pi`).
* **[Moshi](https://getmoshi.app)** (`moshi-hook`) *(optional — only needed if syncing to the Moshi mobile app)*:
  - Install daemon & CLI: `curl -fsSL https://getmoshi.app/install | bash`
  - Pair your host: `moshi-hook pair`
  - Run daemon: `moshi-hook service install` or `moshi-hook serve`
  - *(Without Moshi the CLI, the TUI line and every report still work fully locally;
    only the phone cards and the approval mirror need it. `install.sh` skips the
    mirror when `moshi-hook` is absent.)*
* Platform support: Linux, WSL2, macOS. See [docs/OS-COMPATIBILITY.md](docs/OS-COMPATIBILITY.md) for OS-specific details.

### 1-Line Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/J3fp/piQuota/main/install.sh | bash
```

### Manual Install / Development

```bash
git clone https://github.com/J3fp/piQuota.git
cd piQuota
./install.sh              # --link for development, --uninstall to remove
```

No sudo. It validates Node, Pi and Gentle AI, reports which Claude source it found,
copies the project to `~/.local/share/pi-quota`, symlinks `~/.local/bin/piquota`,
installs both Pi extensions (the approval mirror only when `moshi-hook` is present),
and removes the previous generation's `shuvquota` shim so upstream `/usr/bin/shuvquota`
is reachable again.

## Commands

```bash
piquota                 # boxed panel: ring, bar, % left, "reset in 3h 12m"
piquota claude codex    # only these families
piquota --json          # normalized report
piquota --compact       # one line per provider
piquota --status        # single line with rings, for status bars
piquota --explain       # which stores and fields are read (names only)
piquota --clear-cache   # delete the cache and exit
piquota --no-color      # plain output
piquota --ttl 300       # cache TTL in seconds (default 60)
piquota --timeout 5000  # per-request timeout in ms (default 15000)
piquota --no-cache      # ignore the cache entirely
piquota --force         # ignore a still-fresh cache entry
piquota --no-refresh    # never refresh Antigravity's token in memory
piquota --version       # the version this binary reports

piquota auth status             # every credential source, including opencode.ai
piquota auth opencode           # open the login in Firefox and capture the session
piquota auth opencode --paste   # read the cookie from stdin instead
piquota auth opencode --no-browser
piquota auth opencode --wait 300

piquota moshi status            # pairing, publisher mode and usage-collection state
piquota moshi push              # publish once to the paired host, then exit
piquota moshi watch             # publish every 30s, refetch every 60s (Claude: 300s)
piquota moshi artifact          # write the local JSON artifact (--print for stdout)
piquota moshi service install|uninstall|status
piquota moshi takeover          # make these cards the only ones on the host
piquota moshi release           # hand publishing back to moshi-hook
```

Colours: green above 50% remaining, yellow 20–50%, red below 20%.

**Which window the ring shows:** always the **shortest** one (5h/session first,
then daily, weekly, monthly), because that is the limit you hit first. A weekly
window at 31% left is more consumed, but a 5h window at 97% is what answers "can
I keep working right now". Ties inside the same rank go to the tightest window,
so Antigravity's two 5h groups resolve to whichever is more consumed. The rule
lives in `selectPrimaryWindow()` (`src/model.js`), the CLI stamps
`primaryWindowId` into the report, and the Pi extension reads that field, so the
terminal and the TUI cannot disagree. The full panel still lists every window,
so nothing is hidden.

Inside Pi:

| Command | Effect |
| --- | --- |
| `/quota` | refresh, reveal the panel, notify a one-line summary |
| `/quota box` | pin the five-row box above the editor (the default surface) |
| `/quota line` | pin the compact line above the editor, in its own row |
| `/quota panel` | full boxed panel above the editor |
| `/quota hide` | hide the panel/line |
| `/quota status` / `nostatus` | enable/disable the footer status |
| `/quota refresh` | refresh only |
| `/quota json` | where the cached report lives |
| `/usage` | alias of `/quota` |

### The Pi surface

By default the extension pins the **five-row box above the editor**:

```
              ╭─ Quota ──────────────────╮
              │ Claude:  ○   0%   R:3h 12m │
              │ Codex:   ○   8%   R:2h 40m │
              │ Agy:     ○   4%      R:41m │
              │ Agy C/G: ? n/a  R:unknown │
              │ OP-Go:   ○   4%   R:1h 05m │
              ╰───────────────────────────╯
```

When gentle-pi's fullscreen sidebar is active, the same card is painted in its
right rail instead, under Status and TODO, and the above-editor box stays quiet so
the numbers are not shown twice. See [the rail slot](#the-gentle-pi-rail-slot).

* each name is painted with its **own brand colour** — Claude `#D97757`, Codex
  `#10A37F`, Antigravity `#4285F4`, OpenCode `#007AFF`;
* the numbers are **used**, not remaining, and the semaphore is both colour and
  shape (`○` plenty left → `◔` → `◕` → `●` nearly spent), so it still reads on a
  colourblind or mono terminal;
* **only active providers are shown:** if you only have Claude and Codex configured
  in Pi, only Claude and Codex appear in the line and on Moshi (no empty warning
  icons for providers you don't use);
* `NO_COLOR` / `TERM=dumb` drops the colours and keeps the glyphs;
* the window shown is the **shortest** one (5h first), and `/quota` expands every
  window with a used-fraction bar and the reset countdown.

Pi's theme only exposes a fixed palette, so brand colours are emitted as
truecolor ANSI. Widget string arrays are wrapped in `Text` components by Pi,
which are ANSI-aware, so the codes are measured correctly and `theme.fg()` keeps
working in the same strings.

### Why the footer is off by default

gentle-pi replaces the footer with its own shell bar (`setFooter`) and that bar
drops segments **from the end** when the line overflows:

```js
while (segments.length > 1 && visibleWidth(left) > width) segments.pop();
```

Extension statuses render last, so a footer status is the first thing discarded —
which is why a long status line appears and then vanishes once the bar fills with
cost, branch and usage data. The quota line therefore lives in its own row, where
nothing competes for it. `/quota status` still enables the footer variant for
anyone who wants it.

### The gentle-pi rail slot

gentle-pi paints its right rail from a **hardcoded allowlist**, so a part that
another extension registers is silently never drawn:

```ts
const sections = ["footer", "agents", "todo"].map((key) => { /* ... */ });
```

piQuota registers its card under `quota`, which that list does not include. There is
no injection point, so the card cannot appear in the rail on its own. The fix is one
anchored edit that appends the part:

```ts
const sections = ["footer", "agents", "todo", "quota"].map((key) => { /* ... */ });
```

`piquota gentle-pi` owns that edit:

* `piquota gentle-pi status` — report whether the rail renders the quota part;
* `piquota gentle-pi apply` — append the part (idempotent);
* `piquota gentle-pi revert` — remove the part and restore the original bytes.

Because a gentle-pi update replaces the package, the patch would otherwise vanish.
The extension therefore **validates the slot on every session start** and re-applies
it when it is gone, reporting the repair instead of doing it silently. `install.sh`
applies it at install time and reverts it on `--uninstall`.

Safety properties, all covered by `tests/rail-patch.test.mjs`:

* exactly one array literal is rewritten; every other byte of the file is untouched;
* an unrecognized shape is **refused**, never guessed at, because a wrong rewrite of
  another extension's layout would break the whole rail;
* the write is atomic, the pre-patch revision is kept as a one-time
  `.pi-quota-backup` next to the file, and the result is re-read after writing with a
  restore from that backup when it does not read back as patched;
* `PI_QUOTA_GENTLE_PI_DIR` points the lookup elsewhere, which is what keeps the test
  suite away from a real installation.

If gentle-pi is absent, or the slot cannot be applied, nothing breaks: the card stays
in the box above the editor. The rail only exists in fullscreen at 140 columns or
wider, so the suppression of that box is conditional on gentle-pi reporting its rail
as active — in regular mode or a narrow terminal the box is the only surface.

## Approvals on the phone

Session notifications (session started, task complete, session ended) already reach
the phone through moshi-hook's own generated Pi extension. **Approvals did not**, and
the reason is precise:

```
gentle-pi  --emits-->  pi-permission-system:permission-request  --X-->  nobody
```

`extensions/gentle-ai.ts` emits that event with
`{ requestId, state: waiting|approved|denied, toolName, message }`. Nothing consumes
it. moshi-hook's generated `moshi-hooks.ts` already contains the `PermissionRequest`
envelope builder — including the comment *"Pi owns the approval prompt and decision.
Moshi mirrors the waiting state"* — but never registers a handler that calls it, and
Pi has no `PermissionRequest` event of its own (its API exposes `ui_prompt_start` /
`ui_prompt_end`).

`extensions/moshi-approvals.ts` is that missing handler. It is a **separate file on
purpose**: `moshi-hooks.ts` is auto-generated by `moshi-hook install` and would
overwrite any patch made in place.

* `waiting` → `category: approval_required`, `phase: waitingForApproval`, with the
  request id as `actionId` so the daemon can match it.
* `approved` / `denied` → `PermissionResolved`, naming which way it went.
* The terminal target (tmux / zellij / herdr) travels with the envelope, which is what
  lets the daemon address the pane.

Verified without Pi: the tests run a **real Unix socket** and assert the bytes that
arrive, and the resolved socket path is checked against the one the daemon logs. This
covers gentle-pi's guarded-command confirm, the only approval source verified to emit
the event.

### Answering the card from the phone does not reliably work, and that is not fixable here

The card arrives, and the whole round trip works: the daemon opens a pending action
and the phone's answer comes back carrying the right `actionId`. What fails is the
daemon's own verification, in its own words:

```
tui bridge: pending-action.open sent   actionId=ca0f8118… source=pi
tui bridge: remote action executed     type=action.approve status=sent
tui bridge: remote action verification failed
  reason="approval fingerprint no longer present on screen"
```

Measured over eight attempts on a live session: **1 applied, 7 came back with
`approval fingerprint no longer present on screen`.** The daemon fingerprints the pane
when the request arrives and re-checks that the same screen is still there when the
answer does. Something on Pi's screen always moves in between.

Two causes were tested and **rejected**, and both are worth recording so nobody
repeats them:

| Hypothesis | Test | Result |
| --- | --- | --- |
| The quota line redraws the pane every 60 s and invalidates the fingerprint | `/quota hide`, then approve | failed again |
| The envelope is sent before Pi has drawn the prompt, so the daemon fingerprints an empty screen | hold the write 400 ms, then 2500 ms | failed both times |

The remaining explanation is the one nothing here can change: Pi's TUI animates while
the agent is blocked — a working indicator, at minimum — and the daemon compares exact
captures, so a match is luck. `moshi-hook` is closed source, exposes no setting to relax
the check, and offers no way to learn about a phone decision outside that bridge.

So the card is a **notification that Pi is waiting**, not a remote control, and its
subtitle says exactly that. Answer in the terminal. For these measurements the daemon
ran with verbose logging, which reported `approvals.answer`, `terminal.prompt` and
`terminal.keys` as supported capabilities — the limitation is the verification, not the
transport.

## Moshi: real cards in the Usages tab

`piquota moshi push` posts to **your own paired host channel**:

```
POST {base}/hosts/{hostId}/usage
Authorization: Bearer secret_<host-secret>
{"snapshots":[{accountId,accountLabel,agent,hostName,capturedAt,
               windows:[{label,usedPercentage,resetsAt}]}]}
```

`accountLabel` is `"Claude (Pi)"`, `"Codex (Pi)"`, `"Antigravity (Pi)"`,
`"OpenCode Go (Pi)"`. Only percentages, window labels, reset timestamps and plan
names are sent — never a credential or an e-mail address.

The publisher respects moshi-hook's own `usage_collection` setting: if you turn
collection off, `moshi watch` pauses instead of pushing behind your back. The one
exception is an explicit takeover, which is recorded rather than inferred — see
[Taking over from moshi-hook's own poller](docs/MOSHI.md#taking-over-from-moshi-hooks-own-poller).

### Each provider refreshes on its own clock

One shared clock was making the cards look stale: the watcher refetched everything
every 300 s and re-pushed the same numbers five times in between, so a value could be
five minutes old while looking freshly published.

The slow clock exists for exactly one provider. Anthropic's usage endpoint answers
`429` when it is polled every minute; Codex, Antigravity and OpenCode Go are happy at
a minute. So:

| | Clock |
| --- | --- |
| Claude | **300 s** (`--claude-ttl`) |
| Codex, Antigravity, OpenCode Go | **60 s** (`--fetch-ttl`) |
| Push to Moshi | **30 s** (`--interval`) |

`src/refresh.js` keeps a timestamp per family, requests only what is past its own
clock, and merges the result back into the one canonical report every other surface
reads. **Anthropic sees the same number of requests as before** — only the other
three get fresher. `--claude-ttl` is there to tune it if your account tolerates more.

A short clock is safe because a throttle is already handled twice over: `backoff.js`
pauses that family for at least five minutes after a `429`, and `src/moshi/sticky.js`
keeps the card showing its last real reading instead of going blank. A *permanent*
failure (expired sign-in, missing credential) is never masked.

`piquota moshi service install` runs `moshi watch` as a systemd **user** service
(`pi-quota-moshi.service`). Full protocol notes, including how the endpoint and
schema were recovered: [docs/MOSHI.md](docs/MOSHI.md).

## Layout

```
src/auth/pi-auth.js            read-only auth.json reader, WSL + Linux, deduplicated
src/auth/claude-code-auth.js   read-only Claude Code store; never carries its refresh token
src/auth/jwt.js                Codex JWT payload reader (claim keys contain dots)
src/browser/cookies.js         read-only Firefox/Chromium cookie access via a temp copy
src/browser/history.js         workspace ids recovered from a copied places.sqlite
src/opencode/session.js        cookie + workspace resolution, dashboard fetch
src/opencode/dashboard.js      three-strategy parser for the Go plan page
src/providers/*.js             one file per provider; each degrades instead of throwing
src/providers/antigravity-oauth.js  in-memory refresh with Google's public client
src/providers/backoff.js       per-family throttle state
src/moshi/client.js            paired-host publisher
src/moshi/artifact.js          local Moshi-shaped artifact, identities redacted
src/moshi/sticky.js            last published / last good snapshots
src/moshi/settings.js          moshi-hook's usage_collection, and the takeover override
src/moshi/takeover.js          the publisher record, and moshi-hook's own `set` call
src/moshi/daemon.js            daemon restart, and proof of the value it loaded
src/engine.js                  collectQuota() -> one normalized report
src/model.js                   window normalization, percent and reset parsing
src/render/{theme,panel}.js    colors, thresholds, rings, bars, boxed panel
src/cache.js                   report cache at ~/.cache/pi-quota/usage.json
src/refresh.js                 per-family refresh clocks, and the merge back into one report
src/cli/args.js                argument parsing, and the flag/positional split
src/exec.js                    the one place that spawns a foreign binary
src/http.js                    fetch wrapper: timeouts, JSON, redaction
bin/piquota.js                 the only CLI
extensions/quota-panel.ts      Pi TUI line and /quota
extensions/moshi-approvals.ts  mirrors Pi's approval prompts to the phone
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `no <family> credential in the Pi store` | Not logged in to Pi for that provider. `/login <provider>` in Pi. |
| `no claude credential in the Pi store or from the Claude Code CLI` | Neither Claude source is configured. `/login anthropic` in Pi, or install Claude Code and run `claude` once. |
| `Claude Code CLI has no readable credentials; looked for …` | The store is missing, empty or corrupt. `piquota --explain` prints every path that was tried. |
| `Claude Code token expired or rejected; run \`claude\` once` | Claude Code's own access token lapsed. Run any `claude` command; piQuota never refreshes it. |
| Claude reports `plan pro` but the window looks wrong | The store is chosen by preference, not by success. `PI_QUOTA_CLAUDE_SOURCE=pi piquota` forces the other source. |
| `rate limited (HTTP 429); retry in Ns` | The vendor throttled the usage endpoint. Wait, or raise `--ttl`. |
| `Antigravity token rejected` | Refresh failed; `/login antigravity` in Pi. `--no-refresh` disables the attempt. |
| `no "auth" cookie for opencode.ai in N readable store(s)` | Run `piquota auth opencode`, or paste the cookie. |
| `only encrypted Chromium stores found` | Log in with Firefox; Chrome on Windows uses DPAPI. |
| `moshi push failed: ... rejected the host secret` | `moshi-hook pair` again. |
| Duplicate Claude or Codex cards on the phone | moshi-hook's own poller is also publishing. `piquota moshi takeover` stops it. |
| `could not change moshi-hook's setting` | `moshi-hook` is not on `PATH`. The takeover prints the exact command to run by hand. |
| `the daemon still reports usage-collection on` | A restart did not take. `systemctl --user restart moshi-hook.service` and check `piquota moshi status`. |
| `unknown flag: --x` | The flag is a typo or was removed. `piquota --help` lists every flag. |
| `moshi-hook is not paired` | Only `moshi artifact` works until you pair. |
| `unknown argument` | `piquota --help` lists every flag. |

## Tests

```bash
node --test tests/*.test.mjs     # 242 tests, fake tokens only, no network
```

Modules covered: `auth.json` parsing and de-duplication, the Claude Code store
(including that the refresh token never leaves it and that reading leaves the file
byte-identical), Claude source precedence, the four providers (including the two
Antigravity failures and the OpenCode degradation), the dashboard parser's three
strategies, the Firefox cookie reader against a synthetic SQLite database, the
Antigravity refresh (in-memory only), the Moshi takeover and daemon-restart
helpers, the Moshi payload/redaction/transport, the renderers, the Pi
extension contract, the approval mirror (through a real Unix socket), the per-family
refresh clocks, argument parsing including the two silent defects it once hid, and the
structure of these documents themselves (tables, fences, links, anchors).

## Acknowledgments & Prior Art

* **[shuvquota](https://github.com/shuv1337/shuvquota)** by [@shuv1337](https://github.com/shuv1337):
  Huge credit to `shuvquota` for pioneering multi-provider terminal quota monitoring across AI services. Its approach to rate-limit endpoints, dashboard parsing patterns for OpenCode Go, and terminal quota concepts served as inspiration for this project.

  `piQuota` was built as a standalone, strictly read-only implementation designed specifically around [Pi Coding Agent](https://github.com/earendil-works/pi) credentials (`~/.pi/agent/auth.json`), Gentle AI orchestration, and direct Moshi mobile synchronization.
