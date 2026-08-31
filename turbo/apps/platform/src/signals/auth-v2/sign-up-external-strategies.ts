import type { PlatformClerk as Clerk } from "../../lib/clerk-runtime.ts";
import type {
  ClerkAPIError,
  SignInResource,
  SignUpResource,
} from "@clerk/react/types";

import type { AuthV2Navigation, AuthV2StepPath } from "./navigation.ts";
import {
  enabledAuthV2OAuthStrategies,
  type AuthV2OAuthStrategy,
} from "./oauth-strategies.ts";

export const AUTH_V2_SIGN_UP_OAUTH_CALLBACK_PATH = "/sso-callback";

export interface AuthV2SignUpExternalCapabilities {
  readonly oauthStrategies: readonly AuthV2OAuthStrategy[];
}

export type AuthV2SignUpTransferState =
  | { readonly sessionId: string; readonly status: "complete" }
  | {
      readonly status: "sign-in";
      readonly stepPath: AuthV2StepPath | null;
    };

export type AuthV2SignUpOAuthRecovery =
  | {
      readonly resource: SignUpResource;
      readonly status: "sign-up";
    }
  | {
      readonly resource: SignUpResource;
      readonly sessionId: string;
      readonly status: "complete";
    }
  | {
      readonly resource: SignInResource;
      readonly signUpResource: SignUpResource;
      readonly status: "sign-in";
      readonly stepPath: AuthV2StepPath | null;
    }
  | {
      readonly error: ClerkAPIError;
      readonly resource: SignUpResource;
      readonly status: "error";
    };

function transferSignInStepPath(
  status: SignInResource["status"],
): AuthV2StepPath | null {
  if (status === "needs_first_factor") {
    return "/factor-one";
  }
  if (status === "needs_new_password") {
    return "/reset-password";
  }
  return status === "needs_second_factor" ? "/factor-two" : null;
}

export function resolveAuthV2SignUpTransferState(
  resource: Pick<SignInResource, "createdSessionId" | "status">,
): AuthV2SignUpTransferState {
  if (resource.status === "complete" && resource.createdSessionId) {
    return {
      sessionId: resource.createdSessionId,
      status: "complete",
    };
  }
  return {
    status: "sign-in",
    stepPath: transferSignInStepPath(resource.status),
  };
}

function normalizeEmailIdentifier(identifier: string | null): string | null {
  const normalized = identifier?.trim().toLowerCase();
  return normalized || null;
}

function hasMatchingTransferProgress(
  signUp: SignUpResource,
  signIn: SignInResource,
): boolean {
  const signUpIdentifier = normalizeEmailIdentifier(signUp.emailAddress);
  return (
    signIn.status !== null &&
    signIn.status !== "needs_identifier" &&
    signUpIdentifier !== null &&
    normalizeEmailIdentifier(signIn.identifier) === signUpIdentifier
  );
}

export function discoverAuthV2SignUpExternalCapabilities(
  clerk: Clerk,
  resource: SignUpResource,
): AuthV2SignUpExternalCapabilities {
  const strategies =
    clerk.__internal_environment?.userSettings.authenticatableSocialStrategies;
  return {
    oauthStrategies:
      typeof resource.authenticateWithRedirect === "function"
        ? enabledAuthV2OAuthStrategies(strategies)
        : [],
  };
}

export function startAuthV2OAuthSignUp(
  resource: SignUpResource,
  navigation: AuthV2Navigation,
  legalAccepted: boolean,
  strategy: AuthV2OAuthStrategy,
): Promise<void> {
  return resource.authenticateWithRedirect({
    continueSignUp: false,
    ...(legalAccepted ? { legalAccepted: true } : {}),
    redirectUrl: navigation.href(
      "sign-up",
      AUTH_V2_SIGN_UP_OAUTH_CALLBACK_PATH,
    ),
    redirectUrlComplete: navigation.completionRedirectUrl,
    strategy,
  });
}

export async function recoverAuthV2OAuthSignUp(
  clerk: Clerk,
): Promise<AuthV2SignUpOAuthRecovery> {
  const client = clerk.client;
  if (!client) {
    throw new Error("Loaded Clerk instance did not provide a client resource");
  }
  const signUp = await client.signUp.reload();
  const externalAccount = signUp.verifications.externalAccount;
  if (
    externalAccount.status === "transferable" &&
    externalAccount.error?.code === "external_account_exists"
  ) {
    const signIn = hasMatchingTransferProgress(signUp, client.signIn)
      ? client.signIn
      : await client.signIn.create({ transfer: true });
    const transfer = resolveAuthV2SignUpTransferState(signIn);
    return transfer.status === "complete"
      ? {
          resource: signUp,
          sessionId: transfer.sessionId,
          status: "complete",
        }
      : {
          resource: signIn,
          signUpResource: signUp,
          status: "sign-in",
          stepPath: transfer.stepPath,
        };
  }

  const existingSessionId =
    externalAccount.error?.code === "identifier_already_signed_in"
      ? externalAccount.error.meta?.sessionId
      : null;
  if (existingSessionId) {
    return {
      resource: signUp,
      sessionId: existingSessionId,
      status: "complete",
    };
  }
  if (externalAccount.error) {
    return {
      error: externalAccount.error,
      resource: signUp,
      status: "error",
    };
  }
  return { resource: signUp, status: "sign-up" };
}
