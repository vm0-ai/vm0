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
import type { AuthRecovery } from "./auth-retry.ts";
import { addClientHeaders } from "./client-headers.ts";
import { reportForceUpgradeResponse } from "./force-upgrade.ts";

interface AuthedClientOptions {
  readonly baseUrl: string;
  readonly getAuthRecovery: () => Promise<AuthRecovery>;
  readonly getRootSignal: () => AbortSignal;
  readonly getVercelProtectionBypass: () => string | undefined;
  readonly onForceUpgrade?: () => void;
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
      const rootSignal = options.getRootSignal();
      const signal = args.fetchOptions?.signal
        ? AbortSignal.any([rootSignal, args.fetchOptions.signal])
        : rootSignal;
      const initialToken = await authRecovery.getToken(signal);
      const path = options.resolvePath
        ? await options.resolvePath(args.path, { method: args.route.method })
        : args.path;

      const requestWithToken = (
        token: string | null,
        requestSignal: AbortSignal,
      ) => {
        const headers = new Headers(args.headers);
        if (token) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        addClientHeaders(headers);
        const vercelProtectionBypass = options.getVercelProtectionBypass();
        if (vercelProtectionBypass) {
          headers.set("X-Vercel-Protection-Bypass", vercelProtectionBypass);
        }
        return trpcRestFetchApi({
          ...args,
          fetchOptions: {
            ...args.fetchOptions,
            credentials: "include",
            signal: requestSignal,
          },
          headers,
          path,
        });
      };

      let response = await requestWithToken(initialToken, signal);

      if (response.status === 401) {
        const freshToken = await authRecovery.forceRefreshToken(signal);
        if (freshToken) {
          response = await requestWithToken(freshToken, signal);
        }
      }

      if (reportForceUpgradeResponse(response, options.onForceUpgrade)) {
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
