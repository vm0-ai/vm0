import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { isBadRequest } from "@vm0/api-services/errors";
import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { initServices } from "../../../../src/lib/init-services";
import {
  isAuthError,
  requireAuth,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import {
  getUserModelPreference,
  updateUserModelPreference,
} from "../../../../src/lib/zero/model-policy/user-model-preference-service";

function serializePreference(preference: {
  selectedModel: Awaited<
    ReturnType<typeof getUserModelPreference>
  >["selectedModel"];
  updatedAt: Date | null;
}) {
  return {
    selectedModel: preference.selectedModel,
    updatedAt: preference.updatedAt?.toISOString() ?? null,
  };
}

const router = tsr.router(zeroUserModelPreferenceContract, {
  get: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { org } = await resolveOrg(authCtx);
    return {
      status: 200 as const,
      body: serializePreference(
        await getUserModelPreference(org.orgId, authCtx.userId),
      ),
    };
  },

  update: async ({ body, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { org } = await resolveOrg(authCtx);
    try {
      const preference = await updateUserModelPreference(
        org.orgId,
        authCtx.userId,
        body.selectedModel,
      );
      return {
        status: 200 as const,
        body: serializePreference(preference),
      };
    } catch (error) {
      if (isBadRequest(error)) {
        return createErrorResponse("BAD_REQUEST", "Invalid request");
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroUserModelPreferenceContract, router, {
  routeName: "zero.user-model-preference",
});

export { handler as GET, handler as PUT };
