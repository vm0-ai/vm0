/**
 * Redemption codes — MINT + LIST endpoints.
 *
 * AUTHORIZATION: a caller is allowed to mint or list iff
 *   `isStaffOrg(org.orgId) || isExtraStaffUser(authCtx.userId)`.
 *
 * - `isStaffOrg` matches against the hard-coded `STAFF_ORG_ID_HASHES` list
 *   (the real vm0 staff org) — this is the canonical gate.
 * - `isExtraStaffUser` matches against the `EXTRA_STAFF_USER_IDS` env var
 *   (comma-separated plain Clerk user IDs, populated in `.env.local` or
 *   per-engineer preview secrets). Use it to let a specific engineer mint
 *   test codes without being in the real staff org.
 *
 * These endpoints intentionally do NOT call `isFeatureEnabled` and do NOT
 * load user feature-switch overrides. Feature switches can be flipped by any
 * authenticated user via POST /api/zero/feature-switches, so they are a UI
 * rollout control, not an authorization primitive. Keep the identity checks
 * above in place even if you add a `FeatureSwitchKey.RedemptionCodes` check
 * elsewhere — they are what makes minting and tracing safe.
 */
import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../src/lib/ts-rest-handler";
import {
  zeroRedemptionCodesMintContract,
  zeroRedemptionCodesListContract,
  createErrorResponse,
  isStaffOrg,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  listRedemptionCodes,
  mintRedemptionCodes,
} from "../../../../src/lib/zero/credit/redemption-code-service";
import { isExtraStaffUser } from "../../../../src/lib/auth/extra-staff";

const mintRouter = tsr.router(zeroRedemptionCodesMintContract, {
  mint: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    if (!isStaffOrg(org.orgId) && !isExtraStaffUser(authCtx.userId)) {
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

const listRouter = tsr.router(zeroRedemptionCodesListContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;

    const { org } = await resolveOrg(authCtx);

    if (!isStaffOrg(org.orgId) && !isExtraStaffUser(authCtx.userId)) {
      return createErrorResponse(
        "FORBIDDEN",
        "Redemption code tracing is restricted to vm0 staff",
      );
    }

    const codes = await listRedemptionCodes();
    return {
      status: 200 as const,
      body: {
        codes: codes.map((c) => {
          return {
            code: c.code,
            creditsPerCode: c.creditsPerCode,
            createdAt: c.createdAt.toISOString(),
            createdByUserId: c.createdByUserId,
            expiresAt: c.expiresAt.toISOString(),
            redeemedAt: c.redeemedAt ? c.redeemedAt.toISOString() : null,
            redeemedByUserId: c.redeemedByUserId,
            redeemedByOrgId: c.redeemedByOrgId,
          };
        }),
      },
    };
  },
});

const mintHandler = createHandler(zeroRedemptionCodesMintContract, mintRouter, {
  errorHandler: createSafeErrorHandler("zero-redemption-codes:mint"),
});
const listHandler = createHandler(zeroRedemptionCodesListContract, listRouter, {
  errorHandler: createSafeErrorHandler("zero-redemption-codes:list"),
});

export { mintHandler as POST, listHandler as GET };
