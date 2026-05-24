import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildHubSpotAuthorizationUrl,
  exchangeHubSpotCode,
  getHubSpotSecretName,
  refreshHubSpotToken,
} from "./hubspot";
export const hubspotProvider: AuthCodeConnectorAuthProvider<"hubspot"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildHubSpotAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeHubSpotCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.hubDomain,
          email: result.userInfo.email,
        },
      };
    },
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: getHubSpotSecretName,
    getRefreshSecretName: () => {
      return "HUBSPOT_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshHubSpotToken(clientId, clientSecret, args.refreshToken);
    },
  },
  revoke: { kind: "none" },
};
