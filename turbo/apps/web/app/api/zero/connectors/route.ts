import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { zeroConnectorsMainContract } from "@vm0/core/contracts/zero-connectors";
import { getConnectorProvidedSecretNames } from "@vm0/core/contracts/connector-utils";
import { initServices } from "../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../src/lib/zero/org/resolve-org";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import { getConfiguredConnectorTypes } from "../../../../src/lib/zero/connector/provider-registry";

const router = tsr.router(zeroConnectorsMainContract, {
  list: async ({ headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "connector:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);
    const connectorList = await listConnectors(org.orgId, userId);
    const configuredTypes = getConfiguredConnectorTypes(
      globalThis.services.env,
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
