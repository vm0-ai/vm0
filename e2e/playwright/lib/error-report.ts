import { inspect } from "node:util";

/**
 * `console.error` renders anything nested deeper than `util.inspect`'s default
 * depth of 2 as a bare `[ClassName]`. A runner credential failure nests the
 * real cause three levels below the top-level error
 * (`AggregateError` -> `[errors]` -> `Error` -> `[cause]`), so the Playwright
 * matcher failure that actually stopped the job reaches CI logs as
 * `[ExpectError]` with no message, locator, timeout, or call log.
 */
export function formatErrorReport(error: unknown): string {
  return inspect(error, { depth: null });
}
