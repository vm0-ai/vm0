import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildDocuSignAuthorizationUrl,
  exchangeDocuSignCode,
  getDocuSignSecretName,
  refreshDocuSignToken,
} from "./docusign";
export const docusignProvider: AuthCodeConnectorAuthProvider<"docusign"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildDocuSignAuthorizationUrl(
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
      const state = args.state;
      if (!state) {
        throw new Error(
          "DocuSign PKCE requires state for code_verifier derivation",
        );
      }
      const result = await exchangeDocuSignCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
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
    getAccessSecretName: getDocuSignSecretName,
    getRefreshSecretName: () => {
      return "DOCUSIGN_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args.authClient;
      return refreshDocuSignToken(
        clientId,
        clientSecret,
        args.refreshToken,
        args.signal,
      );
    },
  },
  revoke: { kind: "none" },
};
