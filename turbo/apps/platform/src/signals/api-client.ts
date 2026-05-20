/**
 * Type-safe ts-rest API client for platform → zero API calls.
 *
 * Replaces raw fetch$ usage with typed ts-rest clients that provide
 * compile-time type checking for request/response shapes.
 */
import { computed } from "ccstate";
import type {
  AppRouter,
  InitClientArgs,
  InitClientReturn,
} from "@ts-rest/core";
import { clerk$ } from "./auth.ts";
import { apiBase$ } from "./fetch.ts";
import { resolveApiBase } from "./api-base.ts";
import { createAuthedTsRestClient } from "./api-client-base.ts";

/**
 * Type alias for the factory function returned by `get(zeroClient$)`.
 * Useful for shared helper functions that accept the client factory
 * as a parameter (e.g. `createZeroAgent`).
 */
export type ZeroClientFactory = <T extends AppRouter>(
  contract: T,
  options?: ZeroClientOptions,
) => InitClientReturn<T, InitClientArgs>;

export interface ZeroClientOptions {
  readonly apiBase?: "auto" | "api" | "www";
}

function rebaseApiPath(path: string, apiBase: string): string {
  const url = new URL(path, resolveApiBase(false));
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  return `${base}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Factory signal for creating typed ts-rest clients.
 *
 * Returns a function that accepts any ts-rest contract and returns
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
    return createAuthedTsRestClient(contract, {
      baseUrl: resolveApiBase(false),
      getClerk: () => {
        return get(clerk$);
      },
      resolvePath: async (path) => {
        if (options?.apiBase === "api") {
          return rebaseApiPath(path, resolveApiBase(true));
        }
        if (options?.apiBase === "www") {
          return rebaseApiPath(path, resolveApiBase(false));
        }
        return rebaseApiPath(path, await get(apiBase$));
      },
    });
  };
});
