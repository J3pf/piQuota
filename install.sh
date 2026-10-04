#!/usr/bin/env bash
#
# install.sh — install pi-quota into user space.
#
# No sudo required. Standalone project: does not modify, import or invoke
# shuvquota, and never writes to any credential file.
#
# What it does:
#   1. validates prerequisites: Node.js >= 20, Pi Coding Agent, Gentle AI
#   2. detects operating system and platform nuances
#   3. copies src/, bin/ and package.json to ~/.local/share/pi-quota
#   4. symlinks ~/.local/bin/piquota
#   5. installs extensions/*.ts into ~/.pi/agent/extensions
#   6. cleans up obsolete shims if upgrading from previous versions
#   7. with --omarchy-timer, installs a systemd user timer that runs
#      `piquota omarchy` every 5 minutes (opt-in)

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" && pwd 2>/dev/null || pwd)"

# Detect if running from a pipe/curl (no local repo files present)
if [[ ! -f "${HERE:-}/package.json" ]]; then
  echo "Downloading pi-quota from GitHub..."
  TMP_DIR="$(mktemp -d /tmp/pi-quota-install-XXXXXX)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 https://github.com/J3fp/piQuota.git "$TMP_DIR" >/dev/null 2>&1
  else
    curl -fsSL https://github.com/J3fp/piQuota/archive/refs/heads/master.tar.gz | tar -xz -C "$TMP_DIR" --strip-components=1
  fi
  exec bash "$TMP_DIR/install.sh" "$@"
fi

PREFIX="${PI_QUOTA_PREFIX:-$HOME/.local/share/pi-quota}"
BIN_DIR="${PI_QUOTA_BIN_DIR:-$HOME/.local/bin}"
EXT_DIR="${PI_QUOTA_EXT_DIR:-$HOME/.pi/agent/extensions}"
MODE="copy"
OMARCHY_TIMER=false
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

for arg in "$@"; do
  case "$arg" in
    --link) MODE="link" ;;
    --copy) MODE="copy" ;;
    --uninstall) MODE="uninstall" ;;
    --omarchy-timer) OMARCHY_TIMER=true ;;
    -h|--help)
      cat <<'USAGE'
Usage: ./install.sh [--copy|--link|--uninstall] [--omarchy-timer]

  --copy       Copy the project into ~/.local/share/pi-quota (default)
  --link       Symlink the project instead, for development
  --uninstall  Remove the installed tree, the piquota shim, the Pi extension and the
               Omarchy timer (its pi-*.json records are removed too)
  --omarchy-timer
               Also install and enable a systemd user timer that runs `piquota omarchy`
               every 5 minutes, so Omarchy's Agents panel shows every piQuota provider

Environment overrides: PI_QUOTA_PREFIX, PI_QUOTA_BIN_DIR, PI_QUOTA_EXT_DIR
USAGE
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

