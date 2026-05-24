import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubCode,
  fetchGitHubUserInfo,
  getGitHubSecretName,
  revokeGitHubGrant,
} from "./github";
export const githubProvider: AuthCodeConnectorAuthProvider<"github"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildGitHubAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const { accessToken, scopes } = await exchangeGitHubCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const userInfo = await fetchGitHubUserInfo(accessToken);
      return { accessToken, scopes, userInfo };
    },
  },
  access: {
    kind: "none",
    getAccessSecretName: getGitHubSecretName,
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: (args) => {
      const { clientId, clientSecret } = args;
      return revokeGitHubGrant(clientId, clientSecret, args.accessToken);
    },
  },
};
