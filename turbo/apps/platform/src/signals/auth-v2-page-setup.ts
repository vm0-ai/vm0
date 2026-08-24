import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import {
  AuthV2Page,
  type AuthV2PageMode,
} from "../views/auth-v2/auth-v2-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { resolveAuthBrandContext } from "./auth.ts";
import {
  createAuthV2SignInSignals,
  type AuthV2SignInSignals,
} from "./auth-v2/sign-in-flow.ts";
import { AUTH_V2_OAUTH_CALLBACK_PATH } from "./auth-v2/sign-in-external-strategies.ts";
import { resolveAuthV2PlatformContext } from "./auth-v2/platform-context.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";
import { ROUTES } from "./route-paths.ts";

function setupAuthV2Page(mode: AuthV2PageMode) {
  return command(async ({ set }, signal: AbortSignal) => {
    let authBrand: ReturnType<typeof resolveAuthBrandContext>;
    let signInSignals: AuthV2SignInSignals | null = null;
    if (mode === "sign-in") {
      const platformContext = resolveAuthV2PlatformContext(mode);
      authBrand = platformContext.authBrand;
      signInSignals = createAuthV2SignInSignals({
        isBaseRoute: location.pathname === ROUTES.signInV2,
        isOAuthCallbackRoute:
          location.pathname ===
          `${ROUTES.signInV2}${AUTH_V2_OAUTH_CALLBACK_PATH}`,
        navigation: platformContext.navigation,
      });
      set(updatePage$, createElement(AuthV2Page, { mode, signInSignals }));
    } else {
      authBrand = resolveAuthBrandContext();
      set(updatePage$, createElement(AuthV2Page, { mode }));
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
      authBrand.brandName,
    );
    await set(hideAppSkeleton$, signal);
    signal.throwIfAborted();
    if (signInSignals) {
      await set(signInSignals.initialize$, signal);
    }
  });
}

export const setupSignInV2Page$ = setupAuthV2Page("sign-in");
export const setupSignUpV2Page$ = setupAuthV2Page("sign-up");
