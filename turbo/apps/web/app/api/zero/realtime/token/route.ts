import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { platformRealtimeTokenContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { generatePlatformUserToken } from "../../../../../src/lib/infra/realtime/client";

const router = tsr.router(platformRealtimeTokenContract, {
  create: async ({ headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Authentication required");
    }

    const tokenRequest = await generatePlatformUserToken(authCtx.userId);

    if (!tokenRequest) {
      return createErrorResponse(
        "INTERNAL_SERVER_ERROR",
        "Realtime service unavailable",
      );
    }

    return {
      status: 200 as const,
      body: tokenRequest,
    };
  },
});

const handler = createHandler(platformRealtimeTokenContract, router);

export { handler as POST };
