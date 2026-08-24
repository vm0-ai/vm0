import type { Clerk } from "@clerk/clerk-js";
import type { SignInResource } from "@clerk/react/types";

import { createDeferredPromise, settle, withCleanup } from "../utils.ts";
import type { AuthV2Navigation } from "./navigation.ts";

const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const GOOGLE_OAUTH_STRATEGY = "oauth_google" as const;

export const AUTH_V2_OAUTH_CALLBACK_PATH = "/sso-callback";

export interface AuthV2ExternalCapabilities {
  readonly googleOAuth: boolean;
  readonly googleOneTapClientId: string | null;
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
  isDismissedMoment(): boolean;
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
}

interface GoogleIdentityApi {
  cancel(): void;
  initialize(options: {
    readonly auto_select: boolean;
    readonly callback: (response: GoogleCredentialResponse) => void;
    readonly cancel_on_tap_outside: boolean;
    readonly client_id: string;
    readonly itp_support: boolean;
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
  });
  api.prompt((notification) => {
    if (
      notification.isDismissedMoment() ||
      notification.isNotDisplayed() ||
      notification.isSkippedMoment()
    ) {
      finish(null);
    }
  });
}

export function discoverAuthV2ExternalCapabilities(
  clerk: Clerk,
): AuthV2ExternalCapabilities {
  const environment = clerk.__internal_environment;
  const settings = environment?.userSettings;
  const googleOAuth =
    settings?.authenticatableSocialStrategies.includes(GOOGLE_OAUTH_STRATEGY) ??
    false;
  const passkeyAttribute = settings?.attributes.passkey;
  const passkey =
    passkeyAttribute?.enabled === true &&
    passkeyAttribute.used_for_first_factor === true &&
    settings?.passkeySettings.show_sign_in_button === true;
  const googleOneTapClientId = googleOAuth
    ? (environment?.displayConfig.googleOneTapClientId ?? null)
    : null;
  return { googleOAuth, googleOneTapClientId, passkey };
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

export function startAuthV2GoogleOAuth(
  resource: SignInResource,
  navigation: AuthV2Navigation,
): Promise<void> {
  return resource.authenticateWithRedirect({
    continueSignIn: true,
    continueSignUp: false,
    redirectUrl: navigation.href("sign-in", AUTH_V2_OAUTH_CALLBACK_PATH),
    redirectUrlComplete: navigation.completionRedirectUrl,
    strategy: GOOGLE_OAUTH_STRATEGY,
  });
}

export async function recoverAuthV2GoogleOAuth(
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
