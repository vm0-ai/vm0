import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
  refreshNotionToken,
} from "./notion";
import { oauthRefreshResultToProviderResult } from "../types";
export const notionProvider: AuthCodeConnectorAuthProvider<"notion"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildNotionAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeNotionCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: result.userInfo,
      };
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      return oauthRefreshResultToProviderResult(
        await refreshNotionToken(
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
