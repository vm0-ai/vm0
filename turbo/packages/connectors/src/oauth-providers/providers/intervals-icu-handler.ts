import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildIntervalsIcuAuthorizationUrl,
  exchangeIntervalsIcuCode,
  getIntervalsIcuSecretName,
} from "./intervals-icu";
export const intervalsIcuHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildIntervalsIcuAuthorizationUrl(
      clientId,
      args.redirectUri,
      args.state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
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
