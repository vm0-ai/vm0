/**
 * Extract an error message from a ts-rest API response.
 * All org management contracts return `{ error: { message: string } }` for
 * 400 / 401 / 403 / 500 status codes. This helper narrows the response and
 * returns the message so callers don't repeat the status-check boilerplate.
 */
export function extractApiErrorMessage(
  result: { status: number; body: unknown },
  fallback: string,
): string {
  if (
    (result.status === 400 ||
      result.status === 401 ||
      result.status === 403 ||
      result.status === 500) &&
    typeof result.body === "object" &&
    result.body !== null &&
    "error" in result.body
  ) {
    const error = (result.body as { error: { message: string } }).error;
    if (typeof error?.message === "string") {
      return error.message;
    }
  }
  return `${fallback} (${result.status})`;
}
