import { command } from "ccstate";
import { createElement } from "react";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { setPageSignal$ } from "../page-signal.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { ZeroTelegramConnectPage } from "../../views/zero-page/zero-telegram-connect-page.tsx";
import { parseTelegramConnectParams } from "./telegram-connect-params.ts";

export const setupTelegramConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const parsed = parseTelegramConnectParams(get(searchParams$));
    capturePlausibleEvent("telegram_connect_visit", {
      props: {
        method: parsed.ok
          ? parsed.params.connectSignature
            ? "connect_signature"
            : "telegram_login"
          : "invalid",
      },
    });

    set(setPageSignal$, signal);
    set(updatePage$, createElement(ZeroTelegramConnectPage));
    set(updateDocumentTitle$, "Connect Telegram");
    await set(hideAppSkeleton$, signal);
  },
);
