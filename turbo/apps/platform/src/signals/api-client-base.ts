import {
  initClient,
  trpcRestFetchApi,
  validateResponse,
  type AppRouter,
  type ApiFetcherArgs,
  type InitClientArgs,
  type InitClientReturn,
} from "@vm0/api-contracts/contracts/trpc-contract";

import { IN_VITEST } from "../env.ts";
import { addCapturedPreviewBypassHeader } from "../lib/preview-bypass-cookie.ts";
import {
  fetchFreshToken,
  handleUnauthorizedRedirect,
  type ClerkLike,
} from "./auth-retry.ts";
import { addClientHeaders } from "./client-headers.ts";
import { reportForceUpgradeResponse } from "./force-upgrade.ts";

interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly getClerk: () => Promise<ClerkLike>;
  readonly getUnauthorizedRedirectSuppressionUntil?: () => number;
  readonly resolvePath?: (
    path: string,
    ctx: { method: string },
  ) => Promise<string> | string;
}

export function createAuthedContractClient<T extends AppRouter>(
  contract: T,
  options: AuthedClientOptions,
): InitClientReturn<T, InitClientArgs> {
  return initClient(contract, {
    baseUrl: options.baseUrl,
    jsonQuery: false,
    // Validation is handled below so errors include the actual response body.
    validateResponse: false,
    api: async (args: ApiFetcherArgs) => {
      const clerk = await options.getClerk();
      const initialToken = (await clerk.session?.getToken()) ?? null;
      const path = options.resolvePath
        ? await options.resolvePath(args.path, { method: args.route.method })
        : args.path;

      const requestWithToken = (token: string | null) => {
        const headers = new Headers(args.headers);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        addClientHeaders(headers);
        addCapturedPreviewBypassHeader(headers, options.baseUrl);
        return trpcRestFetchApi({
          ...args,
          fetchOptions: { ...args.fetchOptions, credentials: "include" },
          headers,
          path,
        });
      };

      let response = await requestWithToken(initialToken);

      if (response.status === 401) {
        const refreshResult = await fetchFreshToken(clerk, initialToken);
        if (refreshResult.status === "refreshed") {
          response = await requestWithToken(refreshResult.token);
        }
        if (response.status === 401 && refreshResult.status !== "offline") {
          handleUnauthorizedRedirect(
            clerk,
            options.getUnauthorizedRedirectSuppressionUntil?.() ?? 0,
          );
        }
      }

      if (reportForceUpgradeResponse(response)) {
        return response;
      }

      if (IN_VITEST) {
        return validateResponse({
          appRoute: args.route,
          response,
        });
      }

      return response;
    },
  });
}
