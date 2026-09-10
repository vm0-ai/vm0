export function apiFailureMessage(
  operation: string,
  status: number,
  requestId: string | null,
  retryAfter: string | null,
): string {
  return [
    operation + " failed with HTTP " + status,
    "request_id=" + (requestId ?? "unavailable"),
    "retry_after=" + (retryAfter ?? "unavailable"),
  ].join("; ");
}
