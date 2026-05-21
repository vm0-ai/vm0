import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildAirtableAuthorizationUrl,
  exchangeAirtableCode,
  getAirtableSecretName,
  refreshAirtableToken,
} from "./airtable";
export const airtableProvider = defineConnectorOAuthProvider("airtable", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildAirtableAuthorizationUrl(
      clientId,
      args.redirectUri,
      args.state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const codeVerifier = args.codeVerifier;
    const result = await exchangeAirtableCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
      codeVerifier,
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
  getSecretName: getAirtableSecretName,
  getRefreshSecretName: () => {
    return "AIRTABLE_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshAirtableToken(clientId, clientSecret, args.refreshToken);
  },
});
