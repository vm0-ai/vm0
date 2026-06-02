import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGarminConnectAuthorizationUrl,
  exchangeGarminConnectCode,
  getGarminConnectSecretName,
  refreshGarminConnectToken,
} from "./garmin-connect";
export const garminConnectProvider: AuthCodeConnectorAuthProvider<"garmin-connect"> =
  {
    grant: {
      kind: "auth-code",
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
          args.authCodeGrant,
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
    },
    access: {
      kind: "refresh-token",
      getAccessSecretName: getGarminConnectSecretName,
      getRefreshSecretName: () => {
        return "GARMIN_CONNECT_REFRESH_TOKEN";
      },
      refreshToken: (args) => {
        const { clientId, clientSecret } = args;
        return refreshGarminConnectToken(
          args.tokenUrl,
          clientId,
          clientSecret,
          args.refreshToken,
          args.signal,
        );
      },
    },
    revoke: { kind: "none" },
  };
