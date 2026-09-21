/**
 * Classify a provider error message so renderers can pick a distinct glyph,
 * colour and tooltip per cause.
 *
 * Every renderer collapses "failed" into one symbol today, which is the
 * visible symptom the user reported: a provider that is just backing off
 * reads the same as one whose sign-in has expired. Distinguishing the two
 * makes the line actionable instead of alarming.
 *
 * Categories:
 *
 *   `transient` — upstream briefly unavailable (timeout, ECONNRESET, 5xx).
 *                 mergeLastGood() can substitute the previous good snapshot.
 *   `throttle`  — the vendor returned 429 and we are in a backoff window.
 *                 mergeLastGood() can substitute too.
 *   `expired`   — the stored OAuth/API token is past its expiry. Action
 *                 required; the line must say so clearly.
 *   `auth`      — the upstream rejected the credential (401/403) but the
 *                 token is not yet past its stored expiry. Action required.
 *   `missing`   — no credential or no cookie was found at all. Tells the
 *                 user to log in, not that anything is broken.
 *   `unknown`   — anything else. Better than "!" with no hint.
 *
 * The classification is intentionally regex-based and conservative: a
 * misclassified permanent error masked as transient would hide a real
 * problem. Only patterns that already exist in the codebase (see
 * providers/backoff.js for `isAuthFailure`, moshi/sticky.js for the
 * `TRANSIENT` set) qualify.
 */

export const ERROR_KINDS = ["transient", "throttle", "expired", "auth", "missing", "unknown"];

/** @typedef {"transient" | "throttle" | "expired" | "auth" | "missing" | "unknown"} ErrorKind */

/**
 * @param {string | null | undefined} error
 * @returns {ErrorKind}
 */
export function errorKind(error) {
  if (!error || typeof error !== "string") return "unknown";
  if (
    /no [a-z-]+ credential|has no (anthropic|openai-codex|antigravity|opencode-go) (access )?token|no key stored|no "auth" cookie|no opencode\.ai session/i.test(
      error,
    )
  ) {
    return "missing";
  }
  if (
    /token expired|token EXPIRED|token -?\d+m|expires in -\d+|sign-in expired|re-authenticate|expired or rejected|rejected by .* zen|rejected; run \/login|reconnect OpenCode in Pi/i.test(
      error,
    )
  ) {
    return "expired";
  }
  if (/HTTP 401|HTTP 403|401|403|unauthorized|forbidden|invalid_grant|token rejected/i.test(error)) {
    return "auth";
  }
  if (/HTTP 429|rate limited|backing off|throttle/i.test(error)) {
    return "throttle";
  }
  if (/HTTP 5\d\d|timed out|timeout|ECONNRESET|socket|network|fetch failed|ENOTFOUND|ETIMEDOUT|EPIPE|ECONNREFUSED|aborted|hang up/i.test(error)) {
    return "transient";
  }
  return "unknown";
}

/**
 * Whether `errorKind()` will let mergeLastGood() keep the previous good
 * snapshot. Only `transient` and `throttle` qualify; everything else points
 * at a real problem that must not be masked.
 *
 * @param {string | null | undefined} error
 * @returns {boolean}
 */
export function isRecoverableError(error) {
  const kind = errorKind(error);
  return kind === "transient" || kind === "throttle";
}

/**
 * The glyph a renderer should paint when the provider has no usable windows.
 * Distinct from `?` (which means "no percentage reported, but the provider
 * answered") so the line is not ambiguous.
 *
 * @param {string | null | undefined} error
 * @returns {string}
 */
export function errorGlyph(error) {
  switch (errorKind(error)) {
    case "transient":
      return "~";
    case "throttle":
      return "…";
    case "expired":
    case "auth":
      return "!";
    case "missing":
      return "·";
    default:
      return "?";
  }
}

/**
 * A one-line, user-facing description of the failure, safe to surface in a
 * tooltip or under a glyph in the compact line. Already redacted upstream.
 *
 * @param {string | null | undefined} error
 * @returns {string}
 */
export function errorCaption(error) {
  const kind = errorKind(error);
  if (!error) return kind === "unknown" ? "no data" : "no data";
  switch (kind) {
    case "throttle":
      return "rate-limited upstream";
    case "transient":
      return "upstream temporarily unavailable";
    case "expired":
      return "token expired";
    case "auth":
      return "credential rejected";
    case "missing":
      return "not configured";
    default:
      return "unavailable";
  }
}
