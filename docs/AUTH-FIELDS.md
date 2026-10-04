# Credential inventory

Every credential this project touches, and the policy that follows from it.
Field **names** only; values never appear in code, logs, tests or artifacts.

## Sources

| Source | Path | Access |
| --- | --- | --- |
| Pi provider store | `$PI_QUOTA_AUTH_PATH` / `$PI_AUTH_PATH`, else `$HOME/.pi/agent/auth.json` | read-only (`flag: "r"`) |
| Pi store (WSL) | `/mnt/c/Users/<profile>/.pi/agent/auth.json` | read-only, auto-discovered, de-duplicated against the Linux store |
| Claude Code CLI store | `$PI_QUOTA_CLAUDE_CODE_CREDENTIALS`, else `$CLAUDE_CONFIG_DIR/.credentials.json`, else `$HOME/.claude/.credentials.json` | read-only (`flag: "r"`); the second Claude source |
| Claude Code profile | `$CLAUDE_CONFIG_DIR/.claude.json`, else `$HOME/.claude.json` | read-only; only `oauthAccount.emailAddress`, `displayName` and `organizationType` are read, never project history |
| opencode.ai session | `OPENCODE_GO_AUTH_COOKIE`, else `~/.config/pi-quota/opencode-cookie`, else a local browser cookie database (Firefox, or Chromium/Chrome/Edge/Brave on Linux) | read-only; browser databases are copied to a temp dir first |
| Moshi host secret | `~/.local/state/moshi/secrets.json` | read-only; `host-secret` is sent only as a Bearer header to the paired host |

Nothing else is read. `~/.shuvquota.env` is no longer used: the project does not
depend on any other tool's configuration.

Two stores holding the same account collapse into one entry: de-duplication is by
`family` plus identity (`accountId` → `email` → `projectId` → a truncated SHA-256
fingerprint of the secret). The fingerprint is one-way and is only a stable key.

## Pi entry schema

```jsonc
{
  "openai-codex": { "type": "oauth",   "access": "<JWT>", "refresh": "rt.1...", "expires": 1789…, "accountId": "…" },
  "anthropic":    { "type": "oauth",   "refresh": "sk-ant-ort01…", "access": "sk-ant-oat01…", "expires": 1789… },
  "antigravity":  { "type": "oauth",   "refresh": "1//0…", "access": "ya29.…", "expires": 1789…, "projectId": "…", "email": "…" },
  "opencode-go":  { "type": "api_key", "key": "sk-…" }
}
```

`expires` is epoch **milliseconds** (values above `1e11` are ms, below are
seconds).

### Claude Code entry schema

```jsonc
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01…",
    "refreshToken": "sk-ant-ort01…",        // presence checked, value never read
    "expiresAt": 1789273564505,             // access token expiry, epoch ms
    "refreshTokenExpiresAt": 1791828826505, // never read
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "pro",
    "rateLimitTier": "default_claude_ai"
  }
}
```

`~/.claude.json` is read for the account identity only: `oauthAccount.emailAddress`,
`displayName` and `organizationType`. That file also holds project history and
session state, and none of it is read or echoed.

| Field | Read by | Purpose | Written? |
| --- | --- | --- | --- |
| `accessToken` | `claude-code-auth.js` | `Authorization: Bearer` against `api.anthropic.com/api/oauth/usage` | **no** |
| `refreshToken` | `claude-code-auth.js` | presence reported as a boolean in `--explain`; the value is never placed on the credential | **no** |
| `expiresAt` | `claude-code-auth.js` | freshness warning | **no** |
| `refreshTokenExpiresAt` | — | deliberately not read | **no** |
| `subscriptionType` | `claude-code-auth.js` | the card's plan label | **no** |
| `rateLimitTier` | `claude-code-auth.js` | diagnostics | **no** |
| `oauthAccount.emailAddress` | `claude-code-auth.js` | display identity, redacted in artifacts | **no** |

## Field usage

| Field | Read by | Purpose | Written? |
| --- | --- | --- | --- |
| `type` | `pi-auth.js` | choose the `oauth` / `api_key` shape | no |
| `access` | every provider | `Authorization: Bearer` | no |
| `refresh` | `pi-auth.js`, `antigravity-oauth.js` | presence check; Antigravity in-memory refresh | **no** |
| `expires` | `pi-auth.js` | countdown, and the decision to refresh Antigravity | no |
| `accountId` | Codex | `chatgpt-account-id` header, display identity | no |
| `projectId` | Antigravity | `{ project }` body field, display identity | no |
| `email` | all | display identity, redacted in artifacts | no |
| `key` | OpenCode Go | Zen validity probe, identity fingerprint | no |

