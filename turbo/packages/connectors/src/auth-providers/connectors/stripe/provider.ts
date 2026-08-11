import type {
  AuthCodeConnectorAuthProvider,
  DeviceAuthConnectorAuthProvider,
} from "../../types";
import {
  buildStripeAppsAuthorizationUrl,
  buildStripeAuthorizationUrl,
  exchangeStripeAppsCode,
  exchangeStripeCode,
  refreshStripeAppsToken,
  refreshStripeToken,
} from "./oauth";
import { pollStripeCliDashboardAuth, startStripeCliDashboardAuth } from "./cli";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

interface StripeOAuthOperations {
  readonly buildAuthorizationUrl: typeof buildStripeAuthorizationUrl;
  readonly exchangeCode: typeof exchangeStripeCode;
  readonly refreshToken: typeof refreshStripeToken;
}

function stripeOAuthProvider(
  operations: StripeOAuthOperations,
): AuthCodeConnectorAuthProvider<"stripe"> {
  return {
    grant: {
      kind: "auth-code",
      buildAuthUrl: (args) => {
        const { clientId } = args.authClient;
        return operations.buildAuthorizationUrl(
          args.authCodeGrant,
          clientId,
          args.redirectUri,
          args.state,
        );
      },
      exchangeCode: async (args) => {
        const { clientId, clientSecret } = args.authClient;
        const code = args.code;
        const result = await operations.exchangeCode(
          args.authCodeGrant,
          clientId,
          clientSecret,
          code,
        );
        return {
          outputs: {
            accessToken: result.accessToken,
            livemode: result.livemode ? "true" : "false",
            refreshToken: result.refreshToken,
          },
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
      refresh: async (args, signal: AbortSignal) => {
        const { clientId, clientSecret } = args.authClient;
        return oauthRefreshResultToProviderResult(
          await operations.refreshToken(
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
}

export const stripeProvider = stripeOAuthProvider({
  buildAuthorizationUrl: buildStripeAuthorizationUrl,
  exchangeCode: exchangeStripeCode,
  refreshToken: refreshStripeToken,
});

export const stripeAppsProvider = stripeOAuthProvider({
  buildAuthorizationUrl: buildStripeAppsAuthorizationUrl,
  exchangeCode: exchangeStripeAppsCode,
  refreshToken: refreshStripeAppsToken,
});

export const stripeCliProvider: DeviceAuthConnectorAuthProvider<
  "stripe",
  "cli"
> = {
  grant: {
    kind: "device-auth",
    startDeviceAuth: async (args) => {
      return await startStripeCliDashboardAuth({
        options: args.options,
      });
    },
    pollDeviceAuth: async (args) => {
      return await pollStripeCliDashboardAuth({
        pollState: args.pollState,
      });
    },
  },
  access: {
    kind: "none",
  },
  revoke: { kind: "none" },
};
