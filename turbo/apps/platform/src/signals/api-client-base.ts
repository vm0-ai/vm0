import {
  initClient,
  trpcRestFetchApi,
  validateResponse,
  type AppRouter,
  type ApiFetcherArgs,
  type InitClientArgs,
  type InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";

import { IN_VITEST } from "../env.ts";
import { addCapturedPreviewBypassHeader } from "../lib/preview-bypass-cookie.ts";
import type { AuthRecovery } from "./auth-retry.ts";
import { addClientHeaders } from "./client-headers.ts";
import { reportForceUpgradeResponse } from "./force-upgrade.ts";

interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly clientVersion: string;
  readonly getAuthRecovery: () => Promise<AuthRecovery>;
  readonly getRootSignal: () => AbortSignal;
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
      const authRecovery = await options.getAuthRecovery();
      const requestSignal = args.fetchOptions?.signal ?? undefined;
      const initialToken = await authRecovery.getToken(requestSignal);
      const path = options.resolvePath
        ? await options.resolvePath(args.path, { method: args.route.method })
        : args.path;

      const requestWithToken = (
        token: string | null,
        signal: AbortSignal | undefined = requestSignal,
      ) => {
        const headers = new Headers(args.headers);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        addClientHeaders(headers, options.clientVersion);
        addCapturedPreviewBypassHeader(headers, options.baseUrl);
        return trpcRestFetchApi({
          ...args,
          fetchOptions: {
            ...args.fetchOptions,
            credentials: "include",
            signal,
          },
          headers,
          path,
        });
      };

      let response = await requestWithToken(initialToken);

      if (response.status === 401) {
        const rootSignal = options.getRootSignal();
        const recoverySignal = requestSignal
          ? AbortSignal.any([rootSignal, requestSignal])
          : rootSignal;
        const freshToken = await authRecovery.forceRefreshToken(requestSignal);
        if (freshToken) {
          response = await requestWithToken(freshToken, recoverySignal);
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
