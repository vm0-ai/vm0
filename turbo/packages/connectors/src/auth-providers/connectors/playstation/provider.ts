import type {
  ExternalCodeConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import {
  buildPlaystationNpssoUrl,
  exchangePlaystationAccessCodeForAuthTokens,
  exchangePlaystationNpssoForAccessCode,
  exchangePlaystationNpssoForWebSessionToken,
  fetchPlaystationIdentity,
  normalizePlaystationNpsso,
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
      const npsso = normalizePlaystationNpsso(args.code);
      const accessCode = await exchangePlaystationNpssoForAccessCode(
        {
          npsso,
          clientId: args.authClient.clientId,
          grant: args.externalCodeGrant,
        },
        signal,
      );
      const [token, webSessionToken] = await Promise.all([
        exchangePlaystationAccessCodeForAuthTokens(
          {
            accessCode,
            clientId: args.authClient.clientId,
          },
          signal,
        ),
        exchangePlaystationNpssoForWebSessionToken(npsso, signal),
      ]);
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
          npsso,
          webSessionToken,
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
      const [token, webSessionToken] = await Promise.all([
        refreshPlaystationAuthTokens(
          {
            refreshToken: args.inputs.refreshToken,
            clientId: args.authClient.clientId,
          },
          signal,
        ),
        exchangePlaystationNpssoForWebSessionToken(args.inputs.npsso, signal),
      ]);
      return {
        outputs: {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          idToken: token.idToken,
          webSessionToken,
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
