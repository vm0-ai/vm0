import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import {
  zeroConnectorsSearchContract,
  createErrorResponse,
  CONNECTOR_TYPES,
  ConnectorType,
  ConnectorSearchAuthMethod,
  FeatureSwitchKey,
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

    const platformGloballyEnabled =
      !!featureStates[FeatureSwitchKey.PlatformConnectors];

    const connectors = (
      Object.keys(CONNECTOR_TYPES) as ConnectorType[]
    ).flatMap((type) => {
      const config = CONNECTOR_TYPES[type];
      const flag = config.featureFlag;
      const flagEnabled = !flag || !!featureStates[flag];
      // api-token is always available; oauth requires the per-connector
      // flag; platform requires both the per-connector flag and the global
      // PlatformConnectors flag.
      const showOauth = flagEnabled && "oauth" in config.authMethods;
      const showApiToken = "api-token" in config.authMethods;
      const showPlatform =
        flagEnabled &&
        platformGloballyEnabled &&
        "platform" in config.authMethods;

      // Hidden unless at least one auth method shows.
      if (!showOauth && !showApiToken && !showPlatform) return [];

      const availableAuthMethods: ConnectorSearchAuthMethod[] = [];
      if (showOauth) {
        availableAuthMethods.push("oauth");
      }
      if (showApiToken) {
        availableAuthMethods.push("api-token");
      }
      if (showPlatform) {
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
