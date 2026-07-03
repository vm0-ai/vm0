import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildBoxAuthorizationUrl,
  exchangeBoxCode,
  refreshBoxToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

export const boxProvider: AuthCodeConnectorAuthProvider<"box"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildBoxAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const result = await exchangeBoxCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        args.code,
        args.redirectUri,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
        expiresIn: result.expiresIn,
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
    kind: "refresh-token",
    refresh: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      return oauthRefreshResultToProviderResult(
        await refreshBoxToken(
          clientId,
          clientSecret,
          args.inputs.refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: { kind: "none" },
};
