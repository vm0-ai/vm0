import { z } from "zod";

import type {
  ExternalCodeConnectorAuthProvider,
  RefreshTokenAccessProvider,
} from "../../types";
import {
  buildNintendoPlayActivityAuthorizationUrl,
  createNintendoPlayActivityProviderState,
  exchangeNintendoPlayActivitySessionToken,
  exchangeNintendoPlayActivitySessionTokenCode,
  nintendoPlayActivityAccountId,
  nintendoPlayActivityUserInfo,
  parseNintendoPlayActivitySessionTokenCode,
} from "./api";

const NINTENDO_PLAY_ACTIVITY_EXTERNAL_CODE_EXPIRES_IN_SECONDS = 10 * 60;

const nintendoPlayActivityProviderStateSchema = z.object({
  version: z.literal(1),
  state: z.string().min(1).max(128),
  codeVerifier: z.string().min(43).max(128),
});

function parseNintendoPlayActivityProviderState(providerState: string) {
  const parsed: unknown = JSON.parse(providerState);
  return nintendoPlayActivityProviderStateSchema.parse(parsed);
}

function createNintendoPlayActivityExternalCodeGrantProvider(): ExternalCodeConnectorAuthProvider<
  "nintendo-play-activity",
  "api"
>["grant"] {
  return {
    kind: "external-code",
    startExternalCodeAuthorization: async (args) => {
      const providerState = createNintendoPlayActivityProviderState();
      return {
        authorizationUrl: buildNintendoPlayActivityAuthorizationUrl({
          clientId: args.authClient.clientId,
          grant: args.externalCodeGrant,
          providerState,
        }),
        providerState: JSON.stringify(providerState),
        expiresIn: NINTENDO_PLAY_ACTIVITY_EXTERNAL_CODE_EXPIRES_IN_SECONDS,
      };
    },
    completeExternalCodeAuthorization: async (args) => {
      const providerState = parseNintendoPlayActivityProviderState(
        args.providerState,
      );
      const sessionTokenCode = parseNintendoPlayActivitySessionTokenCode({
        code: args.code,
        expectedState: providerState.state,
      });
      const session = await exchangeNintendoPlayActivitySessionTokenCode({
        clientId: args.authClient.clientId,
        sessionTokenCode,
        codeVerifier: providerState.codeVerifier,
        signal: args.signal,
      });
      const token = await exchangeNintendoPlayActivitySessionToken({
        clientId: args.authClient.clientId,
        sessionToken: session.sessionToken,
        signal: args.signal,
      });
      return {
        outputs: {
          sessionToken: session.sessionToken,
          accessToken: token.accessToken,
          idToken: token.idToken,
          accountId: nintendoPlayActivityAccountId(token.idToken),
        },
        expiresIn: token.expiresIn,
        scopes:
          token.scopes.length > 0
            ? token.scopes
            : args.externalCodeGrant.scopes,
        userInfo: nintendoPlayActivityUserInfo(token.idToken),
      };
    },
  };
}

function createNintendoPlayActivityRefreshTokenAccessProvider(): RefreshTokenAccessProvider<
  "nintendo-play-activity",
  "api"
> {
  return {
    kind: "refresh-token",
    refresh: async (args) => {
      const token = await exchangeNintendoPlayActivitySessionToken({
        clientId: args.authClient.clientId,
        sessionToken: args.inputs.sessionToken,
        signal: args.signal,
      });
      return {
        outputs: {
          accessToken: token.accessToken,
          idToken: token.idToken,
        },
        expiresIn: token.expiresIn,
      };
    },
  };
}

export const nintendoPlayActivityProvider = {
  grant: createNintendoPlayActivityExternalCodeGrantProvider(),
  access: createNintendoPlayActivityRefreshTokenAccessProvider(),
  revoke: { kind: "none" },
} as const satisfies ExternalCodeConnectorAuthProvider<
  "nintendo-play-activity",
  "api"
> & {
  readonly access: RefreshTokenAccessProvider<"nintendo-play-activity", "api">;
};
