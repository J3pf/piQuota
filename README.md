# pi-quota

One source of truth for quota: **the credentials Pi already owns**.

`pi-quota` is a standalone project. It does not import, invoke or modify
shuvquota, and it never writes to a credential file.

> [!TIP]
> **Working with AI Agents?** See [AGENTS.md](AGENTS.md) for architectural boundaries, test runner commands, and hard invariants for AI coding agents.

| Surface | Command |
| --- | --- |
| Terminal | `piquota` · `piquota --json` · `piquota --status` · `piquota --compact` |
| Pi TUI | `/quota` · `/usage` |
| External / `rp-host` / automation | `piquota --json` (structured JSON feed with `primaryWindowId` and countdowns) |
| Omarchy Bar Panel | `piquota omarchy` (or systemd user timer via `--omarchy-timer`) |

> [!NOTE]
> **Moshi Integration Removed in v0.11.0**: Previous versions included an integration with the Moshi mobile app and `moshi-hook`. Starting with v0.11.0, Moshi-specific commands and approval mirroring are removed in favor of direct local integrations such as `piquota --json` for `rp-host` / Rp-app and `piquota omarchy` for Omarchy.

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
  | `~/.config/pi-quota/opencode-cookie` | only after `piquota auth opencode`, mode `600` |
  | `~/.pi/agent/extensions/*.ts` | only by `install.sh` |

## Status, verified against the live APIs

