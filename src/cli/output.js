/**
 * CLI output and timing helpers.
 */

/**
 * @param {string} text
 */
export function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * @param {string} text
 */
export function err(text) {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * A non-fatal problem worth showing without hiding the rest of the output.
 *
 * @param {string} text
 */
export function warn(text) {
  process.stderr.write(`warning: ${text.endsWith("\n") ? text : `${text}\n`}`);
}

/**
 * @param {number} seconds
 * @returns {Promise<void>}
 */
export function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
