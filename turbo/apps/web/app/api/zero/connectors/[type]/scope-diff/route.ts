import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import {
  zeroConnectorScopeDiffContract,
  createErrorResponse,
  getScopeDiff,
} from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getConnector } from "../../../../../../src/lib/zero/connector/connector-service";

const router = tsr.router(zeroConnectorScopeDiffContract, {
  getScopeDiff: async ({ params, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
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
