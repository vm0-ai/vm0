import { createHandler, tsr } from "../../../src/lib/ts-rest-handler";
import {
  connectorsMainContract,
  createErrorResponse,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../src/lib/init-services";
import { getAuthContext } from "../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../src/lib/org/resolve-org";
import { listConnectors } from "../../../src/lib/connector/connector-service";
import { getConfiguredConnectorTypes } from "../../../src/lib/connector/provider-registry";

const router = tsr.router(connectorsMainContract, {
  /**
   * GET /api/connectors - List all connectors
   */
  list: async ({ headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }
    const { userId, orgId: tokenOrgId } = authCtx;

    const orgSlug = new URL(request.url).searchParams.get("scope");
    const orgParam = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(userId, orgSlug, orgParam, tokenOrgId);
    const connectorList = await listConnectors(org.orgId, userId);
    const configuredTypes = getConfiguredConnectorTypes(
      globalThis.services.env,
    );
    const connectorProvidedSecretNames = [
      ...getConnectorProvidedSecretNames(connectorList.map((c) => c.type)),
    ];

    return {
      status: 200 as const,
      body: {
        connectors: connectorList,
        configuredTypes,
        connectorProvidedSecretNames,
      },
    };
  },
});

const handler = createHandler(connectorsMainContract, router);

export { handler as GET };
