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

/**
 * Distribute a union status into a discriminated union of response objects.
 * Uses `never` for body so the result is assignable to any expected body type
 * (never is the bottom type — assignable to everything).
 */
type DistributeResponse<S extends number> = S extends S
  ? { status: S; body: never }
  : never;

/**
 * Forward an infra client result to a zero route handler.
 *
 * ts-rest initClient returns { status: HTTPStatusCode; body: unknown } but
 * tsr.router handlers expect a discriminated union with specific body types.
 * This helper distributes the status union and erases the body type so the
 * result is assignable to the handler's expected return type.
 * Safe for proxy routes where infra and zero contracts share response shapes.
 */
export function forwardInfra<S extends number>(result: {
  status: S;
  body: unknown;
}): DistributeResponse<S> {
  return result as DistributeResponse<S>;
}

/**
 * Proxy a raw HTTP request to an infra endpoint.
 *
 * Used for infra endpoints that don't have ts-rest contracts
 * (e.g. metadata PATCH, schedule enable/disable).
 */
export async function proxyToInfra(
  infraPath: string,
  request: Request,
): Promise<Response> {
  const baseUrl = getInfraBaseUrl();
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(infraPath, baseUrl);

  // Forward query parameters
  incomingUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  const headers: Record<string, string> = {};
  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  const auth = request.headers.get("authorization");
  if (auth) {
    headers["Authorization"] = auth;
  }

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  return fetch(targetUrl, {
    method: request.method,
    headers,
    body: hasBody ? await request.text() : undefined,
  });
}