log()  { printf '  %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*"; exit 1; }

# --- Uninstallation ---
if [[ "$MODE" == "uninstall" ]]; then
  echo "Uninstalling pi-quota..."
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now pi-quota-moshi.service >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/pi-quota-moshi.service"
    systemctl --user disable --now piquota-omarchy.timer >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/piquota-omarchy.timer" "$UNIT_DIR/piquota-omarchy.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  # Only the pi-*.json records piQuota wrote; Omarchy's own records stay.
  OMARCHY_DIR="${PI_QUOTA_OMARCHY_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agents/usage}"
  rm -f "$OMARCHY_DIR"/pi-*.json
  rm -f "$BIN_DIR/piquota" "$BIN_DIR/shuvquota"
  rm -f "$EXT_DIR/quota-panel.ts" "$EXT_DIR/moshi-approvals.ts"
  # The rail slot only exists for the extension that reads it, so leaving it behind
  # would keep a patched third-party package with no consumer.
  if [[ -f "$PREFIX/src/gentle-pi/rail-patch.js" ]]; then
    if ! node "$PREFIX/src/gentle-pi/rail-patch.js" --revert 2>&1 | sed 's/^/  /'; then
      warn "the gentle-pi rail slot could not be reverted; run: piquota gentle-pi revert"
    fi
  fi
  rm -rf "$PREFIX"
  ok "removed the tree, the shims, the Pi extension and background services"
  warn "credentials and settings were left untouched"
  exit 0
fi

echo "=========================================="
echo "Installing pi-quota ($MODE mode)"
echo "=========================================="

# --- 1. Validate Node.js version ---
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Node.js >= 20.0.0 is required."
fi

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node.js v$NODE_VERSION found. Node.js >= 20.0.0 is required (native node:sqlite & fetch support)."
fi
ok "Node.js v$NODE_VERSION (>= 20.0.0)"

# --- 2. Validate Pi Coding Agent ---
PI_FOUND=false
if command -v pi >/dev/null 2>&1; then
  PI_VERSION="$(pi --version 2>/dev/null || echo "detected")"
  ok "Pi Coding Agent found: $PI_VERSION ($(command -v pi))"
  PI_FOUND=true
elif [[ -d "$HOME/.pi/agent" ]]; then
  ok "Pi home directory found at $HOME/.pi/agent"
  PI_FOUND=true
else
  warn "Pi Coding Agent not found on PATH or at ~/.pi/agent."
  warn "Install Pi Coding Agent first: https://github.com/earendil-works/pi"
fi

# --- 3. Validate Gentle AI harness ---
GENTLE_FOUND=false
if command -v gentle-ai >/dev/null 2>&1; then
  GENTLE_VERSION="$(gentle-ai --version 2>/dev/null || echo "detected")"
  ok "Gentle AI harness found: $GENTLE_VERSION ($(command -v gentle-ai))"
  GENTLE_FOUND=true
elif [[ -f "$HOME/.pi/agent/settings.json" ]] && grep -q "gentle-pi" "$HOME/.pi/agent/settings.json" 2>/dev/null; then
  ok "Gentle AI (gentle-pi package) configured in ~/.pi/agent/settings.json"
  GENTLE_FOUND=true
elif [[ -d "$HOME/.pi/agent/gentle-ai" || -d "$HOME/.pi/agent/npm/node_modules/gentle-pi" ]]; then
  ok "Gentle AI harness directory found in ~/.pi/agent/"
  GENTLE_FOUND=true
fi

if [[ "$GENTLE_FOUND" != "true" ]]; then
  warn "Gentle AI (gentle-pi) was not detected in your Pi setup."
  warn "To install Gentle AI harness, run:"
  warn "  pi install npm:gentle-pi"
  warn "or see: https://github.com/Gentleman-Programming/gentle-pi"
fi

# --- 4. Detect Platform & OS Nuances ---
OS_TYPE="$(uname -s)"
case "$OS_TYPE" in
  Linux*)
    if grep -qi "microsoft" /proc/version 2>/dev/null; then
      ok "Platform: WSL2 (Windows Subsystem for Linux)"
      log "WSL notice: Windows Firefox cookies are auto-discovered at /mnt/c/Users/..."
      log "            Windows Chrome/Edge use DPAPI encryption; use Firefox for OpenCode Go."
    else
      ok "Platform: Native Linux"
      log "Linux notice: systemd user service available for background Moshi sync."
    fi
    ;;
  Darwin*)
    ok "Platform: macOS"
    log "macOS notice: Firefox cookies at ~/Library/Application Support/Firefox/"
    log "              Background sync uses launchd or tmux (systemd not used)."
    ;;
  MINGW*|MSYS*|CYGWIN*)
    ok "Platform: Windows (POSIX shell)"
    ;;
  *)
    log "Platform: $OS_TYPE"
    ;;
esac

echo
echo "--- Installing Files ---"
mkdir -p "$BIN_DIR" "$EXT_DIR"

if [[ "$MODE" == "link" ]]; then
  rm -rf "$PREFIX"
  mkdir -p "$(dirname "$PREFIX")"
  ln -sfn "$HERE" "$PREFIX"
  log "linked $PREFIX -> $HERE"
