import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroConnectorScopeDiffContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { getScopeDiff } from "@vm0/connectors/connector-utils";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getConnector } from "../../../../../../src/lib/zero/connector/connector-service";

function unauthenticatedResponse() {
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

const router = tsr.router(zeroConnectorScopeDiffContract, {
  getScopeDiff: async ({ params, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "connector:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) return unauthenticatedResponse();
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const connector = await getConnector(org.orgId, userId, params.type);

    if (!connector) {
      return createErrorResponse("NOT_FOUND", "Connector not found");
    }

    const diff = getScopeDiff(params.type, connector.oauthScopes);
    return { status: 200 as const, body: diff };
  },
});

const handler = createHandler(zeroConnectorScopeDiffContract, router, {
  routeName: "zero.connectors.scope-diff",
});

export { handler as GET };
