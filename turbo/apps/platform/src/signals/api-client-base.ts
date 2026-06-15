import {
  initClient,
  tsRestFetchApi,
  type AppRouter,
  type InitClientArgs,
  type InitClientReturn,
} from "@ts-rest/core";

import { IN_VITEST } from "../env.ts";
import {
  fetchFreshToken,
  handleUnauthorizedRedirect,
  type ClerkLike,
} from "./auth-retry.ts";

interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly getClerk: () => Promise<ClerkLike>;
  readonly resolvePath?: (
    path: string,
    ctx: { method: string },
  ) => Promise<string> | string;
}

export function createAuthedTsRestClient<T extends AppRouter>(
  contract: T,
  options: AuthedClientOptions,
): InitClientReturn<T, InitClientArgs> {
  return initClient(contract, {
    baseUrl: options.baseUrl,
    jsonQuery: false,
    // Validation is handled below so errors include the actual response body.
    validateResponse: false,
    api: async (args: Parameters<typeof tsRestFetchApi>[0]) => {
      const clerk = await options.getClerk();
      const initialToken = (await clerk.session?.getToken()) ?? null;
      const path = options.resolvePath
        ? await options.resolvePath(args.path, { method: args.route.method })
        : args.path;

      const requestWithToken = (token: string | null) => {
        const headers = token
          ? { ...args.headers, Authorization: `Bearer ${token}` }
          : args.headers;
        return tsRestFetchApi({ ...args, headers, path });
      };

      let response = await requestWithToken(initialToken);

      if (response.status === 401) {
        const freshToken = await fetchFreshToken(clerk, initialToken);
        if (freshToken) {
          response = await requestWithToken(freshToken);
        }
        if (response.status === 401) {
          handleUnauthorizedRedirect(clerk);
        }
      }

      if (IN_VITEST) {
        const schema = args.route.responses[response.status];
        if (
          schema &&
          typeof schema === "object" &&
          "safeParse" in schema &&
          typeof schema.safeParse === "function"
        ) {
          const parsed = schema.safeParse(response.body) as
            | { success: true; data: unknown }
            | { success: false; error: { issues: unknown[] } };
          if (!parsed.success) {
            throw new Error(
              `Response validation failed (status ${response.status}).\n` +
                `Body: ${JSON.stringify(response.body, null, 2)}\n` +
                `Issues: ${JSON.stringify(parsed.error.issues, null, 2)}`,
            );
          }
          return { ...response, body: parsed.data };
        }
      }

      return response;
    },
  });
}
