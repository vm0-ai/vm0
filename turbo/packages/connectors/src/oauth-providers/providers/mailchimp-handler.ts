import {
  adaptClientCredentialCodeExchange,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildMailchimpAuthorizationUrl,
  exchangeMailchimpCode,
  getMailchimpSecretName,
} from "./mailchimp";
export const mailchimpHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildMailchimpAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
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
  ),
  getClientId: (e) => {
    return e.MAILCHIMP_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.MAILCHIMP_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getMailchimpSecretName,
};