| Provider | Source | Endpoint | Result |
| --- | --- | --- | --- |
| Claude | Claude Code CLI store, else `anthropic.access` | `GET api.anthropic.com/api/oauth/usage` | ✅ 5h + weekly + plan |
| Codex | `openai-codex.access` + `accountId` | `GET chatgpt.com/backend-api/wham/usage` | ✅ 5h + weekly + plan |
| Antigravity | `antigravity.access` + `projectId` | `POST cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | ✅ Gemini + Claude/GPT buckets, **with in-memory refresh** |
| OpenCode Go | opencode.ai session cookie | `GET opencode.ai/workspace/<id>/go` | ✅ weekly + monthly, verified live |
| GitHub Actions (opt-in) | Authenticated `gh` CLI | `gh api /organizations/<org>/settings/billing/usage/summary?product=Actions` | ✅ org-wide monthly Linux minutes, plan-derived allowance |

Four findings worth recording, each of which cost a wrong hypothesis:

1. **Antigravity needs the CLI `User-Agent`.** Without
   `User-Agent: antigravity/cli/...` the backend answers
   `403 You do not have a valid license of this product` for a healthy token.
2. **Pi's `opencode-go` entry is an OpenCode Zen API key, not a Go session.** It
   validates (`/zen/v1/models` → 200, 70 models) but exposes no usage, and every
   `/api/*` path on opencode.ai returns 404: the Go windows only exist in the
   authenticated SSR page.
3. **`primaryWindowId` identifies the most urgent window.** The CLI computes the
   shortest, most pressing window (e.g. 5h session before weekly) so downstream UI
   consumers like `rp-host` and the Pi TUI render priority pills without reimplementing
   window precedence.
4. **Both Claude OAuth stores answer the same endpoint.** Pi's own `anthropic`
   entry and the Claude Code CLI store return identical windows, which is what
   makes the second source a drop-in replacement rather than a separate feature.

### Claude has two sources

There are two ways to be signed in to Claude, and a user may have either or both:

| Source | Store | Why it exists |
| --- | --- | --- |
| Claude Code CLI | `~/.claude/.credentials.json` (honours `CLAUDE_CONFIG_DIR`); on macOS, when that file is absent, the `Claude Code-credentials` login Keychain item (read-only, via `security find-generic-password`; macOS may ask once to allow access) | What `npm:pi-claude-code-provider` drives. A subscription with usage credits disabled answers `400` on Pi's own entry for every request, and this is the source that still works. |
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

### GitHub Actions credential source

GitHub Actions does not use a Pi-store credential. Quota requests are delegated to
GitHub CLI, which owns authentication; piQuota never reads the token value.

| Source | Credential | Why it exists |
|---|---|---|
| GitHub CLI | Its authenticated session, or `GH_TOKEN` / `GITHUB_TOKEN` passed to `gh` | Reads organization billing usage without putting the token in piQuota's report or cache. |

Enable the family with `PI_QUOTA_GITHUB_ACTIONS=1` or select it explicitly with
`piquota github-actions` (`piquota gh` and `piquota actions` are aliases). Use
`gh auth login` if the CLI is not authenticated; organization billing access and
the `read:org`, `repo`, and `workflow` scopes may be required.

| Variable | Default | Effect |
|---|---|---|
| `PI_QUOTA_GITHUB_ACTIONS` | off | Enables the family for default runs; truthy values are `1`, `true`, `yes`, and `on`. |
| `PI_QUOTA_GITHUB_ORG` | `KoralisSoft` | Organization queried for its plan and usage. |
| `PI_QUOTA_GITHUB_ACTIONS_MINUTES` | plan-derived | Positive integer monthly allowance override; unsupported plans require this setting. |
| `PI_QUOTA_GITHUB_ACTIONS_REPOS` | empty | Optional comma-separated repo names used only to filter attribution; quota remains org-wide. |

## Prerequisites & Installation

* **Node.js >= 20.0.0** (native `node:sqlite` and global `fetch` support; zero npm dependencies).
* **[Pi Coding Agent](https://github.com/earendil-works/pi)** (`pi`).
* **[Gentle AI](https://github.com/Gentleman-Programming/gentle-pi)** (`gentle-pi`).
* Platform support: Linux, WSL2, macOS. See [docs/OS-COMPATIBILITY.md](docs/OS-COMPATIBILITY.md) for OS-specific details.

### 1-Line Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/J3fp/piQuota/master/install.sh | bash
```

### Install the Pi extension from npm

```bash
pi install npm:@j3pf/piquota
```

Loads both Pi extensions straight from the package. The quota panel resolves
the CLI from inside the package, so nothing else is required to see quotas in
the TUI.

| Capability | `pi install npm:` | `install.sh` |
| --- | --- | --- |
| TUI panel, sidebar and `/quota` | yes | yes |
| Omarchy bar records | yes, written on every refresh | yes |
| `piquota` on your `PATH` for terminal use | no | yes, symlinked |
| Omarchy sync while Pi is closed | no | yes, with `--omarchy-timer` |

If you live inside Pi and use Omarchy, the npm route covers it: the extension
runs `piquota omarchy` on every quota refresh, so the bar fills without any
setup. Choose `install.sh` when you want the CLI in a terminal, or background
sync while Pi is not running.

### Manual Install / Development

```bash
git clone https://github.com/J3fp/piQuota.git
cd piQuota
./install.sh              # --link for development, --uninstall to remove
```

No sudo. It validates Node, Pi and Gentle AI, reports which Claude source it found,
copies the project to `~/.local/share/pi-quota`, symlinks `~/.local/bin/piquota`,
installs the Pi TUI extension,
and removes the previous generation's `shuvquota` shim so upstream `/usr/bin/shuvquota`
is reachable again.

## Commands

```bash
piquota                 # boxed panel: ring, bar, % left, "reset in 3h 12m"
piquota claude codex    # only these families
piquota github-actions  # GitHub Actions minutes (explicit opt-in; aliases: gh, actions)
piquota --json          # normalized report (for rp-host, scripts, and automations)
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

piquota omarchy                 # write pi-*.json records for Omarchy's Agents panel
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

## JSON feed & rp-host integration (`piquota --json`)

`piquota --json` provides a structured, machine-readable feed of all configured
provider quotas. It is designed for consumption by local status bars, dynamic
islands, background pollers, and client applications such as `rp-host` (from the
Rp suite) without external network daemons or closed-source intermediaries:

* **Predictable exit status**: exits `0` if at least one configured provider
  answered successfully, or `1` if all providers failed or are unconfigured.
* **`primaryWindowId`**: the CLI pre-calculates the most urgent quota window
  (e.g., short 5h session window over weekly or monthly allowances) so consumer
  pills or widgets do not have to implement provider-specific priority hierarchies.
* **Percentages and Countdown**: `usedPercent` and `remainingPercent` report
  percentages (0..100); `resetsInSec` provides the exact integer seconds until
  reset, immune to local clock skew.
* **`notConfigured` vs `ok`**: unconfigured providers report `notConfigured: true`,
  allowing consumers to cleanly omit them without displaying false-positive
  error indicators.

```json
{
  "engine": "pi-quota",
  "schemaVersion": 1,
  "readOnly": true,
  "generatedAt": "2026-10-15T05:35:21.210Z",
  "sources": ["/home/user/.pi/agent/auth.json"],
  "warnings": [],
  "providers": [
    {
      "family": "codex",
      "label": "Codex (Pi)",
      "account": "user@example.com",
      "plan": "plus",
      "source": "/home/user/.pi/agent/auth.json",
      "sourceKind": "pi",
      "expiresInMin": 12650,
      "ok": true,
      "notConfigured": false,
      "error": null,
      "updatedAt": "2026-10-15T05:35:21.210Z",
      "primaryWindowId": "5h",
      "windows": [
        {
          "id": "5h",
          "label": "5h window",
          "usedPercent": 14.5,
          "remainingPercent": 85.5,
          "resetsAt": "2026-10-15T10:35:24.000Z",
          "resetsInSec": 18003,
          "windowSeconds": 18000,
          "note": null
        }
      ]
    }
  ]
}
```

### Each provider refreshes on its own clock

Anthropic's usage endpoint answers `429` when polled every minute; Codex,
Antigravity and OpenCode Go tolerate 60 s intervals. To prevent cards from looking
stale without triggering rate limits:

| Family | Clock |
| --- | --- |
| Claude | **300 s** (`--claude-ttl`) |
| Codex, Antigravity, OpenCode Go | **60 s** (`--fetch-ttl`) |

`src/refresh.js` keeps a timestamp per family, requests only what is past its own
clock, and merges the result back into the canonical report. `src/sticky.js`
keeps the last healthy snapshot during transient upstream 429 throttles so the
user never loses visibility. Permanent failures (expired sign-in, missing
credential) are never masked.

## Omarchy integration

Omarchy 4.0.4's **Agents** bar panel draws every `*.json` record in
`${XDG_STATE_HOME:-~/.local/state}/omarchy/agents/usage/`, whoever wrote it.
`piquota omarchy` (opt-in, one shot) writes one record per provider piQuota can
read, so Claude, Codex, Antigravity and OpenCode Go all get a tab:

```bash
piquota omarchy                  # write pi-claude.json, pi-codex.json, ... once
./install.sh --omarchy-timer     # also run it every 5 minutes (systemd user timer)
```

- Records are named `pi-<family>.json`, so they never overwrite Omarchy's own
  `claude.json` / `codex.json`. They hold plan names, used percentages, window
  labels and reset times only; no tokens, accounts or e-mail addresses.
- A provider with a failing sign-in shows a status and a help line instead of
  limits. A provider that is not configured gets no record, and a stale
  `pi-*.json` is removed on the next run.
- Omarchy's native collector already tracks Claude with richer local statistics, so
  `piquota omarchy` automatically skips `claude` and cleans up duplicate `pi-claude.json`
  files when `claude.json` exists in the usage directory (override with `PI_QUOTA_OMARCHY_SKIP`).
- `PI_QUOTA_OMARCHY_DIR` overrides the output directory. `./install.sh --uninstall`
  removes the timer and the `pi-*.json` records.

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
src/providers/github-actions.js  plan-derived org Actions minutes via authenticated gh CLI
src/providers/antigravity-oauth.js  in-memory refresh with Google's public client
src/providers/backoff.js       per-family throttle state
src/sticky.js                  last published / last good snapshots and throttle recovery
src/engine.js                  collectQuota() -> one normalized report
src/model.js                   window normalization, percent and reset parsing
src/render/{theme,panel}.js    colors, thresholds, rings, bars, boxed panel
src/cache.js                   report cache at ~/.cache/pi-quota/usage.json
src/omarchy/record.js          pure mapping from the report to Omarchy usage records
src/omarchy/publish.js         atomic writer for pi-*.json, and stale-record cleanup
src/refresh.js                 per-family refresh clocks, and the merge back into one report
src/cli/args.js                argument parsing, and the flag/positional split
src/exec.js                    the one place that spawns gh CLI binary
src/http.js                    fetch wrapper: timeouts, JSON, redaction
contrib/systemd/               user service and timer behind `install.sh --omarchy-timer`
bin/piquota.js                 the only CLI
extensions/quota-panel.ts      Pi TUI line and /quota
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
| `unknown flag: --x` | The flag is a typo or was removed. `piquota --help` lists every flag. |
| `unknown argument` | `piquota --help` lists every flag. |

## Tests

```bash
node --test tests/*.test.mjs     # 247 tests, fake tokens only, no network
```

Modules covered: `auth.json` parsing and de-duplication, the Claude Code store
(including that the refresh token never leaves it and that reading leaves the file
byte-identical), Claude source precedence, the five providers (including GitHub
Actions plan resolution, opt-in gating and degradation, the two Antigravity
failures and the OpenCode degradation), the dashboard parser's three
strategies, the Firefox cookie reader against a synthetic SQLite database, the
Antigravity refresh (in-memory only), sticky and last-good snapshots resilience,
the Omarchy record mapping and atomic writer, the renderers, the Pi
extension contract, the per-family refresh clocks, argument parsing, and the
structure of these documents themselves (tables, fences, links, anchors).

## Acknowledgments & Prior Art

* **[shuvquota](https://github.com/shuv1337/shuvquota)** by [@shuv1337](https://github.com/shuv1337):
  Huge credit to `shuvquota` for pioneering multi-provider terminal quota monitoring across AI services. Its approach to rate-limit endpoints, dashboard parsing patterns for OpenCode Go, and terminal quota concepts served as inspiration for this project.

  `piQuota` was built as a standalone, strictly read-only implementation designed specifically around [Pi Coding Agent](https://github.com/earendil-works/pi) credentials (`~/.pi/agent/auth.json`), Gentle AI orchestration, and zero-dependency JSON and desktop integrations.
