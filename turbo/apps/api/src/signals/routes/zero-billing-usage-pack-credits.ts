import { command } from "ccstate";
import { zeroBillingUsagePackCreditsContract } from "@vm0/api-contracts/contracts/zero-billing";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$ } from "../external/db";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  getOrganizationUsagePackCreditBalances,
  getUsagePackCreditBalance,
  organizationHasActiveUsagePack,
} from "../services/usage-pack-credit.service";
import type { RouteEntry } from "../route-entry";

const usagePackCreditsDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Usage pack credits are not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const getUsagePackCredits$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(FeatureSwitchKey.UsagePackPlans, {
      orgId: auth.orgId,
      userId: auth.userId,
      overrides,
    })
  ) {
    return usagePackCreditsDisabled;
  }

  const db = get(db$);
  const hasUsagePack = await organizationHasActiveUsagePack(db, auth.orgId);
  signal.throwIfAborted();
  if (!hasUsagePack) {
    return {
      status: 200 as const,
      body: {
        totalCredits: 0,
        purchasedCredits: 0,
        bonusCredits: 0,
        creditGrants: [],
        hasUsagePack: false,
      },
    };
  }

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
      body: { ...body, hasUsagePack: true, memberCredits },
    };
  }
  return { status: 200 as const, body: { ...body, hasUsagePack: true } };
});

export const zeroBillingUsagePackCreditsRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingUsagePackCreditsContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsagePackCredits$,
    ),
  },
];
