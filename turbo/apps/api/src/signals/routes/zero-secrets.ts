import { command, computed } from "ccstate";
import {
  zeroSecretsContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  setUserVariable$,
  userSecrets,
  userVariables,
} from "../services/zero-user-data.service";
import { zeroSecretsDeleteRoutes } from "./zero-secrets-delete";
import { zeroVariablesDeleteRoutes } from "./zero-variables-delete";

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

const setVariableBody$ = bodyResultOf(zeroVariablesContract.set);

const setVariableInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(setVariableBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const variable = await set(
      setUserVariable$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        variable: bodyResult.data,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: variable,
    };
  },
);

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
  {
    route: zeroVariablesContract.set,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setVariableInner$,
    ),
  },
  ...zeroSecretsDeleteRoutes,
  ...zeroVariablesDeleteRoutes,
];
