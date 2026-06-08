import type { AuthCodeConnectorAuthProvider } from "../../types";
import { buildGmailAuthorizationUrl, exchangeGmailCode } from "./oauth";
import { refreshGoogleToken } from "../../oauth/google";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const gmailProvider: AuthCodeConnectorAuthProvider<"gmail"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildGmailAuthorizationUrl(
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
      const result = await exchangeGmailCode(
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
      const refreshToken = args.inputs.refreshToken;
      return oauthRefreshResultToProviderResult(
        await refreshGoogleToken(
          "gmail",
          clientId,
          clientSecret,
          refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: { kind: "none" },
};
