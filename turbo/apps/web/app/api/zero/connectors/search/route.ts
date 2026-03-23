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

    const connectors = (Object.keys(CONNECTOR_TYPES) as ConnectorType[])
      .filter((type) => {
        const config = CONNECTOR_TYPES[type];
        const flag = config.featureFlag;
        const oauthEnabled = !flag || !!featureStates[flag];
        const hasApiToken = "api-token" in config.authMethods;
        return oauthEnabled || hasApiToken;
      })
      .map((type) => {
        const config = CONNECTOR_TYPES[type];
        const flag = config.featureFlag;
        const oauthEnabled = !flag || !!featureStates[flag];
        const availableAuthMethods: string[] = [];
        if (oauthEnabled && "oauth" in config.authMethods) {
          availableAuthMethods.push("oauth");
        }
        if ("api-token" in config.authMethods) {
          availableAuthMethods.push("api-token");
        }
        return {
          id: type,
          label: config.label,
          description: config.helpText,
          authMethods: availableAuthMethods,
        };
      })
      .filter((item) => {
        if (!keyword) return true;
        return (
          item.label.toLowerCase().includes(keyword) ||
          item.description.toLowerCase().includes(keyword)
        );
      });

    return { status: 200 as const, body: { connectors } };
  },
});

const handler = createHandler(zeroConnectorsSearchContract, router, {
  errorHandler: createSafeErrorHandler("zero-connectors:search"),
});

export { handler as GET };
