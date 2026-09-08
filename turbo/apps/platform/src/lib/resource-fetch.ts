/**
 * Read public assets and transfer presigned objects without application auth.
 * API requests belong to apiClient$, which owns auth and response contracts.
 */
export function fetchResource(
  url: string | URL,
  options: Omit<RequestInit, "credentials" | "signal">,
  signal: AbortSignal | undefined,
): Promise<Response> {
  signal?.throwIfAborted();
  return fetch(url, { ...options, credentials: "omit", signal });
}
