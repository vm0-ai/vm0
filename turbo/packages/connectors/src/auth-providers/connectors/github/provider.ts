import type { AuthCodeConnectorAuthProvider } from "../../types";
import { requiredConnectorGrantOutput } from "../../grant-compensation";
import {
  buildGitHubAuthorizationUrl,
  exchangeGitHubGrant,
  revokeGitHubGrant,
  revokeGitHubToken,
} from "./oauth";
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
      return await exchangeGitHubGrant({
        authCodeGrant: args.authCodeGrant,
        clientId,
        clientSecret,
        code: args.code,
        redirectUri: args.redirectUri,
      });
    },
    rollbackGrant: (args) => {
      const { clientId, clientSecret } = args.authClient;
      return revokeGitHubToken(
        clientId,
        clientSecret,
        requiredConnectorGrantOutput(args.result.outputs, "accessToken"),
        args.signal,
      );
    },
  },
  access: {
    kind: "none",
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: (args) => {
      const { clientId, clientSecret } = args.authClient;
      return revokeGitHubGrant(
        clientId,
        clientSecret,
        args.inputs.accessToken,
        args.signal,
      );
    },
  },
};