else
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"
  cp -R "$HERE/src" "$HERE/bin" "$PREFIX/"
  cp "$HERE/package.json" "$HERE/LICENSE" "$PREFIX/"
  log "copied project to $PREFIX"
fi

chmod +x "$PREFIX/bin/piquota.js" 2>/dev/null || true

ln -sfn "$PREFIX/bin/piquota.js" "$BIN_DIR/piquota"
ok "CLI shim installed: $BIN_DIR/piquota"

# Remove legacy shuvquota shadow shim if present
if [[ -L "$BIN_DIR/shuvquota" && "$(readlink -f "$BIN_DIR/shuvquota" 2>/dev/null || true)" == *"pi-quota"* ]]; then
  rm -f "$BIN_DIR/shuvquota"
  warn "cleaned up legacy shuvquota shim; upstream shuvquota is accessible again"
fi

# --link prefers a symlink so the repository stays the single source of truth: a
# copy goes stale the moment the extension changes, and Pi then runs code the
# developer never edited. Git Bash's ln silently copies when the platform denies
# symlink creation (Windows without Developer Mode), so the link is verified
# instead of trusted, and the copy fallback says what actually happened.
install_extension() {
  # One assignment per statement: bash expands every right-hand side of a single
  # `local` before assigning any of them, so `$name` would still be unset here.
  local name="$1"
  local label="$2"
  local src="$HERE/extensions/$name"
  local dst="$EXT_DIR/$name"
  rm -f "$dst"
  if [[ "$MODE" == "link" ]] && ln -sfn "$src" "$dst" 2>/dev/null && [[ -L "$dst" ]]; then
    ok "$label linked: $dst -> $src"
    return
  fi
  cp "$src" "$dst"
  if [[ "$MODE" == "link" ]]; then
    warn "$label copied, not linked: this platform denied symlink creation."
    warn "  Re-run ./install.sh after editing $name, or enable Developer Mode for real links."
  else
    ok "$label installed: $dst"
  fi
}

install_extension "quota-panel.ts" "Pi TUI quota extension"

# gentle-pi paints its right rail from a hardcoded allowlist, so the quota card only
# appears there once piQuota's part is added to it. The extension re-checks and
# re-applies this on every session start; doing it here means the first Pi run after
# installing already has the slot instead of waiting for the next session.
if [[ -f "$PREFIX/src/gentle-pi/rail-patch.js" ]]; then
  if ! node "$PREFIX/src/gentle-pi/rail-patch.js" --apply 2>&1 | sed 's/^/  /'; then
    warn "the gentle-pi rail slot could not be patched; the quota box still renders above the editor"
  fi
fi

# Approval mirroring only makes sense with a daemon to mirror to.
if command -v moshi-hook >/dev/null 2>&1; then
  install_extension "moshi-approvals.ts" "Pi approval mirror"
else
  log "skipped the approval mirror: it needs moshi-hook as the daemon to send to"
fi

# Replacing ~/.local/share/pi-quota leaves a running watcher executing the old code
# from memory, so an upgrade would silently keep the previous cadence. Restart it.
if command -v systemctl >/dev/null 2>&1; then
  if [[ "$(systemctl --user is-active pi-quota-moshi.service 2>/dev/null)" == "active" ]]; then
    systemctl --user restart pi-quota-moshi.service >/dev/null 2>&1 \
      && ok "restarted pi-quota-moshi.service so the new code takes effect" \
      || warn "pi-quota-moshi.service is running the previous code; run: systemctl --user restart pi-quota-moshi.service"
  fi
fi

