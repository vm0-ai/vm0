import {
  createHandler,
  createSafeErrorHandler,
  tsr,
} from "../../../../../src/lib/ts-rest-handler";
import {
  zeroConnectorsSearchContract,
  createErrorResponse,
  CONNECTOR_TYPES,
  ConnectorType,
  ConnectorSearchAuthMethod,
  getAllFeatureStates,
} from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";

const router = tsr.router(zeroConnectorsSearchContract, {
  search: async ({ headers, query }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const featureStates = await getAllFeatureStates(authCtx.userId);
    const keyword = query.keyword?.toLowerCase();

    const connectors = (
      Object.keys(CONNECTOR_TYPES) as ConnectorType[]
    ).flatMap((type) => {
      const config = CONNECTOR_TYPES[type];
      const flag = config.featureFlag;
      const oauthEnabled = !flag || !!featureStates[flag];
      const hasApiToken = "api-token" in config.authMethods;

      if (!oauthEnabled && !hasApiToken) return [];

      const availableAuthMethods: ConnectorSearchAuthMethod[] = [];
      if (oauthEnabled && "oauth" in config.authMethods) {
        availableAuthMethods.push("oauth");
      }
      if (hasApiToken) {
        availableAuthMethods.push("api-token");
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
  errorHandler: createSafeErrorHandler("zero-connectors:search"),
});

export { handler as GET };
