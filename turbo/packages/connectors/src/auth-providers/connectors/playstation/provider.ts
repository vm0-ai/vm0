import type {
  ExternalCodeConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import {
  buildPlaystationNpssoUrl,
  exchangePlaystationAccessCodeForAuthTokens,
  exchangePlaystationNpssoForAccessCode,
  fetchPlaystationIdentity,
  playstationUserInfo,
  refreshPlaystationAuthTokens,
} from "./oauth";

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
    completeExternalCodeAuthorization: async (args) => {
      const accessCode = await exchangePlaystationNpssoForAccessCode({
        npsso: args.code,
        clientId: args.authClient.clientId,
        grant: args.externalCodeGrant,
        signal: args.signal,
      });
      const token = await exchangePlaystationAccessCodeForAuthTokens({
        accessCode,
        signal: args.signal,
      });
      const identity = await fetchPlaystationIdentity({
        accessToken: token.accessToken,
        idToken: token.idToken,
        signal: args.signal,
      });
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
    refresh: async (args) => {
      const token = await refreshPlaystationAuthTokens({
        refreshToken: args.inputs.refreshToken,
        signal: args.signal,
      });
      return {
        outputs: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          idToken: token.idToken,
        },
        expiresIn: token.expiresIn,
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
