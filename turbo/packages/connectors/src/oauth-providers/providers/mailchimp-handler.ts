import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildMailchimpAuthorizationUrl,
  exchangeMailchimpCode,
  getMailchimpSecretName,
} from "./mailchimp";
export const mailchimpHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildMailchimpAuthorizationUrl(
      clientId,
      args.redirectUri,
      args.state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeMailchimpCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
    );
    return {
      accessToken: result.accessToken,
      refreshToken: null,
      scopes: result.scopes,
      userInfo: {
        id: result.userInfo.id,
        username: result.userInfo.username,
        email: result.userInfo.email,
      },
    };
  },
  getClientId: (e) => {
    return e.MAILCHIMP_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.MAILCHIMP_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getMailchimpSecretName,
};
