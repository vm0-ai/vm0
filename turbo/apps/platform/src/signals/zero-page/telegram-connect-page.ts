import { command } from "ccstate";
import { createElement } from "react";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { setPageSignal$ } from "../page-signal.ts";
import { updatePage$ } from "../react-router.ts";
import {
  resetTelegramConnectState$,
  startTelegramConnectLoginListener$,
} from "./telegram-connect-signals.ts";
import { ZeroTelegramConnectPage } from "../../views/zero-page/zero-telegram-connect-page.tsx";

export const setupTelegramConnectPage$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(setPageSignal$, signal);
    set(resetTelegramConnectState$);
    set(updatePage$, createElement(ZeroTelegramConnectPage));
    set(updateDocumentTitle$, "Connect Telegram");
    set(startTelegramConnectLoginListener$, signal);
    await set(hideAppSkeleton$, signal);
  },
);
