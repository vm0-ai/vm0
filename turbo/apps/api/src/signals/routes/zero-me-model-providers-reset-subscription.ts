import { command } from "ccstate";
import { zeroPersonalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/zero-personal-model-providers";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { isNotFoundResponse, notFound } from "../../lib/error";
import { consumePersonalCodexRateLimitResetCredit$ } from "../services/model-provider-subscription-usage.service";
import type { RouteEntry } from "../route-entry";
import { writeDb$ } from "../external/db";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { listPersonalModelProviderAccounts } from "../services/model-provider-account.service";

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

    const featureSwitchContext = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const accountsEnabled = isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProviderAccounts,
      featureSwitchContext,
    );
    const activeAccount = accountsEnabled
      ? (
          await listPersonalModelProviderAccounts({
            db: set(writeDb$),
            orgId: auth.orgId,
            userId: auth.userId,
            featureSwitchContext,
          })
        ).modelProviders.find((provider) => {
          return provider.type === params.type && provider.isActive;
        })
      : undefined;

    const result = await set(
      consumePersonalCodexRateLimitResetCredit$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        idempotencyKey: bodyResult.data.idempotencyKey,
        ...(activeAccount ? { modelProviderAccountId: activeAccount.id } : {}),
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
