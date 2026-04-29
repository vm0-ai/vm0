import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { zeroModelUsageRankingContract } from "@vm0/api-contracts/contracts/zero-model-usage-ranking";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { getModelUsageRanking } from "../../../../src/lib/zero/billing/model-usage-ranking-service";
import { loadFeatureSwitchOverrides } from "../../../../src/lib/zero/user/feature-switches-service";

const router = tsr.router(zeroModelUsageRankingContract, {
  get: async ({ query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const overrides = await loadFeatureSwitchOverrides(
      authCtx.orgId,
      authCtx.userId,
    );
    const enabled = isFeatureEnabled(FeatureSwitchKey.ModelUsageRanking, {
      orgId: authCtx.orgId,
      userId: authCtx.userId,
      overrides,
    });
    if (!enabled) {
      return createErrorResponse(
        "FORBIDDEN",
        "Model usage ranking is not enabled",
      );
    }

    const result = await getModelUsageRanking(query.range);
    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(zeroModelUsageRankingContract, router, {
  routeName: "zero.model-usage-ranking",
});

export { handler as GET };
