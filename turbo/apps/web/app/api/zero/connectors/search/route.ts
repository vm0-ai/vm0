import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
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
import { loadFeatureSwitchOverrides } from "../../../../../src/lib/zero/user/feature-switches-service";

const router = tsr.router(zeroConnectorsSearchContract, {
  search: async ({ headers, query }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
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
      const flag = config.featureFlag;
      const flagEnabled = !flag || !!featureStates[flag];
      const hasOauth = "oauth" in config.authMethods;
      const hasApiToken = "api-token" in config.authMethods;
      const hasPlatform = "platform" in config.authMethods;

      // Hidden unless the flag allows an OAuth/platform method or an api-token
      // method exists (api-token is always available regardless of flag).
      if (!flagEnabled && !hasApiToken) return [];

      const availableAuthMethods: ConnectorSearchAuthMethod[] = [];
      if (flagEnabled && hasOauth) {
        availableAuthMethods.push("oauth");
      }
      if (hasApiToken) {
        availableAuthMethods.push("api-token");
      }
      if (flagEnabled && hasPlatform) {
        availableAuthMethods.push("platform");
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
