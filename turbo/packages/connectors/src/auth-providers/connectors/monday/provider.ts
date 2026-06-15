import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildMondayAuthorizationUrl,
  exchangeMondayCode,
  refreshMondayToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const mondayProvider: AuthCodeConnectorAuthProvider<"monday"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildMondayAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeMondayCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
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
        await refreshMondayToken(
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
