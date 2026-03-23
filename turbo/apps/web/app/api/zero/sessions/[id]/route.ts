import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import { zeroSessionsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { getSessionResponse } from "../../../../../src/lib/agent-session/agent-session-service";
import { isNotFound, isForbidden } from "../../../../../src/lib/errors";

const router = tsr.router(zeroSessionsByIdContract, {
  getById: async ({ params, headers }, { request }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    try {
      const session = await getSessionResponse(params.id, userId, org.orgId);
      return { status: 200 as const, body: session };
    } catch (error) {
      if (isNotFound(error)) {
        return {
          status: 404 as const,
          body: { error: { message: error.message, code: "NOT_FOUND" } },
        };
      }
      if (isForbidden(error)) {
        return {
          status: 403 as const,
          body: { error: { message: error.message, code: "FORBIDDEN" } },
        };
      }
      throw error;
    }
  },
});

const handler = createHandler(zeroSessionsByIdContract, router, {
  errorHandler: createSafeErrorHandler("zero-sessions"),
});

export { handler as GET };
