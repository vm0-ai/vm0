import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildMailchimpAuthorizationUrl,
  exchangeMailchimpCode,
  getMailchimpSecretName,
} from "./mailchimp";
export const mailchimpProvider: AuthCodeConnectorAuthProvider<"mailchimp"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildMailchimpAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
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
  },
  access: {
    kind: "none",
    getAccessSecretName: getMailchimpSecretName,
  },
  revoke: { kind: "none" },
};
