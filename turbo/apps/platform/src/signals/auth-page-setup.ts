import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import { AuthPage, type AuthPageMode } from "../views/auth/auth-page.tsx";
import {
  clerk$,
  clerkInstance$,
  ensureClerkUiLoaded$,
  resolveAuthBrandContext,
} from "./auth.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";

function setupAuthPage(mode: AuthPageMode) {
  return command(async ({ get, set }, signal: AbortSignal) => {
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
    // Clerk UI itself remains route-scoped even though application modules are
    // statically linked into the single JavaScript bundle.
    await set(ensureClerkUiLoaded$, signal);
    signal.throwIfAborted();
    set(updatePage$, createElement(AuthPage, { clerk, mode }));
    await get(clerk$);
    signal.throwIfAborted();
  });
}

export const setupSignInPage$ = setupAuthPage("sign-in");
export const setupSignUpPage$ = setupAuthPage("sign-up");
