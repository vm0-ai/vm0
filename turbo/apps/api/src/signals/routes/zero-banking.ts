import { zeroBankingContract } from "@vm0/api-contracts/contracts/zero-banking";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  zeroBankingAccounts$,
  zeroBankingBalances$,
  zeroBankingTransactions$,
} from "../services/zero-banking.service";

function zeroTokenRequired() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Banking gateway access requires a zero run token",
        code: "FORBIDDEN",
      },
    },
  };
}

const accountsBody$ = bodyResultOf(zeroBankingContract.accounts);
const balancesBody$ = bodyResultOf(zeroBankingContract.balances);
const transactionsBody$ = bodyResultOf(zeroBankingContract.transactions);

const accountsInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "zero") {
    return zeroTokenRequired();
  }

  const bodyResult = await get(accountsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return await set(
    zeroBankingAccounts$,
    { auth, body: bodyResult.data },
    signal,
  );
});

const balancesInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "zero") {
    return zeroTokenRequired();
  }

  const bodyResult = await get(balancesBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return await set(
    zeroBankingBalances$,
    { auth, body: bodyResult.data },
    signal,
  );
});

const transactionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "zero") {
      return zeroTokenRequired();
    }

    const bodyResult = await get(transactionsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    return await set(
      zeroBankingTransactions$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

const bankingAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "banking:read",
  accept: ["zero"],
} as const;

export const zeroBankingRoutes: readonly RouteEntry[] = [
  {
    route: zeroBankingContract.accounts,
    handler: authRoute(bankingAuth, accountsInner$),
  },
  {
    route: zeroBankingContract.balances,
    handler: authRoute(bankingAuth, balancesInner$),
  },
  {
    route: zeroBankingContract.transactions,
    handler: authRoute(bankingAuth, transactionsInner$),
  },
];
