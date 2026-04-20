import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  zeroPlatformConnectorContract,
  createErrorResponse,
  CONNECTOR_TYPES,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { createPlatformConnector } from "../../../../../src/lib/zero/connector/connector-service";

const router = tsr.router(zeroPlatformConnectorContract, {
  create: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization);
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    // Only connector types that declare a `platform` auth method can be
    // enabled via this endpoint. Anything else is a client bug — OAuth /
    // api-token types do not support credential-less enable.
    const config = CONNECTOR_TYPES[params.type];
    if (!("platform" in config.authMethods)) {
      return createErrorResponse(
        "BAD_REQUEST",
        `Connector "${params.type}" does not support platform enable`,
      );
    }

    const { org } = await resolveOrg(authCtx);
    const connector = await createPlatformConnector(
      org.orgId,
      userId,
      params.type,
    );

    return {
      status: 200 as const,
      body: connector,
    };
  },
});

const handler = createHandler(zeroPlatformConnectorContract, router, {
  errorHandler: createSafeErrorHandler("zero-platform-connectors:type"),
});

export { handler as POST };
