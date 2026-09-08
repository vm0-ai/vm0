import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../i18n/index.ts";
import { enableViewportZoom } from "../lib/viewport-pinch.ts";
import {
  AuthV1Page,
  type AuthV1PageMode,
} from "../views/auth-v1/auth-v1-page.tsx";
import {
  clerk$,
  clerkInstance$,
  ensureClerkUiLoaded$,
  resolveAuthBrandContext,
} from "./auth.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";
import { AuthV1LoadError } from "../views/auth-v1/auth-v1-load-error.tsx";
import { logger } from "./log.ts";
import { throwIfAbort } from "./utils.ts";

const L = logger("AuthV1");

function setupAuthV1Page(mode: AuthV1PageMode) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    enableViewportZoom(signal);
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
    // Only the v1 comparison routes request Clerk's optional UI. Stable auth
    // routes continue to use the platform-owned auth v2 implementation.
    let ui;
    // eslint-disable-next-line no-restricted-syntax -- The optional SDK resource can fail before a form exists; offer a visible reload without converting auth/API failures into success.
    try {
      ui = await set(ensureClerkUiLoaded$, signal);
    } catch (error) {
      throwIfAbort(error);
      signal.throwIfAborted();
      L.error("Clerk UI failed to load", error);
      set(updatePage$, createElement(AuthV1LoadError));
      return;
    }
    signal.throwIfAborted();
    set(updatePage$, createElement(AuthV1Page, { clerk, mode, ui }));
    await get(clerk$);
    signal.throwIfAborted();
  });
}

export const setupSignInV1Page$ = setupAuthV1Page("sign-in");
export const setupSignUpV1Page$ = setupAuthV1Page("sign-up");
