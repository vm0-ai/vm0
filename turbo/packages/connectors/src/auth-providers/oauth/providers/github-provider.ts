import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubCode,
  fetchGitHubUserInfo,
  revokeGitHubGrant,
} from "./github";
export const githubProvider: AuthCodeConnectorAuthProvider<"github"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildGitHubAuthorizationUrl(
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
      const { accessToken, scopes } = await exchangeGitHubCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const userInfo = await fetchGitHubUserInfo(accessToken);
      return { outputs: { accessToken }, scopes, userInfo };
    },
  },
  access: {
    kind: "none",
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: (args) => {
      const { clientId, clientSecret } = args.authClient;
      return revokeGitHubGrant(clientId, clientSecret, args.inputs.accessToken);
    },
  },
};
