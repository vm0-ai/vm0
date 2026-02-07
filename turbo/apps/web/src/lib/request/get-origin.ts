/**
 * Get the origin URL from a request, respecting proxy headers.
 *
 * When running behind a reverse proxy or tunnel (e.g., dev tunnel, load balancer),
 * the request URL will contain the internal server address (e.g., localhost:3000)
 * instead of the external URL the user accessed.
 *
 * This function checks for standard forwarded headers to determine the actual origin:
 * - x-forwarded-host: The original host requested by the client
 * - x-forwarded-proto: The original protocol (http/https)
 *
 * @param request - The incoming request
 * @returns The origin URL (e.g., "https://www.example.com" or "http://localhost:3000")
 */
export function getOrigin(request: Request): string {
  const url = new URL(request.url);

  // Check for forwarded headers (set by reverse proxies/tunnels)
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");

  if (forwardedHost) {
    const proto = forwardedProto || "https";
    return `${proto}://${forwardedHost}`;
  }

  return url.origin;
}
