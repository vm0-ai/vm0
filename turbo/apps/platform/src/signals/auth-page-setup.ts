import { command } from "ccstate";
import { createElement } from "react";
import { AuthPage, type AuthPageMode } from "../views/auth/auth-page.tsx";
import { hideAppSkeleton$ } from "./app-skeleton.ts";
import { updateDocumentTitle$ } from "./document-title.ts";
import { updatePage$ } from "./react-router.ts";

function setupAuthPage(mode: AuthPageMode) {
  return command(async ({ set }, signal: AbortSignal) => {
    set(updatePage$, createElement(AuthPage, { mode }));
    set(updateDocumentTitle$, mode === "sign-in" ? "Sign in" : "Sign up");
    await set(hideAppSkeleton$, signal);
  });
}

export const setupSignInPage$ = setupAuthPage("sign-in");
export const setupSignUpPage$ = setupAuthPage("sign-up");
