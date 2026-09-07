import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import {
  AuthV1Page,
  type AuthV1PageMode,
} from "../views/auth-v1/auth-v1-page.tsx";
import {
  clerk$,
  clerkInstance$,
  ensureClerkUiLoaded$,
  navigateSatelliteAuthRoute$,
  resolveAuthBrandContext,
} from "./auth.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";

function setupAuthV1Page(mode: AuthV1PageMode) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (await set(navigateSatelliteAuthRoute$, mode, signal)) {
      return;
    }

    const authBrand = resolveAuthBrandContext();
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
    const clerk = await get(clerkInstance$);
    signal.throwIfAborted();
    // Only the v1 comparison routes request Clerk's hosted UI. Stable auth
    // routes continue to use the platform-owned auth v2 implementation.
    await set(ensureClerkUiLoaded$, signal);
    signal.throwIfAborted();
    set(updatePage$, createElement(AuthV1Page, { clerk, mode }));
    await get(clerk$);
    signal.throwIfAborted();
  });
}

export const setupSignInV1Page$ = setupAuthV1Page("sign-in");
export const setupSignUpV1Page$ = setupAuthV1Page("sign-up");
