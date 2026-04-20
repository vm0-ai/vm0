import { getComputerUseHost } from "../api";

let cachedHost: { domain: string; token: string; cachedAt: number } | null =
  null;
const CACHE_TTL_MS = 30_000;

/**
 * Discover the active computer-use host for the current org/user.
 * Results are cached for 30 seconds.
 */
async function discoverHost(): Promise<{
  domain: string;
  token: string;
}> {
  if (cachedHost && Date.now() - cachedHost.cachedAt < CACHE_TTL_MS) {
    return { domain: cachedHost.domain, token: cachedHost.token };
  }

  const host = await getComputerUseHost();
  if (!host) {
    throw new Error(
      "No active computer-use host found\n\n" +
        "Start a host with: zero computer-use host start",
    );
  }

  cachedHost = { ...host, cachedAt: Date.now() };
  return host;
}

/**
 * Make an HTTP request to the computer-use host.
 */
export async function callHost(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<Response> {
  const { domain, token } = await discoverHost();
  const url = `https://desktop.${domain}${path}`;

  const headers: Record<string, string> = { "x-vm0-token": token };
  const init: RequestInit = { headers };

  if (options?.method) {
    init.method = options.method;
  }
  if (options?.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const body = await response.text().catch(() => {
      return "";
    });
    throw new Error(
      `Host returned ${response.status}: ${body || response.statusText}`,
    );
  }

  return response;
}
