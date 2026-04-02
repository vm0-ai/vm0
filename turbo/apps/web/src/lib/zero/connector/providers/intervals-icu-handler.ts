import { type ProviderHandler } from "../provider-types";
import {
  buildIntervalsIcuAuthorizationUrl,
  exchangeIntervalsIcuCode,
  getIntervalsIcuSecretName,
} from "./intervals-icu";

export const intervalsIcuHandler: ProviderHandler = {
  buildAuthUrl: buildIntervalsIcuAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code) {
    const result = await exchangeIntervalsIcuCode(clientId, clientSecret, code);
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
    return e.INTERVALS_ICU_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.INTERVALS_ICU_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getIntervalsIcuSecretName,
};
