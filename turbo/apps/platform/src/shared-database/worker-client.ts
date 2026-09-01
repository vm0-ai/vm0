import type {
  AppRouter,
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";

import { createAuthedContractClient } from "../signals/api-client-base.ts";

export interface SharedDatabaseAuthRecovery {
  readonly getToken: (signal: AbortSignal) => Promise<string | null>;
  readonly forceRefreshToken: (signal: AbortSignal) => Promise<string | null>;
}

export type SharedDatabaseContractClient<TContract extends AppRouter> =
  InitClientReturn<TContract, InitClientArgs>;

export type SharedDatabaseContractClientFactory = <TContract extends AppRouter>(
  contract: TContract,
  baseUrl: string,
  authRecovery: SharedDatabaseAuthRecovery,
  rootSignal: AbortSignal,
  getVercelProtectionBypass: () => string | undefined,
) => SharedDatabaseContractClient<TContract>;

export function createSharedDatabaseContractClientFactory(
  clientVersion: string,
): SharedDatabaseContractClientFactory {
  return <TContract extends AppRouter>(
    contract: TContract,
    baseUrl: string,
    authRecovery: SharedDatabaseAuthRecovery,
    rootSignal: AbortSignal,
    getVercelProtectionBypass: () => string | undefined,
  ): SharedDatabaseContractClient<TContract> => {
    return createAuthedContractClient(contract, {
      baseUrl,
      clientVersion,
      getToken: (signal) => {
        return authRecovery.getToken(signal);
      },
      getRootSignal: () => {
        return rootSignal;
      },
      getVercelProtectionBypass,
      reloadToken: (signal) => {
        return authRecovery.forceRefreshToken(signal);
      },
      validateResponse: true,
    });
  };
}
