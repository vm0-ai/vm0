import { command, computed, state } from "ccstate";
import {
  zeroIntegrationsTelegramContract,
  type TelegramLinkStatusResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { accept, ApiError } from "../../lib/accept.ts";
import { clerk$ } from "../auth.ts";
import { zeroClient$ } from "../api-client.ts";
import { searchParams$ } from "../route.ts";
import {
  parseTelegramPostMessage,
  type TelegramAuthResult,
} from "./telegram-auth-parser.ts";
import {
  parseTelegramConnectParams,
  type TelegramConnectParams,
} from "./telegram-connect-params.ts";

type TelegramConnectStatus = "idle" | "connecting" | "success" | "error";

interface TelegramConnectSuccess {
  botUsername: string;
  telegramUserId: string;
}

const internalTelegramConnectStatus$ = state<TelegramConnectStatus>("idle");
const internalTelegramConnectError$ = state<string | null>(null);
const internalTelegramConnectSuccess$ = state<TelegramConnectSuccess | null>(
  null,
);
const internalTelegramConnectLinkStatusReload$ = state(0);

export const telegramConnectStatus$ = computed((get) => {
  return get(internalTelegramConnectStatus$);
});

export const telegramConnectError$ = computed((get) => {
  return get(internalTelegramConnectError$);
});

export const telegramConnectSuccess$ = computed((get) => {
  return get(internalTelegramConnectSuccess$);
});

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
      { toast: false },
    ).catch(() => {
      return null;
    });

    return result?.body ?? null;
  },
);

export const reloadTelegramConnectLinkStatus$ = command(({ set }) => {
  set(internalTelegramConnectLinkStatusReload$, (prev) => {
    return prev + 1;
  });
});

export const resetTelegramConnectState$ = command(({ set }) => {
  set(internalTelegramConnectStatus$, "idle");
  set(internalTelegramConnectError$, null);
  set(internalTelegramConnectSuccess$, null);
});

type TelegramConnectInput =
  | TelegramConnectParams
  | {
      telegramBotId: string;
      telegramAuth: TelegramAuthResult;
    };

export const connectTelegramAccount$ = command(
  async ({ get, set }, params: TelegramConnectInput, signal: AbortSignal) => {
    set(internalTelegramConnectStatus$, "connecting");
    set(internalTelegramConnectError$, null);
    set(internalTelegramConnectSuccess$, null);

    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const linked = await accept(
      client.link({
        headers: {},
        fetchOptions: { signal },
        body: {
          telegramBotId: params.telegramBotId,
          ...("telegramAuth" in params
            ? { telegramAuth: params.telegramAuth }
            : params.connectSignature
              ? { connectSignature: params.connectSignature }
              : {}),
        },
      }),
      [200],
      { toast: false },
    )
      .then((result) => {
        return result.body;
      })
      .catch((error: unknown) => {
        if (signal.aborted) {
          throw error;
        }
        set(
          internalTelegramConnectError$,
          error instanceof ApiError
            ? error.message
            : "We couldn't connect Telegram. Try again from Telegram.",
        );
        set(internalTelegramConnectStatus$, "error");
        return null;
      });

    signal.throwIfAborted();
    if (!linked) {
      return;
    }
    set(internalTelegramConnectSuccess$, linked);
    set(internalTelegramConnectStatus$, "success");
  },
);

export const startTelegramConnectLoginListener$ = command(
  ({ get, set }, signal: AbortSignal) => {
    function handleMessage(event: MessageEvent) {
      const auth = parseTelegramPostMessage(event.data);
      if (!auth) {
        return;
      }

      const parsed = parseTelegramConnectParams(get(searchParams$));
      if (!parsed.ok) {
        return;
      }

      set(
        connectTelegramAccount$,
        { telegramBotId: parsed.params.telegramBotId, telegramAuth: auth },
        signal,
      ).catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        set(
          internalTelegramConnectError$,
          error instanceof Error
            ? error.message
            : "We couldn't connect Telegram. Try again from Telegram.",
        );
        set(internalTelegramConnectStatus$, "error");
      });
    }

    window.addEventListener("message", handleMessage);
    signal.addEventListener("abort", () => {
      window.removeEventListener("message", handleMessage);
    });
  },
);
