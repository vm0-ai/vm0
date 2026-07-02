/**
 * Type-safe tRPC-backed API client for platform → zero API calls.
 *
 * Replaces raw fetch$ usage with typed tRPC-backed clients that provide
 * compile-time type checking for request/response shapes.
 */
import { computed } from "ccstate";
import type {
  AppRouter,
  InitClientArgs,
  InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";
import { clerk$ } from "./auth.ts";
import { resolveApiBase, resolveApiBaseForTarget } from "./api-base.ts";
import { createAuthedContractClient } from "./api-client-base.ts";
import { unauthorizedRedirectSuppressionUntil$ } from "./auth-retry.ts";

/**
 * Type alias for the factory function returned by `get(zeroClient$)`.
 * Useful for shared helper functions that accept the client factory
 * as a parameter (e.g. `createZeroAgent`).
 */
export type ZeroClientFactory = <T extends AppRouter>(
  contract: T,
  options?: ZeroClientOptions,
) => InitClientReturn<T, InitClientArgs>;

declare const oauthWebApiBaseBrand: unique symbol;

type OAuthWebApiBase = "www" & {
  readonly [oauthWebApiBaseBrand]: true;
};

/**
 * Web-origin API base is reserved for OAuth and web-origin handoff flows only.
 * Normal platform API calls should use the default API backend or `apiBase: "api"`.
 */
export const OAUTH_WEB_API_BASE = "www" as OAuthWebApiBase;

export interface ZeroClientOptions {
  readonly apiBase?: "auto" | "api" | OAuthWebApiBase;
}

function rebaseApiPath(path: string, apiBase: string): string {
  const url = new URL(path, resolveApiBase());
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  return `${base}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Factory signal for creating typed tRPC-backed clients.
 *
 * Returns a function that accepts any tRPC-backed contract and returns
 * a fully configured client with auth token injection and base URL
 * resolution.
 *
 * @example
 * ```ts
 * const createClient = get(zeroClient$);
 * const client = createClient(zeroAgentsByIdContract);
 * const result = await client.get({ params: { id: "my-agent-id" } });
 * if (result.status === 200) {
 *   console.log(result.body.displayName);
 * }
 * ```
 */
export const zeroClient$ = computed((get) => {
  return <T extends AppRouter>(contract: T, options?: ZeroClientOptions) => {
    return createAuthedContractClient(contract, {
      baseUrl: resolveApiBase(),
      getClerk: () => {
        return get(clerk$);
      },
      getUnauthorizedRedirectSuppressionUntil: () => {
        return get(unauthorizedRedirectSuppressionUntil$);
      },
      resolvePath: (path) => {
        if (options?.apiBase === "api") {
          return rebaseApiPath(path, resolveApiBaseForTarget("api"));
        }
        if (options?.apiBase === OAUTH_WEB_API_BASE) {
          return rebaseApiPath(
            path,
            resolveApiBaseForTarget(OAUTH_WEB_API_BASE),
          );
        }
        return rebaseApiPath(path, resolveApiBase());
      },
    });
  };
});
