import type { AuthCodeConnectorAuthProvider } from "../../types";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import {
  buildCloudflareAuthorizationUrl,
  exchangeCloudflareCode,
  refreshCloudflareToken,
  revokeCloudflareRefreshToken,
} from "./oauth";

export const cloudflareProvider: AuthCodeConnectorAuthProvider<"cloudflare"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildCloudflareAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const result = await exchangeCloudflareCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        args.code,
        args.redirectUri,
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
        await refreshCloudflareToken(
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
    revokeToken: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      await revokeCloudflareRefreshToken(
        clientId,
        clientSecret,
        args.inputs.refreshToken,
      );
    },
  },
};
