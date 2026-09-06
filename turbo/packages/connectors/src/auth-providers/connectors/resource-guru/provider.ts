import type { AuthCodeConnectorAuthProvider } from "../../types";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import {
  buildResourceGuruAuthorizationUrl,
  exchangeResourceGuruCode,
  refreshResourceGuruToken,
} from "./oauth";

export const resourceGuruProvider: AuthCodeConnectorAuthProvider<"resource-guru"> =
  {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return buildResourceGuruAuthorizationUrl(
          args.authCodeGrant,
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const result = await exchangeResourceGuruCode(
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
          userInfo: result.userInfo,
        };
      },
    },
    access: {
      kind: "refresh-token",
      refresh: async (args, signal) => {
        const { clientId, clientSecret } = args.authClient;
        return oauthRefreshResultToProviderResult(
          await refreshResourceGuruToken(
            clientId,
            clientSecret,
            args.inputs.refreshToken,
            signal,
          ),
        );
      },
    },
    revoke: { kind: "none" },
  };
