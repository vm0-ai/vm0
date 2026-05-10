import { computed } from "ccstate";
import {
  zeroSecretsContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route";
import { userSecrets, userVariables } from "../services/zero-user-data.service";
import { zeroSecretsDeleteRoutes } from "./zero-secrets-delete";

const listSecretsInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userSecrets({ orgId: auth.orgId, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body,
  };
});

const listVariablesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userVariables({ orgId: auth.orgId, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body,
  };
});

export const zeroSecretsRoutes: readonly RouteEntry[] = [
  {
    route: zeroSecretsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listSecretsInner$,
    ),
  },
  {
    route: zeroVariablesContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listVariablesInner$,
    ),
  },
  ...zeroSecretsDeleteRoutes,
];
