/**
 * Construct platform URL from current host
 * - vm0.ai → platform.vm0.ai
 * - www.vm0.ai → platform.vm0.ai
 * - localhost:3000 → localhost:3001
 */
export function getPlatformUrl(host: string): string {
  const colonIndex = host.indexOf(":");
  const hostname = colonIndex === -1 ? host : host.slice(0, colonIndex);
  const port = colonIndex === -1 ? null : host.slice(colonIndex + 1);

  // Handle localhost - use different port for platform
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return `http://${hostname}:3001`;
  }

  // For production domains, replace www or prepend platform
  const parts = hostname.split(".");
  if (parts[0] === "www") {
    parts[0] = "platform";
  } else {
    parts.unshift("platform");
  }

  const platformHost = parts.join(".");
  const protocol = "https";
  return port
    ? `${protocol}://${platformHost}:${port}`
    : `${protocol}://${platformHost}`;
}
