import { bankingContract } from "@okouai/api-contracts/contracts/banking";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  bankingAccounts$,
  bankingBalances$,
  bankingTransactions$,
} from "../services/banking.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

function okouTokenRequired() {
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

const bankingDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Banking is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const bankingEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.Banking, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

const accountsBody$ = bodyResultOf(bankingContract.accounts);
const balancesBody$ = bodyResultOf(bankingContract.balances);
const transactionsBody$ = bodyResultOf(bankingContract.transactions);

const accountsInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "zero") {
    return okouTokenRequired();
  }
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  signal.throwIfAborted();

  const bodyResult = await get(accountsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return await set(bankingAccounts$, { auth, body: bodyResult.data }, signal);
});

const balancesInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "zero") {
    return okouTokenRequired();
  }
  if (!(await set(bankingEnabled$))) {
    return bankingDisabled;
  }
  signal.throwIfAborted();

  const bodyResult = await get(balancesBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return await set(bankingBalances$, { auth, body: bodyResult.data }, signal);
});

const transactionsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "zero") {
      return okouTokenRequired();
    }
    if (!(await set(bankingEnabled$))) {
      return bankingDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(transactionsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    return await set(
      bankingTransactions$,
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

export const bankingRoutes: readonly RouteEntry[] = [
  {
    route: bankingContract.accounts,
    handler: authRoute(bankingAuth, accountsInner$),
  },
  {
    route: bankingContract.balances,
    handler: authRoute(bankingAuth, balancesInner$),
  },
  {
    route: bankingContract.transactions,
    handler: authRoute(bankingAuth, transactionsInner$),
  },
];
