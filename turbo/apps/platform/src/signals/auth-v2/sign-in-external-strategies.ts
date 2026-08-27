import type { Clerk } from "@clerk/clerk-js";
import type { SignInResource } from "@clerk/react/types";

import { createDeferredPromise, settle, withCleanup } from "../utils.ts";
import type { AuthV2Navigation } from "./navigation.ts";
import {
  enabledAuthV2OAuthStrategies,
  isAuthV2OAuthStrategy,
  type AuthV2OAuthStrategy,
} from "./oauth-strategies.ts";

const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
export const AUTH_V2_OAUTH_CALLBACK_PATH = "/sso-callback";

export interface AuthV2ExternalCapabilities {
  readonly googleOneTapClientId: string | null;
  readonly identifierMode: "email" | "email-or-username" | "username";
  readonly lastUsedOAuthStrategy: AuthV2OAuthStrategy | null;
  readonly oauthStrategies: readonly AuthV2OAuthStrategy[];
  readonly passkey: boolean;
}

export interface AuthV2ExistingAccount {
  readonly displayName: string;
  readonly identifier: string | null;
  readonly sessionId: string;
}

interface GoogleCredentialResponse {
  readonly credential?: string;
}

interface GooglePromptMomentNotification {
  getMomentType(): "dismissed" | "display" | "skipped";
}

interface GoogleIdentityApi {
  cancel(): void;
  initialize(options: {
    readonly auto_select: boolean;
    readonly callback: (response: GoogleCredentialResponse) => void;
    readonly cancel_on_tap_outside: boolean;
    readonly client_id: string;
    readonly itp_support: boolean;
    readonly use_fedcm_for_prompt: boolean;
  }): void;
  prompt(
    callback: (notification: GooglePromptMomentNotification) => void,
  ): void;
}

interface GoogleIdentityServices {
  readonly accounts?: {
    readonly id?: GoogleIdentityApi;
  };
}

type GoogleWindow = Window & { readonly google?: GoogleIdentityServices };

function googleIdentityApi(): GoogleIdentityApi | null {
  return (window as GoogleWindow).google?.accounts?.id ?? null;
}

function loadGoogleIdentityApi(
  signal: AbortSignal,
): Promise<GoogleIdentityApi> {
  signal.throwIfAborted();
  const loadedApi = googleIdentityApi();
  if (loadedApi) {
    return Promise.resolve(loadedApi);
  }

  const existingScript = document.querySelector<HTMLScriptElement>(
    "script[data-auth-v2-google-one-tap]",
  );
  const script = existingScript ?? document.createElement("script");
  if (!existingScript) {
    script.async = true;
    script.dataset.authV2GoogleOneTap = "true";
    script.src = GOOGLE_IDENTITY_SCRIPT_URL;
  }

  const deferred = createDeferredPromise<GoogleIdentityApi>(signal);
  const handleLoad = (): void => {
    const api = googleIdentityApi();
    if (api) {
      deferred.resolve(api);
      return;
    }
    deferred.reject(new Error("Google Identity Services did not initialize"));
  };
  const handleError = (): void => {
    deferred.reject(new Error("Google Identity Services could not be loaded"));
  };
  const cleanup = (): void => {
    script.removeEventListener("load", handleLoad);
    script.removeEventListener("error", handleError);
    if (!googleIdentityApi()) {
      script.remove();
    }
  };

  script.addEventListener("load", handleLoad, { once: true });
  script.addEventListener("error", handleError, { once: true });
  if (!existingScript) {
    document.head.appendChild(script);
  }
  return withCleanup(deferred.promise, cleanup);
}

async function startGoogleOneTapPrompt(
  api: GoogleIdentityApi,
  clientId: string,
  finish: (credential: string | null) => void,
  signal: AbortSignal,
): Promise<void> {
  await Promise.resolve();
  signal.throwIfAborted();
  api.initialize({
    auto_select: false,
    callback: (response) => {
      finish(response.credential ?? null);
    },
    cancel_on_tap_outside: true,
    client_id: clientId,
    itp_support: true,
    use_fedcm_for_prompt: true,
  });
  api.prompt((notification) => {
    const momentType = notification.getMomentType();
    if (momentType === "dismissed" || momentType === "skipped") {
      finish(null);
    }
  });
}

