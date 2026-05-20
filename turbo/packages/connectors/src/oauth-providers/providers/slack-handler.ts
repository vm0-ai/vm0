import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRevocation,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildSlackAuthorizationUrl,
  exchangeSlackCode,
  fetchSlackUserInfo,
  getSlackSecretName,
  revokeSlackToken,
} from "./slack";
export const slackHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildSlackAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
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
  ),
  getClientId: (e) => {
    return e.SLACK_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.SLACK_CLIENT_SECRET;
  },
  getSecretName: getSlackSecretName,
  revokeToken: adaptClientCredentialTokenRevocation(revokeSlackToken),
};
