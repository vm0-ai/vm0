/**
 * Internal HTTP client for zero routes to call infra (agent) endpoints.
 *
 * Zero routes (application layer) use this client to call agent routes
 * (infra layer) with full ts-rest type safety. In local dev the calls
 * go through localhost; in production they go through the deployment URL.
 */
import "server-only";
import { initClient, type AppRouter } from "@ts-rest/core";
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

/**
 * Create a typed ts-rest client for an infra (agent) contract.
 *
 * @param contract - The ts-rest contract to create a client for
 * @param authToken - The Authorization header value to forward (e.g. "Bearer xxx")
 *
 * @example
 * ```ts
 * const client = createInfraClient(runsMainContract, headers.authorization);
 * const result = await client.create({ body: runRequest });
 * if (result.status === 200) {
 *   return { status: 200, body: result.body };
 * }
 * ```
 */
export function createInfraClient<T extends AppRouter>(
  contract: T,
  authToken?: string,
) {
  return initClient(contract, {
    baseUrl: getInfraBaseUrl(),
    baseHeaders: authToken ? { Authorization: authToken } : {},
    jsonQuery: false,
  });
}
