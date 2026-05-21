import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildGarminConnectAuthorizationUrl,
  exchangeGarminConnectCode,
  getGarminConnectSecretName,
  refreshGarminConnectToken,
} from "./garmin-connect";
export const garminConnectProvider = defineConnectorOAuthProvider(
  "garmin-connect",
  {
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildGarminConnectAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
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
    getSecretName: getGarminConnectSecretName,
    getRefreshSecretName: () => {
      return "GARMIN_CONNECT_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshGarminConnectToken(
        clientId,
        clientSecret,
        args.refreshToken,
      );
    },
  },
);
