import type {
  ExternalCodeConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import { reportedOAuthScopes } from "../../oauth/scope";
import {
  buildPlaystationNpssoUrl,
  exchangePlaystationAccessCodeForAuthTokens,
  exchangePlaystationNpssoForAccessCode,
  fetchPlaystationIdentity,
  playstationUserInfo,
  refreshPlaystationAuthTokens,
} from "./api";

const PLAYSTATION_EXTERNAL_CODE_SESSION_EXPIRES_IN_SECONDS = 10 * 60;

function createPlaystationExternalCodeGrantProvider(): ExternalCodeConnectorAuthProvider<
  "playstation",
  "api"
>["grant"] {
  return {
    kind: "external-code",
    startExternalCodeAuthorization: async () => {
      return {
        authorizationUrl: buildPlaystationNpssoUrl(),
        providerState: JSON.stringify({ version: 1 }),
        expiresIn: PLAYSTATION_EXTERNAL_CODE_SESSION_EXPIRES_IN_SECONDS,
      };
    },
    completeExternalCodeAuthorization: async (args, signal: AbortSignal) => {
      const accessCode = await exchangePlaystationNpssoForAccessCode(
        {
          npsso: args.code,
          clientId: args.authClient.clientId,
          grant: args.externalCodeGrant,
        },
        signal,
      );
      const token = await exchangePlaystationAccessCodeForAuthTokens(
        {
          accessCode,
          clientId: args.authClient.clientId,
        },
        signal,
      );
      const identity = await fetchPlaystationIdentity(
        {
          accessToken: token.accessToken,
          idToken: token.idToken,
        },
        signal,
      );
      return {
        outputs: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          idToken: token.idToken,
          accountId: identity.accountId,
          onlineId: identity.onlineId ?? "",
        },
        expiresIn: token.expiresIn,
        scopes: args.externalCodeGrant.scopes,
        userInfo: playstationUserInfo(identity),
      };
    },
  };
}

function createPlaystationRefreshTokenAccessProvider(): RefreshTokenAccessProvider<
  "playstation",
  "api"
> {
  return {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await refreshPlaystationAuthTokens(
        {
          refreshToken: args.inputs.refreshToken,
          clientId: args.authClient.clientId,
        },
        signal,
      );
      const scopes = reportedOAuthScopes(token.scope, " ");
      return {
        outputs: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          idToken: token.idToken,
        },
        expiresIn: token.expiresIn,
        ...(scopes === null ? {} : { scopes }),
      };
    },
  };
}

export const playstationProvider = {
  grant: createPlaystationExternalCodeGrantProvider(),
  access: createPlaystationRefreshTokenAccessProvider(),
  revoke: { kind: "none" },
} as const satisfies ExternalCodeConnectorAuthProvider<"playstation", "api"> & {
  readonly access: RefreshTokenAccessProvider<"playstation", "api">;
};
