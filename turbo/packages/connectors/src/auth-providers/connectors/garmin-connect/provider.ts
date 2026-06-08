import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGarminConnectAuthorizationUrl,
  exchangeGarminConnectCode,
  refreshGarminConnectToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const garminConnectProvider: AuthCodeConnectorAuthProvider<"garmin-connect"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildGarminConnectAuthorizationUrl(
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
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
          outputs: {
            accessToken: result.accessToken,
            refreshToken: result.refreshToken,
          },
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
      refresh: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        return oauthRefreshResultToProviderResult(
          await refreshGarminConnectToken(
            clientId,
            clientSecret,
            args.inputs.refreshToken,
            args.signal,
          ),
        );
      },
    },
    revoke: { kind: "none" },
  };
