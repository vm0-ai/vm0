import { command } from "ccstate";
import { createElement } from "react";
import { updatePage$ } from "../react-router.ts";
import { navigate$, searchParams$ } from "../route.ts";
import { hasAnyModelProvider$ } from "../external/model-providers.ts";
import { throwIfAbort } from "../utils.ts";
import {
  initTelegramConnect$,
  startTelegramConnectLoginListener$,
} from "./telegram-connect.ts";
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

    // Pass URL params to init
    const params = get(searchParams$);
    const botId = params.get("bot") ?? undefined;
    const tgUser = params.get("tgUser");
    const ts = params.get("ts");
    const sig = params.get("sig");

    const connectParams =
      tgUser && ts && sig
        ? { telegramUserId: tgUser, timestamp: ts, signature: sig }
        : undefined;

    await set(initTelegramConnect$, { botId, connectParams });
    signal.throwIfAborted();

    // Start listening for Telegram OAuth postMessage (for connect-account step)
    set(startTelegramConnectLoginListener$, signal);
  },
);
