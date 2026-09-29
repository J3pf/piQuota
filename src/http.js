/**
 * Minimal timed JSON HTTP helpers.
 *
 * Every outbound request in this project goes through here so that timeouts,
 * redaction of secrets and error normalization stay in one place.
 */

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Redact credential-looking substrings from arbitrary text before it can reach
 * a log, a terminal or an error message.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redact(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "<email>");
  text = text.replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}\b/g, "<jwt>");
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(ya29\.)[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(1\/\/)[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(rt\.[\w.]{4})[A-Za-z0-9_-]+/g, "$1<redacted>");
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>");
  text = text.replace(/\b((?:__Host-console_session|auth)=)[^;\s]+/gi, "$1<redacted>");
  return text;
}

/**
 * @typedef {Object} HttpResult
 * @property {boolean} ok
 * @property {number} status
 * @property {unknown} [body]      Parsed JSON body when parsing succeeded.
 * @property {string} [text]       Raw body when JSON parsing failed or on error.
 * @property {string} [error]      Redacted, human-readable failure reason.
 * @property {boolean} [authError] True for 401/403, which callers surface as a
 *                                 "sign in again" degradation.
 */

/**
 * Perform one request and parse a JSON body.
 *
 * @param {string} url
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string,
 *   timeoutMs?: number,
 *   fetchFn?: typeof fetch,
 * }} [options]
 * @returns {Promise<HttpResult>}
 */
export async function requestJson(url, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        authError: true,
        error: `sign-in expired (HTTP ${response.status})`,
      };
    }

    if (response.status === 429) {
      const retryAfter = response.headers?.get?.("retry-after");
      return {
        ok: false,
        status: 429,
        error: retryAfter
          ? `rate limited (HTTP 429); retry in ${retryAfter}s`
          : "rate limited (HTTP 429); retry in a minute",
      };
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 200);
      } catch {
        // Body is optional: the status alone is enough to report the failure.
      }
      return {
        ok: false,
        status: response.status,
        error: detail
          ? `HTTP ${response.status}: ${redact(detail).replace(/\s+/g, " ")}`
          : `HTTP ${response.status}`,
      };
    }

    const raw = await response.text();
    if (raw.trim() === "") {
      return { ok: true, status: response.status, body: null };
    }
    try {
      return { ok: true, status: response.status, body: JSON.parse(raw) };
    } catch {
      return {
        ok: false,
        status: response.status,
        text: raw,
        error: "response was not valid JSON",
      };
    }
  } catch (error) {
    const name = /** @type {{ name?: string, message?: string }} */ (error)?.name;
    const message = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    return {
      ok: false,
      status: 0,
      error: name === "AbortError" ? `timed out after ${timeoutMs}ms` : redact(message),
    };
  } finally {
    clearTimeout(timeout);
  }
}
