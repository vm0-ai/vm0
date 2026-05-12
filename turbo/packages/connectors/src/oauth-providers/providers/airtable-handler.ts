import { type ProviderHandler } from "../provider-types";
import {
  buildAirtableAuthorizationUrl,
  exchangeAirtableCode,
  getAirtableSecretName,
  refreshAirtableToken,
} from "./airtable";

export const airtableHandler: ProviderHandler = {
  buildAuthUrl: buildAirtableAuthorizationUrl,
  async exchangeCode(
    clientId,
    clientSecret,
    code,
    redirectUri,
    _state,
    codeVerifier,
  ) {
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
  getClientId: (e) => {
    return e.AIRTABLE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.AIRTABLE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getAirtableSecretName,
  getRefreshSecretName: () => {
    return "AIRTABLE_REFRESH_TOKEN";
  },
  refreshToken: refreshAirtableToken,
};
