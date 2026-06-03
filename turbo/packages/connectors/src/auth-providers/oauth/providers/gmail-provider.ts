import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGmailAuthorizationUrl,
  exchangeGmailCode,
  getGmailSecretName,
} from "./gmail";
import { refreshGoogleToken } from "../google";
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
      const { clientId, clientSecret } = args.authClient;
      const refreshToken = args.refreshToken;
      return refreshGoogleToken(
        "gmail",
        clientId,
        clientSecret,
        refreshToken,
        args.signal,
      );
    },
  },
  revoke: { kind: "none" },
};
