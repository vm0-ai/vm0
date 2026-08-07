import { computed } from "ccstate";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { zeroBillingStatus } from "../services/zero-billing-status.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const getBillingStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const [body, overrides] = await Promise.all([
    get(zeroBillingStatus(auth.orgId)),
    get(userFeatureSwitchOverrides(auth.orgId, auth.userId)),
  ]);
  return {
    status: 200 as const,
    body: {
      ...body,
      paymentMethodManagementAvailable: isFeatureEnabled(
        FeatureSwitchKey.PaymentMethodManagement,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          overrides,
        },
      ),
    },
  };
});

export const zeroBillingStatusRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingStatusContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "billing:read",
      },
      getBillingStatusInner$,
    ),
  },
];
