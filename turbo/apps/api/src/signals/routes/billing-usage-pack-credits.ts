import { command } from "ccstate";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$ } from "../external/db";
import {
  getOrganizationUsagePackCreditBalances,
  getUsagePackCreditBalance,
  hasActiveUsagePackAllocation,
} from "../services/usage-pack-credit.service";
import type { RouteEntry } from "../route-entry";

const getUsagePackCredits$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const hasUsagePack = await hasActiveUsagePackAllocation(db, {
    orgId: auth.orgId,
    ...(auth.orgRole === "admin" ? {} : { userId: auth.userId }),
  });
  signal.throwIfAborted();
  const body = await getUsagePackCreditBalance(db, {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  if (auth.orgRole === "admin") {
    const memberCredits = await getOrganizationUsagePackCreditBalances(db, {
      orgId: auth.orgId,
    });
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { ...body, hasUsagePack, memberCredits },
    };
  }
  return { status: 200 as const, body: { ...body, hasUsagePack } };
});

export const billingUsagePackCreditsRoutes: readonly RouteEntry[] = [
  {
    route: billingUsagePackCreditsContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsagePackCredits$,
    ),
  },
];
