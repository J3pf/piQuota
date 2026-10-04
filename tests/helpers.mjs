/**
 * Test helpers: a fake fetch and a synthetic JWT. No real credential ever
 * appears in this directory.
 */

/**
 * Build a response object with the surface `requestJson` consumes.
 *
 * @param {unknown} body
 * @param {{ status?: number, headers?: Record<string, string>, text?: string }} [options]
 */
export function jsonResponse(body, options = {}) {
  const status = options.status ?? 200;
  const text = options.text ?? JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => options.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => text,
  };
}

/**
 * A fetch that dispatches on URL substring.
 *
 * @param {Array<[string, (url: string, init: any) => any]>} routes
 * @returns {{ fetchFn: typeof fetch, calls: Array<{ url: string, init: any }> }}
 */
export function routedFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [needle, handler] of routes) {
      if (String(url).includes(needle)) return handler(String(url), init);
    }
    return jsonResponse({ error: "no route" }, { status: 404 });
  };
  return { fetchFn: /** @type {typeof fetch} */ (fetchFn), calls };
}

/**
 * Unsigned, obviously fake JWT used to exercise the payload reader.
 *
 * @param {Record<string, unknown>} payload
 * @param {string} [header]
 * @returns {string}
 */
export function makeFakeJwt(payload, header = "fixture") {
  const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none", typ: "JWT", note: header })}.${encode(payload)}.fixture-signature`;
}

/**
 * Realistic Codex response body.
 *
 * @param {{ primaryUsed?: number, secondaryUsed?: number, planType?: string }} [options]
 */
export function codexUsageBody(options = {}) {
  const nowSeconds = 1_800_000_000;
  return {
    user_id: "user_fixture",
    account_id: "acct_fixture",
    email: "fixture@example.com",
    plan_type: options.planType ?? "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: options.primaryUsed ?? 19,
        limit_window_seconds: 18000,
        reset_after_seconds: 3600,
        reset_at: nowSeconds,
      },
      secondary_window: {
        used_percent: options.secondaryUsed ?? 3,
        limit_window_seconds: 604800,
        reset_after_seconds: 86_400,
        reset_at: nowSeconds,
      },
    },
    credits: { has_credits: false, unlimited: false, balance: "0" },
  };
}

/** Synthetic GitHub Actions organization usage summary. */
export function githubActionsSummaryBody(usageItems = [
  { product: "Actions", sku: "actions_linux", grossQuantity: 52, unitType: "minutes" },
  { product: "Actions", sku: "actions_storage", grossQuantity: 999, unitType: "gigabyte-hours" },
  { product: "Actions", sku: "actions_windows", grossQuantity: 800, unitType: "minutes" },
  { product: "Packages", sku: "actions_linux", grossQuantity: 500, unitType: "minutes" },
]) {
  return {
    timePeriod: { year: 2026, month: 10 },
    organization: "KoralisSoft",
    product: "Actions",
    usageItems,
  };
}

/** Synthetic GitHub Actions detailed monthly usage body. */
export function githubActionsUsageBody(usageItems = [
  {
    date: "2026-10-01",
    product: "actions",
    sku: "actions_linux",
    quantity: 52,
    unitType: "minutes",
    repositoryName: "easypets-registry-api",
  },
  {
    date: "2026-10-01",
    product: "actions",
    sku: "actions_storage",
    quantity: 250,
    unitType: "gigabyte-hours",
    repositoryName: "easypets-registry-api",
  },
]) {
  return { usageItems };
}

/** Realistic Anthropic OAuth usage body. */
export function claudeUsageBody() {
  return {
    five_hour: { utilization: 4, resets_at: "2030-01-01T10:00:00.000Z" },
    seven_day: { utilization: 11, resets_at: "2030-01-08T10:00:00.000Z" },
    extra_usage: { is_enabled: true, used_credits: 2908, decimal_places: 2, currency: "USD" },
    limits: [{ kind: "session", group: "session", percent: 4, resets_at: "2030-01-01T10:00:00.000Z", is_active: true }],
  };
}

/** Realistic Antigravity quota summary body with two model groups. */
export function antigravityUsageBody() {
  return {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2030-01-08T08:06:47Z",
            remainingFraction: 0.9823,
            description: "You have used some of your weekly limit.",
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            resetTime: "2030-01-01T09:00:28Z",
            remainingFraction: 0.9165,
            description: "You have used some of your 5-hour limit.",
          },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          {
            bucketId: "3p-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            resetTime: "2030-01-09T08:46:35Z",
            remainingFraction: 1,
          },
        ],
      },
    ],
  };
}
