/**
 * Argument parsing shared by both CLIs.
 *
 * Deliberately small: this parser only owns the flags piquota itself
 * implements, and reports anything else as unknown.
 */

/**
 * @typedef {Object} ParsedArgs
 * @property {string[]} positionals
 * @property {boolean} json
 * @property {boolean} compact
 * @property {boolean} color
 * @property {boolean} noCache
 * @property {boolean} force
 * @property {boolean} explain
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} status
 * @property {boolean} clearCache
 * @property {number} ttlMs
 * @property {number} timeoutMs
 * @property {string[]} unknown          Flags this parser does not own.
 * @property {string[]} raw              Original argv.
 */

const VALUE_FLAGS = new Set(["--ttl", "--timeout"]);

/**
 * Flags a subcommand consumes from the raw argv, collected here only so the parser
 * can tell a real typo apart from a flag that belongs to `auth` or `moshi`.
 *
 * Without this list every `moshi watch --interval 60` looked like an unknown flag,
 * which is why the unknown-argument check was never wired up: a wrong flag was
 * silently ignored instead of reported.
 */
const SUBCOMMAND_VALUE_FLAGS = new Set(["--interval", "--fetch-ttl", "--wait"]);

/** Boolean flags owned by a subcommand. */
const SUBCOMMAND_FLAGS = new Set(["--paste", "--no-browser", "--print", "--no-refresh"]);

/**
 * What to name in an "unknown flag" report.
 *
 * A bare flag is reported alone when nothing followed it or when what followed was
 * another flag: `--interval --fetch-ttl` must not claim that `--fetch-ttl` was the
 * value of `--interval`.
 *
 * @param {string} flag
 * @param {string | undefined} value
 * @returns {string[]}
 */
function flagWithValue(flag, value) {
  return value !== undefined && value !== "" && !value.startsWith("-") ? [flag, value] : [flag];
}

/**
 * @param {string[]} argv
 * @param {{ defaultTtlMs?: number, defaultTimeoutMs?: number }} [defaults]
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, defaults = {}) {
  /** @type {ParsedArgs} */
  const parsed = {
    positionals: [],
    json: false,
    compact: false,
    color: true,
    noCache: false,
    force: false,
    explain: false,
    help: false,
    version: false,
    status: false,
    box: false,
    clearCache: false,
    ttlMs: defaults.defaultTtlMs ?? 60_000,
    timeoutMs: defaults.defaultTimeoutMs ?? 15_000,
    unknown: [],
    raw: [...argv],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      index += 1;
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) {
        parsed.unknown.push(...flagWithValue(arg, value));
        continue;
      }
      if (arg === "--ttl") parsed.ttlMs = number * 1000;
      if (arg === "--timeout") parsed.timeoutMs = number;
      continue;
    }

    if (SUBCOMMAND_VALUE_FLAGS.has(arg)) {
      // The value is consumed here only so it cannot be mistaken for a
      // positional; the subcommand reads it from `raw` itself.
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-") || Number.isNaN(Number(value))) {
        parsed.unknown.push(...flagWithValue(arg, value));
        continue;
      }
      index += 1;
      continue;
    }

    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--compact":
      case "-c":
        parsed.compact = true;
        break;
      case "--no-color":
        parsed.color = false;
        break;
      case "--no-cache":
        parsed.noCache = true;
        break;
      case "--force":
      case "--refresh":
        parsed.force = true;
        break;
      case "--explain":
        parsed.explain = true;
        break;
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--status":
        parsed.status = true;
        break;
      case "--box":
        parsed.box = true;
        break;
      case "--clear-cache":
        parsed.clearCache = true;
        break;
      default:
        // Owned by a subcommand, which reads it from `raw` itself.
        if (SUBCOMMAND_FLAGS.has(arg)) break;
        if (arg.startsWith("-")) parsed.unknown.push(arg);
        else parsed.positionals.push(arg);
    }
  }

  return parsed;
}
