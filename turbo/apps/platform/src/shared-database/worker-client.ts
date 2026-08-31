import {
  initClient,
  trpcRestFetchApi,
  validateResponse,
  type ApiFetcherArgs,
  type AppRouter,
  type InitClientArgs,
  type InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { addClientHeaders } from "../signals/client-headers.ts";

export type SharedDatabaseContractClient<TContract extends AppRouter> =
  InitClientReturn<TContract, InitClientArgs>;

export type SharedDatabaseContractClientFactory = <TContract extends AppRouter>(
  contract: TContract,
  baseUrl: string,
  getToken: () => string,
  getVercelProtectionBypass: () => string | undefined,
) => SharedDatabaseContractClient<TContract>;

export function createSharedDatabaseContractClientFactory(
  clientVersion: string,
): SharedDatabaseContractClientFactory {
  return <TContract extends AppRouter>(
    contract: TContract,
    baseUrl: string,
    getToken: () => string,
    getVercelProtectionBypass: () => string | undefined,
  ): SharedDatabaseContractClient<TContract> => {
    return initClient(contract, {
      baseUrl,
      jsonQuery: false,
      validateResponse: false,
      api: async (args: ApiFetcherArgs) => {
        const headers = new Headers(args.headers);
        headers.set("Authorization", `Bearer ${getToken()}`);
        const vercelProtectionBypass = getVercelProtectionBypass();
        if (vercelProtectionBypass) {
          headers.set("X-Vercel-Protection-Bypass", vercelProtectionBypass);
        }
        addClientHeaders(headers, clientVersion);
        const response = await trpcRestFetchApi({
          ...args,
          fetchOptions: {
            ...args.fetchOptions,
            credentials: "include",
          },
          headers,
        });
        return validateResponse({
          appRoute: args.route,
          response,
        });
      },
    });
  };
}
