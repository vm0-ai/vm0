/**
 * Type-safe ts-rest API client for platform → zero API calls.
 *
 * Replaces raw fetch$ usage with typed ts-rest clients that provide
 * compile-time type checking for request/response shapes.
 */
import { computed } from "ccstate";
import {
  initClient,
  tsRestFetchApi,
  type AppRouter,
  type InitClientReturn,
  type InitClientArgs,
} from "@ts-rest/core";
import { clerk$ } from "./auth.ts";
import { apiBase$ } from "./fetch.ts";

/**
 * Type alias for the factory function returned by `get(zeroClient$)`.
 * Useful for shared helper functions that accept the client factory
 * as a parameter (e.g. `createZeroAgent`).
 */
export type ZeroClientFactory = <T extends AppRouter>(
  contract: T,
) => InitClientReturn<T, InitClientArgs>;

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
  return <T extends AppRouter>(contract: T) => {
    const apiBase = get(apiBase$);

    return initClient(contract, {
      baseUrl: apiBase,
      jsonQuery: false,
      api: async (args: Parameters<typeof tsRestFetchApi>[0]) => {
        const clerk = await get(clerk$);
        const token = await clerk.session?.getToken();

        const headers = token
          ? { ...args.headers, Authorization: `Bearer ${token}` }
          : args.headers;

        return tsRestFetchApi({ ...args, headers });
      },
    });
  };
});
