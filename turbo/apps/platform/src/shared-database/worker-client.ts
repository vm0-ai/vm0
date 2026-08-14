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

export function createSharedDatabaseContractClient<TContract extends AppRouter>(
  contract: TContract,
  baseUrl: string,
  getToken: () => string,
): InitClientReturn<TContract, InitClientArgs> {
  return initClient(contract, {
    baseUrl,
    jsonQuery: false,
    validateResponse: false,
    api: async (args: ApiFetcherArgs) => {
      const headers = new Headers(args.headers);
      headers.set("Authorization", `Bearer ${getToken()}`);
      addClientHeaders(headers);
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
}
