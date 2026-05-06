import { command } from "ccstate";
import { createElement } from "react";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { setPageSignal$ } from "../page-signal.ts";
import { updatePage$ } from "../react-router.ts";
import { ZeroTelegramConnectPage } from "../../views/zero-page/zero-telegram-connect-page.tsx";

export const setupTelegramConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setPageSignal$, signal);
    set(updatePage$, createElement(ZeroTelegramConnectPage));
    set(updateDocumentTitle$, "Connect Telegram");
    await set(hideAppSkeleton$, signal);
  },
);
