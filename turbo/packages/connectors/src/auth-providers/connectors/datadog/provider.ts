import type { AuthCodeConnectorAuthProvider } from "../../types";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import {
  buildDatadogAuthorizationUrl,
  exchangeDatadogCode,
  refreshDatadogToken,
} from "./oauth";

export const datadogProvider: AuthCodeConnectorAuthProvider<
  "datadog",
  "oauth"
> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      return buildDatadogAuthorizationUrl(
        args.authCodeGrant,
        args.authClient.clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const result = await exchangeDatadogCode({
        grant: args.authCodeGrant,
        clientId: args.authClient.clientId,
        clientSecret: args.authClient.clientSecret,
        code: args.code,
        redirectUri: args.redirectUri,
        codeVerifier: args.codeVerifier,
        oauthContext: args.oauthContext,
      });
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          domain: result.domain,
        },
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: { id: result.domain, username: result.domain, email: null },
      };
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args) => {
      return oauthRefreshResultToProviderResult(
        await refreshDatadogToken({
          clientId: args.authClient.clientId,
          clientSecret: args.authClient.clientSecret,
          refreshToken: args.inputs.refreshToken,
          domain: args.inputs.domain,
          signal: args.signal,
        }),
      );
    },
  },
  revoke: { kind: "none" },
};
