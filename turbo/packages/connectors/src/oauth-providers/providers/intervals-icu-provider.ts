import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildIntervalsIcuAuthorizationUrl,
  exchangeIntervalsIcuCode,
  getIntervalsIcuSecretName,
} from "./intervals-icu";
export const intervalsIcuProvider = defineConnectorOAuthProvider(
  "intervals-icu",
  {
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildIntervalsIcuAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const result = await exchangeIntervalsIcuCode(
        clientId,
        clientSecret,
        code,
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
    getSecretName: getIntervalsIcuSecretName,
  },
);
