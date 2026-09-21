/**
 * errorKind classification tests.
 *
 * The renderer relies on these categories being mutually exclusive and
 * stable across providers: a token-expired message must always read as
 * `expired`, never as `auth`, so the user is told what to do.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { errorKind, errorCaption, errorGlyph, isRecoverableError, ERROR_KINDS } from "../src/providers/error-kind.js";

test("errorKind: missing-credential messages from every provider classify as 'missing'", () => {
  assert.equal(errorKind("no claude credential in the Pi store or from the Claude Code CLI"), "missing");
  assert.equal(errorKind("no codex credential in the Pi store"), "missing");
  assert.equal(errorKind("no antigravity credential in the Pi store"), "missing");
  assert.equal(errorKind("Pi store has no anthropic access token; run /login anthropic in Pi"), "missing");
  assert.equal(errorKind("Pi store has no openai-codex access token; run /login openai-codex in Pi"), "missing");
  assert.equal(errorKind('no "auth" cookie for opencode.ai in 0 readable store(s)'), "missing");
  assert.equal(errorKind("Pi store has no antigravity credential; run /login antigravity in Pi"), "missing");
});

test("errorKind: token-expired messages classify as 'expired', not 'auth'", () => {
  assert.equal(errorKind("Claude Code token expired or rejected; run `claude` once to refresh it"), "expired");
  assert.equal(errorKind("Codex token expired or rejected; use any Codex model in Pi to refresh it"), "expired");
  assert.equal(errorKind("Antigravity token rejected; run /login antigravity in Pi"), "expired");
  assert.equal(errorKind("token 5m"), "expired");
  assert.equal(errorKind("token EXPIRED"), "expired");
});

test("errorKind: auth-shaped 401/403 messages classify as 'auth'", () => {
  assert.equal(errorKind("Claude usage request failed: HTTP 401"), "auth");
  assert.equal(errorKind("OpenCode Zen probe failed: HTTP 403"), "auth");
  assert.equal(errorKind("HTTP 401 Unauthorized"), "auth");
  assert.equal(errorKind("invalid_grant"), "auth");
});

test("errorKind: 429 and our own backoff message classify as 'throttle'", () => {
  assert.equal(errorKind("Claude usage request failed: rate limited (HTTP 429); retry in 12s"), "throttle");
  assert.equal(errorKind("backing off after a throttle: next attempt in 240s"), "throttle");
  assert.equal(errorKind("throttle detected upstream"), "throttle");
});

test("errorKind: 5xx, timeouts and socket errors classify as 'transient'", () => {
  assert.equal(errorKind("Claude usage request failed: HTTP 502"), "transient");
  assert.equal(errorKind("Antigravity quota request failed: fetch failed"), "transient");
  assert.equal(errorKind("upstream timed out"), "transient");
  assert.equal(errorKind("ECONNRESET while reading body"), "transient");
  assert.equal(errorKind("ENOTFOUND chatgpt.com"), "transient");
  assert.equal(errorKind("socket hang up"), "transient");
});

test("errorKind: anything else falls back to 'unknown', never crashes on null/empty", () => {
  assert.equal(errorKind(null), "unknown");
  assert.equal(errorKind(undefined), "unknown");
  assert.equal(errorKind(""), "unknown");
  assert.equal(errorKind("API shape may have changed"), "unknown");
});

test("errorKind: every category appears at least once in the public list", () => {
  assert.deepEqual(ERROR_KINDS, ["transient", "throttle", "expired", "auth", "missing", "unknown"]);
});

test("isRecoverableError: only transient and throttle qualify", () => {
  assert.equal(isRecoverableError("Claude usage request failed: HTTP 502"), true);
  assert.equal(isRecoverableError("Claude usage request failed: rate limited (HTTP 429); retry in 12s"), true);
  assert.equal(isRecoverableError("token expired"), false);
  assert.equal(isRecoverableError("HTTP 401"), false);
  assert.equal(isRecoverableError("no claude credential in the Pi store"), false);
  assert.equal(isRecoverableError("API shape may have changed"), false);
  assert.equal(isRecoverableError(null), false);
});

test("errorGlyph: each kind paints a different glyph so the line is readable on mono", () => {
  assert.equal(errorGlyph("HTTP 502"), "~");
  assert.equal(errorGlyph("HTTP 429"), "…");
  assert.equal(errorGlyph("token expired"), "!");
  assert.equal(errorGlyph("HTTP 401"), "!");
  assert.equal(errorGlyph("no claude credential in the Pi store"), "·");
  assert.equal(errorGlyph(null), "?");
  assert.notEqual(errorGlyph("HTTP 502"), errorGlyph("HTTP 429"));
  assert.notEqual(errorGlyph("HTTP 502"), errorGlyph("token expired"));
});

test("errorCaption: each kind has a short user-facing description", () => {
  assert.equal(errorCaption("HTTP 502"), "upstream temporarily unavailable");
  assert.equal(errorCaption("HTTP 429"), "rate-limited upstream");
  assert.equal(errorCaption("token expired"), "token expired");
  assert.equal(errorCaption("HTTP 401"), "credential rejected");
  assert.equal(errorCaption("no claude credential in the Pi store"), "not configured");
  assert.equal(errorCaption("anything else"), "unavailable");
});
