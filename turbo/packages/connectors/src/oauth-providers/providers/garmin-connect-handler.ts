import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildGarminConnectAuthorizationUrl,
  exchangeGarminConnectCode,
  getGarminConnectSecretName,
  refreshGarminConnectToken,
} from "./garmin-connect";
export const garminConnectHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildGarminConnectAuthorizationUrl(
      clientId,
      args.redirectUri,
      args.state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const state = args.state;
    if (!state) {
      throw new Error(
        "Garmin Connect PKCE requires state for code_verifier derivation",
      );
    }
    const result = await exchangeGarminConnectCode(
      clientId,
      clientSecret,
      code,
      state,
    );
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      scopes: result.scopes,
      userInfo: {
        id: result.userInfo.id,
        username: result.userInfo.username,
        email: result.userInfo.email,
      },
    };
  },
  getClientId: (e) => {
    return e.GARMIN_CONNECT_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GARMIN_CONNECT_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getGarminConnectSecretName,
  getRefreshSecretName: () => {
    return "GARMIN_CONNECT_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshGarminConnectToken(clientId, clientSecret, args.refreshToken);
  },
};
