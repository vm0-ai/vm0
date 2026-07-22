import { command } from "ccstate";
import { createElement } from "react";
import { EmailUnsubscribePage } from "../../views/email-unsubscribe/email-unsubscribe-page.tsx";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { setPageSignal$ } from "../page-signal.ts";
import { updatePage$ } from "../react-router.ts";
import { resetEmailUnsubscribeState$ } from "./email-unsubscribe-signals.ts";

export const setupEmailUnsubscribePage$ = command(
  async ({ set }, signal: AbortSignal) => {
    // This route skips the auth wrapper, so the page signal is set here.
    set(setPageSignal$, signal);
    set(resetEmailUnsubscribeState$);
    set(updatePage$, createElement(EmailUnsubscribePage));
    set(updateDocumentTitle$, "Unsubscribe");
    await set(hideAppSkeleton$, signal);
  },
);