# --- Omarchy Agents panel timer (opt-in) ---
if [[ "$OMARCHY_TIMER" == "true" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found: the Omarchy timer needs systemd. Run \`piquota omarchy\` from your own scheduler."
  else
    mkdir -p "$UNIT_DIR"
    # The shipped unit uses %h/.local/bin; follow PI_QUOTA_BIN_DIR when it differs.
    sed "s|^ExecStart=.*|ExecStart=$BIN_DIR/piquota omarchy|" "$HERE/contrib/systemd/piquota-omarchy.service" > "$UNIT_DIR/piquota-omarchy.service"
    cp "$HERE/contrib/systemd/piquota-omarchy.timer" "$UNIT_DIR/piquota-omarchy.timer"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    if systemctl --user enable --now piquota-omarchy.timer >/dev/null 2>&1; then
      ok "Omarchy timer enabled: piquota-omarchy.timer (every 5 minutes)"
      log "Omarchy ships its own claude/codex records; to avoid duplicates, hide them with:"
      log "  omarchy bar set omarchy.agents providers ..."
    else
      warn "could not enable piquota-omarchy.timer; run: systemctl --user enable --now piquota-omarchy.timer"
    fi
  fi
fi

echo
echo "--- Diagnostics & Integrations ---"
case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
  *) warn "$BIN_DIR is not on PATH; add: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --- Claude source Detection ---
PI_AUTH="$HOME/.pi/agent/auth.json"
CLAUDE_CODE_CREDS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"
PI_ANTHROPIC="no"
CLAUDE_CODE="no"

if [[ -f "$PI_AUTH" ]] && grep -q '"anthropic"' "$PI_AUTH" 2>/dev/null; then
  PI_ANTHROPIC="yes"
fi
if [[ -f "$CLAUDE_CODE_CREDS" ]] && grep -q 'claudeAiOauth' "$CLAUDE_CODE_CREDS" 2>/dev/null; then
  CLAUDE_CODE="yes"
fi

if [[ "$CLAUDE_CODE" == "yes" ]]; then
  ok "Claude Code store found: $CLAUDE_CODE_CREDS (preferred Claude source)"
  log "            piQuota reads it read-only and never touches its refresh token."
elif [[ "$PI_ANTHROPIC" == "yes" ]]; then
  log "Claude: using Pi's own \`anthropic\` entry (no Claude Code CLI store found)"
else
  warn "Claude: no credential found (neither Pi's \`anthropic\` entry nor a Claude Code store)"
  log "        log in with \`/login anthropic\` in Pi, or install Claude Code and run \`claude\`"
fi

if [[ "$CLAUDE_CODE" == "yes" && "$PI_ANTHROPIC" == "yes" ]]; then
  log "        Both sources exist; the Claude Code CLI wins. Override with PI_QUOTA_CLAUDE_SOURCE=pi"
fi

# --- Moshi Detection ---
if command -v moshi-hook >/dev/null 2>&1; then
  MOSHI_VER="$(moshi-hook version 2>/dev/null | head -1 || echo "detected")"
  ok "moshi-hook found: $MOSHI_VER"
  if [[ -f "$HOME/.local/state/moshi/secrets.json" ]]; then
    ok "moshi-hook paired with host secret (\`piquota moshi push\` ready)"
  else
    warn "moshi-hook found but not paired yet; run \`moshi-hook pair\` to link your mobile app"
  fi
else
  log "moshi-hook not installed (optional — needed only if syncing to the Moshi mobile app: https://getmoshi.app)"
fi

if compgen -G "/mnt/c/Users/*/AppData/Roaming/Mozilla/Firefox/Profiles/*/cookies.sqlite" >/dev/null 2>&1 \
   || compgen -G "$HOME/.mozilla/firefox/*/cookies.sqlite" >/dev/null 2>&1 \
   || compgen -G "$HOME/Library/Application Support/Firefox/Profiles/*/cookies.sqlite" >/dev/null 2>&1; then
  ok "Firefox profile found (automatic cookie extraction for OpenCode Go supported)"
else
  warn "Firefox profile not detected; use \`piquota auth opencode --paste\` for OpenCode Go"
fi

echo
echo "=========================================="
echo "Installation complete!"
echo "=========================================="
echo "Verify with:"
log "piquota --explain      # verify credential store resolution"
log "piquota                # test the CLI panel"
log "piquota auth status    # check OpenCode Go session discovery"
log "piquota moshi status   # check Moshi integration status"
log "piquota omarchy       # write the Omarchy Agents panel records once (see --omarchy-timer)"
log "piquota moshi takeover # make piQuota the only usage publisher (removes duplicate cards)"
log "/quota                 # reload or start Pi and run inside TUI"
echo
