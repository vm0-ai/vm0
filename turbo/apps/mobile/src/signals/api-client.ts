/**
 * Type-safe ts-rest API client for mobile → zero API calls.
 *
 * Mirrors platform's api-client.ts pattern — ccstate computed factory
 * that returns typed ts-rest clients with auth token injection.
 */
import { computed } from "ccstate";
import type {
  AppRouter,
  InitClientArgs,
  InitClientReturn,
} from "@ts-rest/core";
import { resolveApiBase } from "./api-base.ts";
import { createAuthedTsRestClient } from "./api-client-base.ts";

/**
 * Type alias for the factory function returned by `get(zeroClient$)`.
 */
export type ZeroClientFactory = <T extends AppRouter>(
  contract: T,
) => InitClientReturn<T, InitClientArgs>;

function rebaseApiPath(path: string, apiBase: string): string {
  const url = new URL(path, resolveApiBase(false));
  const base = apiBase.endsWith("/") ? apiBase.slice(0, -1) : apiBase;
  return `${base}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Factory signal for creating typed ts-rest clients.
 */
export const zeroClient$ = computed((_get) => {
  return <T extends AppRouter>(contract: T) => {
    return createAuthedTsRestClient(contract, {
      baseUrl: resolveApiBase(false),
      getToken: () => {
        return Promise.resolve(null);
      },
      resolvePath: (path) => {
        const apiBase = resolveApiBase(false);
        return rebaseApiPath(path, apiBase);
      },
    });
  };
});