export function discoverAuthV2ExternalCapabilities(
  clerk: Clerk,
): AuthV2ExternalCapabilities {
  const environment = clerk.__internal_environment;
  const settings = environment?.userSettings;
  const oauthStrategies = enabledAuthV2OAuthStrategies(
    settings?.authenticatableSocialStrategies,
  );
  const emailEnabled = settings?.attributes.email_address.enabled === true;
  const usernameEnabled = settings?.attributes.username.enabled === true;
  const identifierMode =
    emailEnabled && usernameEnabled
      ? "email-or-username"
      : usernameEnabled
        ? "username"
        : "email";
  const passkeyAttribute = settings?.attributes.passkey;
  const passkey =
    passkeyAttribute?.enabled === true &&
    passkeyAttribute.used_for_first_factor === true &&
    settings?.passkeySettings.show_sign_in_button === true;
  const googleOneTapClientId = oauthStrategies.includes("oauth_google")
    ? (environment?.displayConfig.googleOneTapClientId ?? null)
    : null;
  const lastAuthenticationStrategy = clerk.client?.lastAuthenticationStrategy;
  const lastUsedOAuthStrategy =
    typeof lastAuthenticationStrategy === "string" &&
    isAuthV2OAuthStrategy(lastAuthenticationStrategy)
      ? lastAuthenticationStrategy
      : null;
  return {
    googleOneTapClientId,
    identifierMode,
    lastUsedOAuthStrategy,
    oauthStrategies,
    passkey,
  };
}

export function discoverAuthV2ExistingAccounts(
  clerk: Clerk,
): readonly AuthV2ExistingAccount[] {
  return (clerk.client?.signedInSessions ?? []).map((session) => {
    const emailAddress = session.user.primaryEmailAddress?.emailAddress ?? null;
    const displayName =
      session.user.fullName ??
      emailAddress ??
      session.user.username ??
      "Account";
    return {
      displayName,
      identifier: emailAddress,
      sessionId: session.id,
    };
  });
}

export function startAuthV2OAuth(
  resource: SignInResource,
  navigation: AuthV2Navigation,
  strategy: AuthV2OAuthStrategy,
): Promise<void> {
  // Starting fresh matches Clerk's hosted flow and prevents a failed attempt
  // from being reused when the user tries an OAuth provider again.
  return resource.authenticateWithRedirect({
    redirectUrl: navigation.href("sign-in", AUTH_V2_OAUTH_CALLBACK_PATH),
    redirectUrlComplete: navigation.completionRedirectUrl,
    strategy,
  });
}

export async function recoverAuthV2OAuth(
  clerk: Clerk,
  navigation: AuthV2Navigation,
): Promise<string | null> {
  await clerk.handleRedirectCallback({
    continueSignUpUrl: null,
    firstFactorUrl: navigation.href("sign-in", "/factor-one"),
    reloadResource: "signIn",
    resetPasswordUrl: navigation.href("sign-in", "/reset-password"),
    secondFactorUrl: navigation.href("sign-in", "/factor-two"),
    signInFallbackRedirectUrl: navigation.completionRedirectUrl,
    signInForceRedirectUrl: navigation.completionRedirectUrl,
    signInUrl: navigation.href("sign-in"),
    signUpUrl: navigation.href("sign-up"),
    transferable: false,
    verifyEmailAddressUrl: null,
    verifyPhoneNumberUrl: null,
  });

  const resource = clerk.client?.signIn;
  return resource?.status === "complete" ? resource.createdSessionId : null;
}

export async function requestGoogleOneTapCredential(
  clientId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const api = await loadGoogleIdentityApi(signal);
  signal.throwIfAborted();
  const credential = createDeferredPromise<string | null>(signal);
  const finish = (value: string | null): void => {
    if (!credential.settled()) {
      credential.resolve(value);
    }
  };
  const handleAbort = (): void => {
    api.cancel();
  };
  signal.addEventListener("abort", handleAbort, { once: true });

  const prompt = await settle(
    startGoogleOneTapPrompt(api, clientId, finish, signal),
    signal,
  );
  if (!prompt.ok && !credential.settled()) {
    credential.reject(prompt.error);
  }
  return withCleanup(credential.promise, () => {
    signal.removeEventListener("abort", handleAbort);
  });
}
