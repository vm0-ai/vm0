import type { AuthCodeConnectorAuthProvider } from "../../auth-providers/provider-types";
import {
  buildSlackAuthorizationUrl,
  exchangeSlackCode,
  fetchSlackUserInfo,
  getSlackSecretName,
  revokeSlackToken,
} from "./slack";
export const slackProvider: AuthCodeConnectorAuthProvider<"slack"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildSlackAuthorizationUrl(clientId, args.redirectUri, args.state);
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const slackResult = await exchangeSlackCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      const slackUser = await fetchSlackUserInfo(
        slackResult.userId,
        slackResult.accessToken,
      );
      return {
        accessToken: slackResult.accessToken,
        scopes: slackResult.scopes,
        userInfo: {
          id: slackUser.id,
          username: slackUser.username,
          email: slackUser.email,
        },
      };
    },
  },
  access: {
    kind: "none",
    getAccessSecretName: getSlackSecretName,
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: (args) => {
      const { clientId, clientSecret } = args;
      return revokeSlackToken(clientId, clientSecret, args.accessToken);
    },
  },
};
