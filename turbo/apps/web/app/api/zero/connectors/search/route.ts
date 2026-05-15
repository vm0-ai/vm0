import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { zeroConnectorsSearchContract } from "@vm0/api-contracts/contracts/zero-connectors";
import {
  type ConnectorType,
  CONNECTOR_TYPES,
} from "@vm0/connectors/connectors";
import { getAvailableConnectorAuthMethods } from "@vm0/connectors/connector-utils";
import { getAllFeatureStates } from "@vm0/core/feature-switch";
import { createErrorResponse } from "@vm0/api-contracts/contracts/errors";
import { initServices } from "../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../src/lib/auth/require-auth";
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";

const router = tsr.router(zeroConnectorsSearchContract, {
  search: async ({ headers, query }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "connector:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    if (!authCtx.orgId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const overrides = await loadFeatureSwitchOverrides(
      authCtx.orgId,
      authCtx.userId,
    );
    const featureStates = getAllFeatureStates({
      userId: authCtx.userId,
      orgId: authCtx.orgId,
      overrides,
    });
    const keyword = query.keyword?.toLowerCase();

    const connectors = (
      Object.keys(CONNECTOR_TYPES) as ConnectorType[]
    ).flatMap((type) => {
      const config = CONNECTOR_TYPES[type];
      const availableAuthMethods = getAvailableConnectorAuthMethods(
        type,
        featureStates,
      );

      if (availableAuthMethods.length === 0) {
        return [];
      }

      const item = {
        id: type,
        label: config.label,
        description: config.helpText,
        authMethods: availableAuthMethods,
      };

      if (
        keyword &&
        !item.label.toLowerCase().includes(keyword) &&
        !item.description.toLowerCase().includes(keyword)
      ) {
        return [];
      }

      return [item];
    });

    return { status: 200 as const, body: { connectors } };
  },
});

const handler = createHandler(zeroConnectorsSearchContract, router, {
  routeName: "zero.connectors.search",
});

export { handler as GET };
