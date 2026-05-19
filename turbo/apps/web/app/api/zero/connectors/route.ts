import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroConnectorsMainContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import {
  providerEnvFromObject,
  getRuntimeAvailableConnectorTypes,
} from "@vm0/connectors/oauth-providers";

function unauthenticatedResponse() {
  return {
    status: 401 as const,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

const router = tsr.router(zeroConnectorsMainContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "connector:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) return unauthenticatedResponse();
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const connectorList = await listConnectors(org.orgId, userId);
    const configuredTypes = getRuntimeAvailableConnectorTypes(
      providerEnvFromObject(globalThis.services.env),
    );
    const connectorProvidedSecretNames = [
      ...getConnectorProvidedSecretNames(
        connectorList.map((c) => {
          return c.type;
        }),
      ),
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

const handler = createHandler(zeroConnectorsMainContract, router, {
  routeName: "zero.connectors",
});

export { handler as GET };
