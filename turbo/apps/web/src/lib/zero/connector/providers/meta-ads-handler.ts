import { type ProviderHandler } from "../provider-types";
import {
  buildMetaAdsAuthorizationUrl,
  exchangeMetaAdsCode,
  getMetaAdsSecretName,
} from "./meta-ads";

export const metaAdsHandler: ProviderHandler = {
  buildAuthUrl: buildMetaAdsAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeMetaAdsCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
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
    return e.META_ADS_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.META_ADS_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getMetaAdsSecretName,
};
