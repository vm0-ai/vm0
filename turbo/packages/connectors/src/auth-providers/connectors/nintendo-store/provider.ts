import type {
  ExternalCodeConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import {
  buildNintendoStoreAuthorizationUrl,
  createNintendoStoreProviderState,
  exchangeNintendoStoreSessionToken,
  exchangeNintendoStoreSessionTokenCode,
  fetchNintendoStoreLocale,
  nintendoStoreAccountId,
  nintendoStoreUserInfo,
  parseNintendoStoreProviderState,
  parseNintendoStoreSessionTokenCode,
} from "./api";

const NINTENDO_STORE_EXTERNAL_CODE_EXPIRES_IN_SECONDS = 10 * 60;

function createNintendoStoreExternalCodeGrantProvider(): ExternalCodeConnectorAuthProvider<
  "nintendo-store",
  "api"
>["grant"] {
  return {
    kind: "external-code",
    startExternalCodeAuthorization: async (args) => {
      const providerState = createNintendoStoreProviderState();
      return {
        authorizationUrl: buildNintendoStoreAuthorizationUrl({
          clientId: args.authClient.clientId,
          grant: args.externalCodeGrant,
          providerState,
        }),
        providerState: JSON.stringify(providerState),
        expiresIn: NINTENDO_STORE_EXTERNAL_CODE_EXPIRES_IN_SECONDS,
      };
    },
    completeExternalCodeAuthorization: async (args, signal: AbortSignal) => {
      const providerState = parseNintendoStoreProviderState(args.providerState);
      const sessionTokenCode = parseNintendoStoreSessionTokenCode({
        code: args.code,
        expectedState: providerState.state,
      });
      const session = await exchangeNintendoStoreSessionTokenCode(
        {
          clientId: args.authClient.clientId,
          sessionTokenCode,
          codeVerifier: providerState.codeVerifier,
        },
        signal,
      );
      const token = await exchangeNintendoStoreSessionToken(
        {
          clientId: args.authClient.clientId,
          sessionToken: session.sessionToken,
        },
        signal,
      );
      const locale = await fetchNintendoStoreLocale(
        {
          accessToken: token.accessToken,
        },
        signal,
      );
      return {
        outputs: {
          sessionToken: session.sessionToken,
          accessToken: token.accessToken,
          idToken: token.idToken,
          accountId: nintendoStoreAccountId(token.idToken),
          locale: locale.locale,
        },
        expiresIn: token.expiresIn,
        scopes:
          token.scopes !== null && token.scopes.length > 0
            ? token.scopes
            : args.externalCodeGrant.scopes,
        userInfo: nintendoStoreUserInfo(token.idToken),
      };
    },
  };
}

function createNintendoStoreRefreshTokenAccessProvider(): RefreshTokenAccessProvider<
  "nintendo-store",
  "api"
> {
  return {
    kind: "refresh-token",
    refresh: async (args, signal: AbortSignal) => {
      const token = await exchangeNintendoStoreSessionToken(
        {
          clientId: args.authClient.clientId,
          sessionToken: args.inputs.sessionToken,
        },
        signal,
      );
      const locale = await fetchNintendoStoreLocale(
        {
          accessToken: token.accessToken,
        },
        signal,
      );
      return {
        outputs: {
          accessToken: token.accessToken,
          idToken: token.idToken,
          locale: locale.locale,
        },
        expiresIn: token.expiresIn,
        ...(token.scopes === null ? {} : { scopes: token.scopes }),
      };
    },
  };
}

export const nintendoStoreProvider = {
  grant: createNintendoStoreExternalCodeGrantProvider(),
  access: createNintendoStoreRefreshTokenAccessProvider(),
  revoke: { kind: "none" },
} as const satisfies ExternalCodeConnectorAuthProvider<
  "nintendo-store",
  "api"
> & {
  readonly access: RefreshTokenAccessProvider<"nintendo-store", "api">;
};
