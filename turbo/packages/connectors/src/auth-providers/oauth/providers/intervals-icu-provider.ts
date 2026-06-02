import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildIntervalsIcuAuthorizationUrl,
  exchangeIntervalsIcuCode,
  getIntervalsIcuSecretName,
} from "./intervals-icu";
export const intervalsIcuProvider: AuthCodeConnectorAuthProvider<"intervals-icu"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildIntervalsIcuAuthorizationUrl(
          args.authCodeGrant,
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const code = args.code;
        const result = await exchangeIntervalsIcuCode(
          args.authCodeGrant,
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
    },
    access: {
      kind: "none",
      getAccessSecretName: getIntervalsIcuSecretName,
    },
    revoke: { kind: "none" },
  };
