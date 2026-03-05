import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { navigate$, searchParams$ } from "../route.ts";
import { hasAnyModelProvider$ } from "../external/model-providers.ts";
import { throwIfAbort } from "../utils.ts";
import { initTelegramConnect$ } from "./telegram-connect.ts";
import { TelegramConnectPage } from "../../views/telegram-connect/telegram-connect-page.tsx";

export const setupTelegramConnectPage$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Render page first so the user sees the loading spinner
    set(updatePage$, createElement(TelegramConnectPage));

    // Check provider — redirect to setup if none configured
    let hasProvider = false;
    try {
      hasProvider = await get(hasAnyModelProvider$);
    } catch (error) {
      throwIfAbort(error);
    }
    signal.throwIfAborted();

    if (!hasProvider) {
      const setupParams = new URLSearchParams();
      setupParams.set("return", "/telegram/connect");
      await set(
        navigate$,
        "/provider-setup",
        { searchParams: setupParams },
        signal,
      );
      signal.throwIfAborted();
      return;
    }

    // Pass ?bot= param to init so it can look up existing installation
    const params = get(searchParams$);
    const botId = params.get("bot") ?? undefined;
    await set(initTelegramConnect$, botId);
  },
);
