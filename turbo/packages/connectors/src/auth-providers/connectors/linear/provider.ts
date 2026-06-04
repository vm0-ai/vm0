import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildLinearAuthorizationUrl,
  exchangeLinearCode,
  refreshLinearToken,
  revokeLinearToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const linearProvider: AuthCodeConnectorAuthProvider<"linear"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildLinearAuthorizationUrl(
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
      const result = await exchangeLinearCode(
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
          username: result.userInfo.name,
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
        await refreshLinearToken(
          clientId,
          clientSecret,
          args.inputs.refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: (args) => {
      const { clientId, clientSecret } = args.authClient;
      return revokeLinearToken(clientId, clientSecret, args.inputs.accessToken);
    },
  },
};
