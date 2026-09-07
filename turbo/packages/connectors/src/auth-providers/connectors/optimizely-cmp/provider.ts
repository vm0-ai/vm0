import type { AuthCodeConnectorAuthProvider } from "../../types";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
import {
  buildOptimizelyCmpAuthorizationUrl,
  exchangeOptimizelyCmpCode,
  refreshOptimizelyCmpToken,
  revokeOptimizelyCmpRefreshToken,
} from "./oauth";

export const optimizelyCmpProvider: AuthCodeConnectorAuthProvider<
  "optimizely-cmp",
  "oauth"
> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildOptimizelyCmpAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const result = await exchangeOptimizelyCmpCode(
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
        await refreshOptimizelyCmpToken(
          clientId,
          clientSecret,
          args.inputs.refreshToken,
          signal,
        ),
      );
    },
  },
  revoke: {
    kind: "token-revoke",
    revokeToken: async (args, signal) => {
      const { clientId, clientSecret } = args.authClient;
      await revokeOptimizelyCmpRefreshToken(
        clientId,
        clientSecret,
        args.inputs.refreshToken,
        signal,
      );
    },
  },
};

export const optimizelyCmpClientProvider: AuthCodeConnectorAuthProvider<
  "optimizely-cmp",
  "oauth-client"
> = {
  grant: {
    ...optimizelyCmpProvider.grant,
    exchangeCode: async (args) => {
      const result = await optimizelyCmpProvider.grant.exchangeCode(args);
      return {
        ...result,
        outputs: {
          ...result.outputs,
          clientId: args.authClient.clientId,
          clientSecret: args.authClient.clientSecret,
        },
      };
    },
  },
  access: optimizelyCmpProvider.access,
  revoke: optimizelyCmpProvider.revoke,
};
