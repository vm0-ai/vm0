import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import type {
  ExternalCodeConnectorAuthProvider,
  RefreshTokenAccessProvider,
  TokenRevokeProvider,
} from "../../types";
import {
  requiredConnectorGrantOutput,
  withConnectorGrantCompensation,
} from "../../grant-compensation";
import { isOAuthProviderHttpError } from "../../oauth/error";
import {
  buildNintendoSwitchParentalControlsAuthorizationUrl,
  createNintendoSwitchParentalControlsProviderState,
  exchangeNintendoSwitchParentalControlsSessionToken,
  exchangeNintendoSwitchParentalControlsSessionTokenCode,
  federateNintendoSwitchParentalControlsSmartDevice,
  fetchNintendoSwitchParentalControlsDeviceCatalog,
  fetchNintendoSwitchParentalControlsProfile,
  logoutNintendoSwitchParentalControlsSmartDevice,
  nintendoSwitchParentalControlsAccountId,
  nintendoSwitchParentalControlsUserInfo,
  parseNintendoSwitchParentalControlsProviderState,
  parseNintendoSwitchParentalControlsSessionTokenCode,
} from "./api";

const EXTERNAL_CODE_EXPIRES_IN_SECONDS = 10 * 60;

function createExternalCodeGrantProvider(): ExternalCodeConnectorAuthProvider<
  "nintendo-switch-parental-controls",
  "api"
>["grant"] {
  return {
    kind: "external-code",
    startExternalCodeAuthorization: async (args) => {
      const providerState = createNintendoSwitchParentalControlsProviderState();
      return {
        authorizationUrl: buildNintendoSwitchParentalControlsAuthorizationUrl({
          clientId: args.authClient.clientId,
          grant: args.externalCodeGrant,
          providerState,
        }),
        providerState: JSON.stringify(providerState),
        expiresIn: EXTERNAL_CODE_EXPIRES_IN_SECONDS,
      };
    },
    completeExternalCodeAuthorization: async (args) => {
      const providerState = parseNintendoSwitchParentalControlsProviderState(
        args.providerState,
      );
      const sessionTokenCode =
        parseNintendoSwitchParentalControlsSessionTokenCode({
          code: args.code,
          expectedState: providerState.state,
        });
      const session =
        await exchangeNintendoSwitchParentalControlsSessionTokenCode({
          clientId: args.authClient.clientId,
          sessionTokenCode,
          codeVerifier: providerState.codeVerifier,
          signal: args.signal,
        });
      const token = await exchangeNintendoSwitchParentalControlsSessionToken({
        clientId: args.authClient.clientId,
        sessionToken: session.sessionToken,
        signal: args.signal,
      });
      const profile = await fetchNintendoSwitchParentalControlsProfile({
        accessToken: token.accessToken,
        signal: args.signal,
      });
      const accountId = nintendoSwitchParentalControlsAccountId(token.idToken);
      const userInfo = nintendoSwitchParentalControlsUserInfo(token.idToken);
      const smartDeviceId = randomUUID();
      const deviceCatalog = await withConnectorGrantCompensation(
        () => {
          return federateNintendoSwitchParentalControlsSmartDevice({
            idToken: token.idToken,
            smartDeviceId,
            language: profile.language,
            signal: args.signal,
          });
        },
        (signal) => {
          return logoutNintendoSwitchParentalControlsSmartDevice({
            idToken: token.idToken,
            smartDeviceId,
            language: profile.language,
            signal,
          });
        },
      );
      return {
        outputs: {
          sessionToken: session.sessionToken,
          accessToken: token.accessToken,
          idToken: token.idToken,
          smartDeviceId,
          accountId,
          language: profile.language,
          deviceCatalog,
        },
        expiresIn: token.expiresIn,
        scopes:
          token.scopes.length > 0
            ? token.scopes
            : args.externalCodeGrant.scopes,
        userInfo,
      };
    },
    rollbackGrant: (args) => {
      return logoutNintendoSwitchParentalControlsSmartDevice({
        idToken: requiredConnectorGrantOutput(args.result.outputs, "idToken"),
        smartDeviceId: requiredConnectorGrantOutput(
          args.result.outputs,
          "smartDeviceId",
        ),
        language: requiredConnectorGrantOutput(args.result.outputs, "language"),
        signal: args.signal,
      });
    },
  };
}

function catalogFailureCanUseStoredValue(error: unknown): boolean {
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return (
    isOAuthProviderHttpError(error) &&
    (error.status === 429 || error.status >= 500)
  );
}

async function refreshDeviceCatalog(args: {
  readonly idToken: string;
  readonly smartDeviceId: string;
  readonly language: string;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  try {
    return await fetchNintendoSwitchParentalControlsDeviceCatalog(args);
  } catch (error) {
    args.signal.throwIfAborted();
    if (catalogFailureCanUseStoredValue(error)) {
      return undefined;
    }
    throw error;
  }
}

function createRefreshTokenAccessProvider(): RefreshTokenAccessProvider<
  "nintendo-switch-parental-controls",
  "api"
> {
  return {
    kind: "refresh-token",
    refresh: async (args) => {
      const token = await exchangeNintendoSwitchParentalControlsSessionToken({
        clientId: args.authClient.clientId,
        sessionToken: args.inputs.sessionToken,
        signal: args.signal,
      });
      const deviceCatalog = await refreshDeviceCatalog({
        idToken: token.idToken,
        smartDeviceId: args.inputs.smartDeviceId,
        language: args.inputs.language,
        signal: args.signal,
      });
      return {
        outputs: {
          accessToken: token.accessToken,
          idToken: token.idToken,
          ...(deviceCatalog === undefined ? {} : { deviceCatalog }),
        },
        expiresIn: token.expiresIn,
      };
    },
  };
}

function createTokenRevokeProvider(): TokenRevokeProvider<
  "nintendo-switch-parental-controls",
  "api"
> {
  return {
    kind: "token-revoke",
    revokeToken: async (args) => {
      const token = await exchangeNintendoSwitchParentalControlsSessionToken({
        clientId: args.authClient.clientId,
        sessionToken: args.inputs.sessionToken,
        signal: args.signal,
      });
      await logoutNintendoSwitchParentalControlsSmartDevice({
        idToken: token.idToken,
        smartDeviceId: args.inputs.smartDeviceId,
        language: "en",
        signal: args.signal,
      });
    },
  };
}

export const nintendoSwitchParentalControlsProvider = {
  grant: createExternalCodeGrantProvider(),
  access: createRefreshTokenAccessProvider(),
  revoke: createTokenRevokeProvider(),
} as const satisfies ExternalCodeConnectorAuthProvider<
  "nintendo-switch-parental-controls",
  "api"
>;
