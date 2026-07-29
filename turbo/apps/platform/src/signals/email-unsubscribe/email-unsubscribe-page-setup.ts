import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
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
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.lifecycle.emailUnsubscribe.documentTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
