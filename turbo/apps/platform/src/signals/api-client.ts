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
} from "@okouai/api-contracts/contracts/trpc-contract";
import { authRecovery$ } from "./auth.ts";
import { appVersion$ } from "./app-version.ts";
import {
  resolveApiBase,
  resolveApiBaseForTarget,
  resolveOAuthApiBase,
} from "./api-base.ts";
import { createAuthedContractClient } from "./api-client-base.ts";
import { rootSignal$ } from "./root-signal.ts";

/**
 * Type alias for the factory function returned by `get(apiClient$)`.
 * Useful for shared helper functions that accept the client factory
 * as a parameter (e.g. `createAgent`).
 */
export type ApiClientFactory = <T extends AppRouter>(
  contract: T,
  options?: ApiClientOptions,
) => InitClientReturn<T, InitClientArgs>;

declare const oauthApiBaseBrand: unique symbol;

type OAuthApiBase = "oauth" & {
  readonly [oauthApiBaseBrand]: true;
};

/**
 * Environment-aware API base reserved for OAuth and origin handoff flows.
 * Normal platform API calls should use the default API backend or `apiBase: "api"`.
 */
export const OAUTH_API_BASE = "oauth" as OAuthApiBase;

export interface ApiClientOptions {
  readonly apiBase?: "auto" | "api" | OAuthApiBase;
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
 * const createClient = get(apiClient$);
 * const client = createClient(agentsByIdContract);
 * const result = await client.get({ params: { id: "my-agent-id" } });
 * if (result.status === 200) {
 *   console.log(result.body.displayName);
 * }
 * ```
 */
export const apiClient$ = computed((get) => {
  const clientVersion = get(appVersion$);
  return <T extends AppRouter>(contract: T, options?: ApiClientOptions) => {
    return createAuthedContractClient(contract, {
      baseUrl: resolveApiBase(),
      clientVersion,
      getAuthRecovery: () => {
        return get(authRecovery$);
      },
      getRootSignal: () => {
        return get(rootSignal$);
      },
      resolvePath: (path) => {
        if (options?.apiBase === "api") {
          return rebaseApiPath(path, resolveApiBaseForTarget("api"));
        }
        if (options?.apiBase === OAUTH_API_BASE) {
          return rebaseApiPath(path, resolveOAuthApiBase());
        }
        return rebaseApiPath(path, resolveApiBase());
      },
    });
  };
});
