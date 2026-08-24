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
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";

// Redirect, brand, and attribution policy intentionally live outside the
// flow. The parallel redirect track can replace this resolver without changing
// Clerk operations or activation ownership.
function resolveAuthV2SignInRedirectUrl(): string {
  return "/";
}

function setupAuthV2Page(mode: AuthV2PageMode) {
  return command(async ({ set }, signal: AbortSignal) => {
    const authBrand = resolveAuthBrandContext();
    let signInSignals: AuthV2SignInSignals | null = null;
    if (mode === "sign-in") {
      signInSignals = createAuthV2SignInSignals({
        resolveRedirectUrl: resolveAuthV2SignInRedirectUrl,
      });
      set(updatePage$, createElement(AuthV2Page, { mode, signInSignals }));
    } else {
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
