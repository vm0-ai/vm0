import { command, computed, state } from "ccstate";
import {
  zeroIntegrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { accept } from "../../lib/accept.ts";
import { clerk$ } from "../auth.ts";
import { zeroClient$ } from "../api-client.ts";
import { apiBaseForNavigation$ } from "../fetch.ts";
import { searchParams$ } from "../route.ts";
import { createDeferredPromise } from "../utils.ts";
import {
  parseTelegramPostMessage,
  type TelegramAuthResult,
} from "./telegram-auth-parser.ts";
import { parseTelegramConnectParams } from "./telegram-connect-params.ts";
import { openTelegramLoginPopup } from "./telegram-login-popup.ts";

const internalTelegramConnectLinkStatusReload$ = state(0);

export const telegramConnectLinkStatus$ = computed(
  async (get): Promise<TelegramLinkStatusResponse | null> => {
    get(internalTelegramConnectLinkStatusReload$);
    const parsed = parseTelegramConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }

    const clerk = await get(clerk$);
    if (!clerk.user) {
      return null;
    }

    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const origin =
      typeof location === "undefined" ? undefined : location.origin;
    const result = await accept(
      client.getLinkStatus({
        headers: {},
        query: {
          botId: parsed.params.telegramBotId,
          ...(origin ? { origin } : {}),
        },
      }),
      [200],
    );

    return result.body;
  },
);

export const reloadTelegramConnectLinkStatus$ = command(({ set }) => {
  set(internalTelegramConnectLinkStatusReload$, (prev) => {
    return prev + 1;
  });
});

function requestTelegramAuth(
  telegramBotId: string,
  apiBase: string,
  signal: AbortSignal,
): Promise<TelegramAuthResult> {
  signal.throwIfAborted();
  openTelegramLoginPopup(telegramBotId, apiBase);

  const deferred = createDeferredPromise<TelegramAuthResult>(signal);
  const cleanup = () => {
    window.removeEventListener("message", handleMessage);
    signal.removeEventListener("abort", cleanup);
  };
  const handleMessage = (event: MessageEvent) => {
    const auth = parseTelegramPostMessage(event.data);
    if (!auth || deferred.settled()) {
      return;
    }
    cleanup();
    deferred.resolve(auth);
  };

  window.addEventListener("message", handleMessage, { signal });
  signal.addEventListener("abort", cleanup, { once: true });
  return deferred.promise;
}

export const connectTelegramAccount$ = command(
  async ({ get }, signal: AbortSignal) => {
    const parsed = parseTelegramConnectParams(get(searchParams$));
    if (!parsed.ok) {
      return null;
    }
    const { params } = parsed;
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const linkCredential = params.connectSignature
      ? { connectSignature: params.connectSignature }
      : {
          telegramAuth: await requestTelegramAuth(
            params.telegramBotId,
            await get(apiBaseForNavigation$),
            signal,
          ),
        };

    const result = await accept(
      client.link({
        headers: {},
        fetchOptions: { signal },
        body: {
          telegramBotId: params.telegramBotId,
          ...linkCredential,
        },
      }),
      [200],
    );
    signal.throwIfAborted();

    return result.body;
  },
);
