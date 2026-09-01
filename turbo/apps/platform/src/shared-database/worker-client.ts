import type {
  AppRouter,
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";

import { createAuthedContractClient } from "../signals/api-client-base.ts";
import type { AuthRecovery } from "../signals/auth-retry.ts";

export type SharedDatabaseContractClient<TContract extends AppRouter> =
  InitClientReturn<TContract, InitClientArgs>;

export type SharedDatabaseContractClientFactory = <TContract extends AppRouter>(
  contract: TContract,
  baseUrl: string,
  authRecovery: AuthRecovery,
  rootSignal: AbortSignal,
  getVercelProtectionBypass: () => string | undefined,
) => SharedDatabaseContractClient<TContract>;

export function createSharedDatabaseContractClientFactory(
  clientVersion: string,
): SharedDatabaseContractClientFactory {
  return <TContract extends AppRouter>(
    contract: TContract,
    baseUrl: string,
    authRecovery: AuthRecovery,
    rootSignal: AbortSignal,
    getVercelProtectionBypass: () => string | undefined,
  ): SharedDatabaseContractClient<TContract> => {
    return createAuthedContractClient(contract, {
      baseUrl,
      clientVersion,
      getAuthRecovery: () => {
        return Promise.resolve(authRecovery);
      },
      getRootSignal: () => {
        return rootSignal;
      },
      getVercelProtectionBypass,
      validateResponse: true,
    });
  };
}
