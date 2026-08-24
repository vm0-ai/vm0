import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import {
  AuthV2Page,
  type AuthV2PageMode,
} from "../views/auth-v2/auth-v2-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { resolveAuthBrandContext } from "./auth.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";

function setupAuthV2Page(mode: AuthV2PageMode) {
  return command(async ({ set }, signal: AbortSignal) => {
    const authBrand = resolveAuthBrandContext();
    set(updatePage$, createElement(AuthV2Page, { mode }));
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
  });
}

export const setupSignInV2Page$ = setupAuthV2Page("sign-in");
export const setupSignUpV2Page$ = setupAuthV2Page("sign-up");
