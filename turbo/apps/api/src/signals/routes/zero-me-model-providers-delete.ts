import { command } from "ccstate";
import { zeroPersonalModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { isNotFoundResponse } from "../../lib/error";
import { deleteUserModelProvider$ } from "../services/zero-model-provider.service";
import type { RouteEntry } from "../route";

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const params = get(
    pathParamsOf(zeroPersonalModelProvidersByTypeContract.delete),
  );
  signal.throwIfAborted();

  const result = await set(
    deleteUserModelProvider$,
    { orgId: auth.orgId, userId: auth.userId, type: params.type },
    signal,
  );
  signal.throwIfAborted();

  if (isNotFoundResponse(result)) {
    return result;
  }
  return { status: 204 as const, body: undefined };
});

export const zeroMeModelProvidersDeleteRoutes: readonly RouteEntry[] = [
  {
    route: zeroPersonalModelProvidersByTypeContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
