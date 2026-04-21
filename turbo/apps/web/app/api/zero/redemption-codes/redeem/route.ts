/**
 * Redemption codes — REDEEM endpoint.
 *
 * Open to any authenticated user: the code itself is the capability, and the
 * recipient is the legitimate holder once it has been handed out. No staff
 * check and no feature-switch check here. Single-use is enforced atomically
 * inside `redeemRedemptionCode`.
 */
import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroRedemptionCodesRedeemContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { redeemRedemptionCode } from "../../../../../src/lib/zero/credit/redemption-code-service";

const router = tsr.router(zeroRedemptionCodesRedeemContract, {
  redeem: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    const result = await redeemRedemptionCode({
      orgId: org.orgId,
      userId: authCtx.userId,
      code: body.code,
    });

    return { status: 200 as const, body: result };
  },
});

const handler = createHandler(zeroRedemptionCodesRedeemContract, router, {
  routeName: "zero.redemption-codes.redeem",
});

export { handler as POST };