Codex JWT **payload** only (signature never verified, token never disclosed):
`https://api.openai.com/auth.chatgpt_account_id`, `…chatgpt_plan_type`,
`https://api.openai.com/profile.email`, `exp`.

> These claim keys contain dots, so the reader navigates an explicit key list
> (`src/auth/jwt.js`) and never a dotted path.

## Environment overrides

| Variable | Effect |
| --- | --- |
| `PI_QUOTA_AUTH_PATH`, `PI_AUTH_PATH` | replace the Pi store path |
| `PI_QUOTA_CLAUDE_CODE_CREDENTIALS` | replace the Claude Code credential file |
| `PI_QUOTA_CLAUDE_SOURCE` | `auto` (default, prefers Claude Code), `claude-code`, or `pi` |
| `CLAUDE_CONFIG_DIR` | Claude Code's own relocation variable, honoured as-is |
| `OPENCODE_GO_AUTH_COOKIE`, `OPENCODE_GO_WORKSPACE_ID` | supply the opencode.ai session directly |
| `MOSHI_API_BASE` | override the paired-host base URL |
| `MOSHI_SOCKET_PATH` | where the approval mirror dials the daemon |
| `ANTIGRAVITY_CLIENT_ID`, `ANTIGRAVITY_CLIENT_SECRET` | override the public Google client |
| `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `XDG_CONFIG_HOME` | relocate the cache, state and cookie file |
| `NO_COLOR`, `TERM=dumb` | drop ANSI colour from every surface |

## Refresh policy

| Provider | Rotates `refresh`? | Refresh here? | On expiry |
| --- | --- | --- | --- |
| Claude (Pi's `anthropic` entry) | yes | **never** | degrade: *use any Claude model in Pi to refresh it* |
| Claude (Claude Code CLI) | yes | **never, and the token is not even carried** | degrade: *run `claude` once to refresh it* |
| Codex | yes | **never** | degrade: *use any Codex model in Pi to refresh it* |
| Antigravity | no | **yes, in memory only** | transparent; nothing is preserved to disk |
| OpenCode Go | n/a (API key) | n/a | n/a |

Claude and OpenAI rotate the refresh token. Refreshing them here would invalidate
Pi's stored copy and break Pi, so the provider degrades with an instruction
instead.

The Claude Code store gets a stronger rule than "do not refresh": its refresh token
is **never read into memory at all**, so no later code path can act on it. `--explain`
reports only whether one is present (`refresh token present: yes (never read, never
used)`). Rotating it behind the CLI's back would sign the installed `claude` out. Google does not rotate this refresh token, which is what makes the
Antigravity refresh safe; the client used is Google's public Antigravity desktop
client, resolved from `ANTIGRAVITY_CLIENT_ID`/`SECRET`, else the installed
`pi-antigravity` package, else the recorded fallback.

## The opencode.ai session cookie

Pi stores an OpenCode **Zen** API key, which authorises no usage endpoint. The Go
plan windows live behind an authenticated SSR page, so exactly one extra
credential is needed: the `auth` cookie for `opencode.ai`.

| Aspect | Behaviour |
| --- | --- |
| Where it is read from | environment → `~/.config/pi-quota/opencode-cookie` (0600) → live browser store |
| How the browser store is read | the database (plus `-wal`/`-shm`) is copied to a private temp dir and opened read-only; the browser's own file is never opened by us |
| Which browsers work | Firefox anywhere (plaintext). Chromium, Google Chrome, Microsoft Edge, and Brave on **Linux** (decrypted in memory via Secret Service / libsecret or v10 peanuts fallback). Chromium on **Windows** encrypts values with DPAPI, which WSL cannot use, so those stores are reported as `ENCRYPTED` |
| Logged? | never; the cookie is not printed, cached, or written anywhere except that 0600 file when explicitly pasted |
| Workspace id | discovered from the authenticated workspace page and cached in `~/.config/pi-quota/opencode-workspace` (not a secret) |

## What leaves the machine

Only `piquota moshi push` sends anything, and only to the user's own paired host:
percentages, window labels, reset timestamps, plan names, an agent id from the
server's allowed union, the host name, and a stable `pi:<family>` account id.
No token, cookie, session key, or e-mail address.
