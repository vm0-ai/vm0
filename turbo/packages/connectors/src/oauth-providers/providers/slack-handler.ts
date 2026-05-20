import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
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
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildSlackAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
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
  getClientId: (e) => {
    return e.SLACK_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.SLACK_CLIENT_SECRET;
  },
  getSecretName: getSlackSecretName,
  revokeToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return revokeSlackToken(clientId, clientSecret, args.accessToken);
  },
};
