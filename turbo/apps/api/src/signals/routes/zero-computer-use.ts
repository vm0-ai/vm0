import { computed } from "ccstate";
import { zeroComputerUseHostContract } from "@vm0/api-contracts/contracts/zero-computer-use";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { zeroComputerUseHost } from "../services/zero-computer-use.service";
import type { RouteEntry } from "../route";

const computerUseDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Computer use is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const hostNotFound = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "No active computer-use host",
      code: "NOT_FOUND",
    }),
  }),
});

const getComputerUseHostInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  const enabled = isFeatureEnabled(FeatureSwitchKey.ComputerUse, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
  if (!enabled) {
    return computerUseDisabled;
  }

  const host = await get(
    zeroComputerUseHost({ orgId: auth.orgId, userId: auth.userId }),
  );
  if (!host) {
    return hostNotFound;
  }

  return { status: 200 as const, body: host };
});

export const zeroComputerUseRoutes: readonly RouteEntry[] = [
  {
    route: zeroComputerUseHostContract.getHost,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "computer-use:write",
      },
      getComputerUseHostInner$,
    ),
  },
];
