import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import { AuthPage, type AuthPageMode } from "../views/auth/auth-page.tsx";
import { clerk$ } from "./auth.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";

function setupAuthPage(mode: AuthPageMode) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AuthPage, { mode }));
    set(
      updateDocumentTitle$,
      mode === "sign-in"
        ? i18n.t(($) => {
            return $.auth.documentTitles.signIn;
          })
        : i18n.t(($) => {
            return $.auth.documentTitles.signUp;
          }),
    );
    await get(clerk$);
    signal.throwIfAborted();
  });
}

export const setupSignInPage$ = setupAuthPage("sign-in");
export const setupSignUpPage$ = setupAuthPage("sign-up");
