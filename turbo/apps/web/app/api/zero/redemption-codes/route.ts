/**
 * Redemption codes — MINT endpoint.
 *
 * AUTHORIZATION: `isStaffOrg(org.orgId)` is the sole and decisive gate.
 * This endpoint intentionally does NOT call `isFeatureEnabled` and does NOT
 * load user feature-switch overrides. Feature switches can be flipped by any
 * authenticated user via POST /api/zero/feature-switches, so they are a UI
 * rollout control, not an authorization primitive. Keep this gate in place
 * even if you add a `FeatureSwitchKey.RedemptionCodes` check elsewhere — the
 * hard identity check is what makes minting safe.
 */
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroRedemptionCodesMintContract,
  createErrorResponse,
  isStaffOrg,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { mintRedemptionCodes } from "../../../../src/lib/zero/credit/redemption-code-service";

const router = tsr.router(zeroRedemptionCodesMintContract, {
  mint: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    if (!isStaffOrg(org.orgId)) {
      return createErrorResponse(
        "FORBIDDEN",
        "Redemption code minting is restricted to vm0 staff",
      );
    }

    const codes = await mintRedemptionCodes({
      orgId: org.orgId,
      userId: authCtx.userId,
      creditsPerCode: body.creditsPerCode,
      quantity: body.quantity,
    });

    return {
      status: 200 as const,
      body: {
        codes: codes.map((c) => {
          return {
            code: c.code,
            creditsPerCode: c.creditsPerCode,
            expiresAt: c.expiresAt.toISOString(),
          };
        }),
      },
    };
  },
});

const handler = createHandler(zeroRedemptionCodesMintContract, router, {
  errorHandler: createSafeErrorHandler("zero-redemption-codes:mint"),
});

export { handler as POST };
