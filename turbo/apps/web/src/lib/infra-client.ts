/**
 * Internal HTTP client for zero routes to call infra (agent) endpoints.
 *
 * Zero routes (application layer) use this client to call agent routes
 * (infra layer) with full ts-rest type safety. In local dev the calls
 * go through localhost; in production they go through the deployment URL.
 */
import "server-only";
import { initClient, tsRestFetchApi, type AppRouter } from "@ts-rest/core";
import { env } from "../env";

/**
 * Resolve the base URL for internal infra calls.
 *
 * Priority:
 * 1. VM0_API_URL if explicitly set (e.g. tunnel URL in dev)
 * 2. Vercel deployment URL in production/preview
 * 3. localhost:3000 fallback for local development only
 *
 * Throws in non-development environments if neither URL is configured.
 */
function getInfraBaseUrl(): string {
  const e = env();

  if (e.VM0_API_URL) return e.VM0_API_URL;

  if (e.VERCEL_URL) return `https://${e.VERCEL_URL}`;

  if (e.NODE_ENV === "development") return "http://localhost:3000";

  throw new Error("VM0_API_URL or VERCEL_URL must be configured in production");
}

interface InfraClientOptions {
  /** Query parameters to forward to the infra endpoint (e.g. { org: "my-org" }) */
  query?: Record<string, string>;
}

/**
 * Create a typed ts-rest client for an infra (agent) contract.
 *
 * @param contract - The ts-rest contract to create a client for
 * @param authToken - The Authorization header value to forward (e.g. "Bearer xxx")
 * @param options - Additional options (e.g. query params to forward)
 *
 * @example
 * ```ts
 * // Simple call
 * const client = createInfraClient(runsMainContract, headers.authorization);
 * const result = await client.create({ body: runRequest });
 *
 * // With org query param forwarding (for proxy routes)
 * const client = createInfraClient(connectorsMainContract, headers.authorization, {
 *   query: { org: orgSlug },
 * });
 * const result = await client.list();
 * ```
 */
export function createInfraClient<T extends AppRouter>(
  contract: T,
  authToken?: string,
  options?: InfraClientOptions,
) {
  return initClient(contract, {
    baseUrl: getInfraBaseUrl(),
    baseHeaders: authToken ? { Authorization: authToken } : {},
    jsonQuery: false,
    api: options?.query
      ? async (args: Parameters<typeof tsRestFetchApi>[0]) => {
          const params = new URLSearchParams(options.query);
          const separator = args.path.includes("?") ? "&" : "?";
          return tsRestFetchApi({
            ...args,
            path: `${args.path}${separator}${params.toString()}`,
          });
        }
      : undefined,
  });
}
