import { command } from "ccstate";
import { zeroPersonalModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { isNotFoundResponse, notFound } from "../../lib/error";
import { consumePersonalCodexRateLimitResetCredit$ } from "../services/model-provider-subscription-usage.service";
import type { RouteEntry } from "../route-entry";

const resetSubscriptionUsageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(
        zeroPersonalModelProvidersByTypeContract.resetSubscriptionUsage,
      ),
    );
    signal.throwIfAborted();

    if (params.type !== "codex-oauth-token") {
      return notFound(`Provider "${params.type}" not found`);
    }

    const bodyResult = await get(
      bodyResultOf(
        zeroPersonalModelProvidersByTypeContract.resetSubscriptionUsage,
      ),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      consumePersonalCodexRateLimitResetCredit$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        idempotencyKey: bodyResult.data.idempotencyKey,
      },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    return { status: 200 as const, body: result };
  },
);

export const zeroMeModelProvidersResetSubscriptionRoutes: readonly RouteEntry[] =
  [
    {
      route: zeroPersonalModelProvidersByTypeContract.resetSubscriptionUsage,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        resetSubscriptionUsageInner$,
      ),
    },
  ];
