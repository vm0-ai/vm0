import { command } from "ccstate";
import { createElement } from "react";
import { i18n } from "../../i18n/index.ts";
import { capturePlausibleEvent } from "../../lib/plausible.ts";
import { hideAppSkeleton$ } from "../app-skeleton.ts";
import { updateDocumentTitle$ } from "../document-title.ts";
import { updatePage$ } from "../react-router.ts";
import { searchParams$ } from "../route.ts";
import { TelegramConnectPage } from "../../views/okou-page/telegram-connect-page.tsx";
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

    set(updatePage$, createElement(TelegramConnectPage));
    set(
      updateDocumentTitle$,
      i18n.t(($) => {
        return $.connectors.providerConnect.telegram.connectTitle;
      }),
    );
    await set(hideAppSkeleton$, signal);
  },
);
