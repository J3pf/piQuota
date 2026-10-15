# OS Compatibility & Platform Guide

`pi-quota` runs on any platform supported by Node.js 20+. Because it interacts with local credential stores, browser cookie databases, and background services, here is exactly how behavior maps across operating systems.

---

## Quick Comparison Matrix

| Feature | Linux (native) | WSL2 (Ubuntu / Debian) | macOS (Darwin) | Windows (PowerShell) |
|---|---|---|---|---|
| **CLI (`piquota`)** | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **Pi TUI Extension** | ✅ Full | ✅ Full | ✅ Full | ✅ Full |
| **OpenCode via Firefox** | `~/.mozilla/firefox/` | Auto-discovers Windows Firefox (`/mnt/c/Users/...`) | `~/Library/Application Support/Firefox/` | `%APPDATA%\Mozilla\Firefox\` |
| **OpenCode via Chromium** | Plaintext SQLite / Keyring | ⚠️ Encrypted with Windows DPAPI (use Firefox or `--paste`) | ⚠️ Encrypted with macOS Keychain (use Firefox or `--paste`) | ⚠️ Encrypted with DPAPI (use Firefox or `--paste`) |
| **Pi `auth.json` lookup** | `~/.pi/agent/auth.json` | `~/.pi/agent/auth.json` + `/mnt/c/Users/...` (deduplicated) | `~/.pi/agent/auth.json` | `%USERPROFILE%\.pi\agent\auth.json` |
| **Claude Code store** | `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`) | same, plus `/mnt/c/Users/<profile>/.claude/.credentials.json` | `~/.claude/.credentials.json` | `%USERPROFILE%\.claude\.credentials.json` |

---

## 1. WSL2 (Windows Subsystem for Linux)

This is the primary tested environment.

* **OpenCode Go Cookie Discovery:**
  * Windows Firefox profiles are located at `/mnt/c/Users/<user>/AppData/Roaming/Mozilla/Firefox/Profiles/`. Firefox stores cookies in unencrypted SQLite (`cookies.sqlite`), allowing `piquota` to safely read the session in read-only mode from WSL.
  * Windows Chrome, Edge, and Brave store cookies in encrypted format using the Windows DPAPI (Data Protection API), which is tied to Windows user credentials and cannot be decrypted from Linux/WSL.
  * **Recommendation:** Log in with Firefox in Windows (`piquota auth opencode`), or use manual pasting (`piquota auth opencode --paste`).
* **Pi Credential Deduplication:**
  * If Pi credentials exist both in WSL (`~/.pi/agent/auth.json`) and Windows (`/mnt/c/Users/<user>/.pi/agent/auth.json`), `piquota` loads both and deduplicates identical accounts automatically.

---

## 2. Native Linux (Ubuntu, Debian, Fedora, Arch)

* **Prerequisites:**
  * Node.js >= 20.0.0
  * Pi Coding Agent (`pi`) and Gentle AI (`npm:gentle-pi`) installed.
* **OpenCode Go Cookie Discovery:**
  * Reads `~/.mozilla/firefox/` directly.
  * Chromium on Linux uses either plaintext SQLite or libsecret/kwallet depending on the desktop environment.

---

## 3. macOS (Apple Silicon / Intel)

* **Prerequisites:**
  * Node.js >= 20.0.0 (`brew install node`)
  * Pi Coding Agent (`pi`) and Gentle AI (`npm:gentle-pi`) installed.
* **OpenCode Go Cookie Discovery:**
  * Reads `~/Library/Application Support/Firefox/Profiles/`.
  * Chrome/Brave on macOS encrypts cookies using the macOS Keychain (Safe Storage), which triggers OS-level security prompts. Use Firefox for automatic extraction, or `piquota auth opencode --paste`.

---

## 4. Native Windows (PowerShell / Command Prompt)

* **Prerequisites:**
  * Node.js >= 20.0.0 (from nodejs.org)
  * Git for Windows.
* **Paths:**
  * Pi store: `%USERPROFILE%\.pi\agent\auth.json`
  * Firefox profiles: `%APPDATA%\Mozilla\Firefox\Profiles\`
* **Running the CLI:**
  ```powershell
  node bin\piquota.js
  node bin\piquota.js --status
  node bin\piquota.js --json
  ```

---

## Claude Code as a second Claude source

`npm:pi-claude-code-provider` never writes to Pi's auth store: it drives the
installed `claude` executable, whose subscription token lives in Claude Code's own
file. piQuota reads that file read-only and prefers it over Pi's own `anthropic`
entry, which is what a user needs when Pi's entry answers `400` without usage
credits.

| Platform | Credential path | Notes |
| --- | --- | --- |
| Native Linux | `~/.claude/.credentials.json` | `CLAUDE_CONFIG_DIR` relocates it, and is honoured. |
| WSL2 | `~/.claude/.credentials.json`, then `/mnt/c/Users/<profile>/.claude/.credentials.json` | The Linux-side store wins when both exist; discovery never spawns `cmd.exe`. |
| macOS | `~/.claude/.credentials.json` | Same file, same format. |
| Windows | `%USERPROFILE%\.claude\.credentials.json` | Run `piquota` from Windows only if Node >= 20 is on `PATH`. |

Set `PI_QUOTA_CLAUDE_CODE_CREDENTIALS=/path/to/.credentials.json` to point at a
specific file, or `PI_QUOTA_CLAUDE_SOURCE=pi` to ignore Claude Code entirely.

> **The refresh token in that file is never read into memory.** Anthropic rotates
> refresh tokens, so a rotation performed behind the CLI's back would sign the
> installed `claude` out. It is Claude Code's token to refresh.

## Troubleshooting by Platform

| Issue | Platform | Solution |
|---|---|---|
| `Chromium cookies encrypted with DPAPI` | WSL / Windows | Log in to opencode.ai with Firefox, or run `piquota auth opencode --paste` |
| `systemctl: command not found` | macOS / WSL1 | On macOS use launchd or tmux. On WSL ensure WSL2 systemd is enabled (`[boot] systemd=true` in `/etc/wsl.conf`) |
| `Browser cookies locked` | Any | `piquota` copies `cookies.sqlite` to `/tmp` before querying, so open browsers do not cause database locks |
