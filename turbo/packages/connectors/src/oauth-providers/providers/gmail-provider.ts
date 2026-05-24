import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildGmailAuthorizationUrl,
  exchangeGmailCode,
  getGmailSecretName,
} from "./gmail";
import { refreshGoogleToken } from "./google-oauth";
export const gmailProvider: AuthCodeConnectorAuthProvider<"gmail"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildGmailAuthorizationUrl(clientId, args.redirectUri, args.state);
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeGmailCode(
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
          username: result.userInfo.name,
          email: result.userInfo.email,
        },
      };
    },
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: getGmailSecretName,
    getRefreshSecretName: () => {
      return "GMAIL_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      const refreshToken = args.refreshToken;
      return refreshGoogleToken("gmail", clientId, clientSecret, refreshToken);
    },
  },
  revoke: { kind: "none" },
};
