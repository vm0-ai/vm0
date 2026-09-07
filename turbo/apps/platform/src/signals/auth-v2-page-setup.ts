import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import { captureAuthV2DiagnosticEvent } from "../lib/posthog.ts";
import {
  AuthV2Page,
  type AuthV2PageMode,
} from "../views/auth-v2/auth-v2-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import {
  createAuthV2ContinuationSignals,
  isAuthV2ContinuationLocation,
} from "./auth-v2/continuation.ts";
import { createAuthV2Diagnostics } from "./auth-v2/diagnostics.ts";
import { resolveAuthV2PlatformContext } from "./auth-v2/platform-context.ts";
import {
  createAuthV2SignInSignals,
  type AuthV2SignInSignals,
} from "./auth-v2/sign-in-flow.ts";
import { AUTH_V2_OAUTH_CALLBACK_PATH } from "./auth-v2/sign-in-external-strategies.ts";
import {
  createAuthV2SignUpSignals,
  type AuthV2SignUpSignals,
} from "./auth-v2/sign-up-flow.ts";
import { AUTH_V2_SIGN_UP_OAUTH_CALLBACK_PATH } from "./auth-v2/sign-up-external-strategies.ts";
import { navigateSatelliteAuthRoute$ } from "./auth.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";
import { ROUTES } from "./route-paths.ts";

import {
  authV2Invitation$,
  navigateInvitationToPrimary$,
  redeemAuthV2Invitation$,
} from "./auth-v2/invitation.ts";

import type { AuthV2Navigation } from "./auth-v2/navigation.ts";

const navigateAuthEntry$ = command(
  async (
    { set },
    mode: AuthV2PageMode,
    navigation: AuthV2Navigation,
    signal: AbortSignal,
  ) => {
    return (
      (await set(navigateInvitationToPrimary$, navigation, signal)) ||
      (await set(navigateSatelliteAuthRoute$, mode, signal))
    );
  },
);

function setupAuthV2Page(mode: AuthV2PageMode) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const platformContext = resolveAuthV2PlatformContext(mode);
    if (
      await set(navigateAuthEntry$, mode, platformContext.navigation, signal)
    ) {
      return;
    }

    const invitation = get(authV2Invitation$);
    const invitationTicket =
      invitation?.mode === mode ? invitation.ticket : undefined;
    const diagnostics = createAuthV2Diagnostics(
      mode,
      captureAuthV2DiagnosticEvent,
    );
    const continuationController = createAuthV2ContinuationSignals({
      isInvitationEntry: !!invitationTicket,
      isContinuationRoute: isAuthV2ContinuationLocation(
        location.pathname,
        location.hash,
      ),
      mode,
      navigation: platformContext.navigation,
      presentation: "route",
    });
    const continuationSignals = diagnostics.instrumentContinuation(
      continuationController,
    );
    let signInSignals: AuthV2SignInSignals | null = null;
    let initializedSignInSignals: AuthV2SignInSignals | null = null;
    let signUpSignals: AuthV2SignUpSignals | null = null;
    const retryInvitation$ = command(
      async ({ set }, retrySignal: AbortSignal) => {
        if (await set(redeemAuthV2Invitation$, retrySignal)) {
          if (signInSignals) {
            await set(signInSignals.initialize$, retrySignal);
          } else if (signUpSignals) {
            await set(signUpSignals.initialize$, retrySignal);
          }
        }
      },
    );
    if (mode === "sign-in") {
      const isBaseRoute = location.pathname === ROUTES.signIn;
      const isOAuthCallbackRoute =
        location.pathname === `${ROUTES.signIn}${AUTH_V2_OAUTH_CALLBACK_PATH}`;
      signInSignals = diagnostics.instrumentSignIn(
        createAuthV2SignInSignals({
          continuation: continuationController,
          isBaseRoute,
          isOAuthCallbackRoute,
          navigation: platformContext.navigation,
        }),
        {
          continuationState$: continuationController.state$,
          isBaseRoute,
          isOAuthCallbackRoute,
        },
      );
      set(
        updatePage$,
        createElement(AuthV2Page, {
          mode,
          continuationSignals,
          platformContext,
          retryInvitation$,
          signInSignals,
        }),
      );
    } else {
      const isOAuthCallbackRoute =
        location.pathname ===
        `${ROUTES.signUp}${AUTH_V2_SIGN_UP_OAUTH_CALLBACK_PATH}`;
      signUpSignals = diagnostics.instrumentSignUp(
        createAuthV2SignUpSignals({
          continuation: continuationController,
          isOAuthCallbackRoute,
          navigation: platformContext.navigation,
        }),
        {
          continuationState$: continuationController.state$,
          isOAuthCallbackRoute,
        },
      );
      set(
        updatePage$,
        createElement(AuthV2Page, {
          mode,
          continuationSignals,
          platformContext,
          retryInvitation$,
          signUpSignals,
        }),
      );
    }
    set(
      updateDocumentTitle$,
      mode === "sign-in"
        ? i18n.t(($) => {
            return $.auth.documentTitles.signIn;
          })
        : i18n.t(($) => {
            return $.auth.documentTitles.signUp;
          }),
      platformContext.authBrand.brandName,
    );
    await set(continuationSignals.initialize$, signal);
    signal.throwIfAborted();
    if (invitationTicket) {
      await set(retryInvitation$, signal);
    } else if (get(continuationSignals.state$).status === "inactive") {
      if (signInSignals) {
        await set(signInSignals.initialize$, signal);
        initializedSignInSignals = signInSignals;
      } else if (signUpSignals) {
        await set(signUpSignals.initialize$, signal);
      }
    }
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
    if (initializedSignInSignals) {
      await set(initializedSignInSignals.initializeExternalStrategies$, signal);
    }
  });
}

export const setupSignInV2Page$ = setupAuthV2Page("sign-in");
export const setupSignUpV2Page$ = setupAuthV2Page("sign-up");
