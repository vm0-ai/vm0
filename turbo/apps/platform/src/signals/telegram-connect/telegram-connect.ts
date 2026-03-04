import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("TelegramConnect");

interface TelegramConnectState {
  status: "checking" | "ready" | "registering" | "success" | "error";
  isLinked: boolean;
  error: string | null;
}

type RegisterTelegramBotResult =
  | { success: true; installationId: string; botUsername: string }
  | { success: false };

const telegramConnectState$ = state<TelegramConnectState>({
  status: "checking",
  isLinked: false,
  error: null,
});

export const telegramConnectStatus$ = computed(
  (get) => get(telegramConnectState$).status,
);
export const telegramConnectIsLinked$ = computed(
  (get) => get(telegramConnectState$).isLinked,
);
export const telegramConnectError$ = computed(
  (get) => get(telegramConnectState$).error,
);

const telegramBotTokenInput$ = state("");

export const telegramBotToken$ = computed((get) => get(telegramBotTokenInput$));

export const setTelegramBotToken$ = command(({ set }, value: string) => {
  set(telegramBotTokenInput$, value);
});

/**
 * Check if the user is already linked to a Telegram bot.
 */
export const initTelegramConnect$ = command(async ({ get, set }) => {
  set(telegramConnectState$, {
    status: "checking",
    isLinked: false,
    error: null,
  });

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/telegram/link");

    if (!response.ok) {
      throw new Error("Failed to check link status");
    }

    const data = (await response.json()) as {
      linked: boolean;
      telegramUserId?: string;
    };

    set(telegramConnectState$, {
      status: "ready",
      isLinked: data.linked,
      error: null,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to check link status:", error);
    set(telegramConnectState$, {
      status: "error",
      isLinked: false,
      error: "Failed to check connection status. Please try again.",
    });
  }
});

/**
 * Register a new Telegram bot (admin flow).
 */
export const registerTelegramBot$ = command(
  async (
    { get, set },
    params: { botToken: string; defaultAgentId?: string },
  ): Promise<RegisterTelegramBotResult> => {
    set(telegramConnectState$, (prev) => ({
      ...prev,
      status: "registering" as const,
      error: null,
    }));

    try {
      const fetchFn = get(fetch$);
      const response = await fetchFn("/api/telegram/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const data = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(data.error?.message ?? "Failed to register bot");
      }

      const result = (await response.json()) as {
        id: string;
        botUsername: string;
      };

      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "success" as const,
      }));

      return {
        success: true,
        installationId: result.id,
        botUsername: result.botUsername,
      };
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to register Telegram bot:", error);
      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "ready" as const,
        error:
          error instanceof Error ? error.message : "Failed to register bot",
      }));
      return { success: false };
    }
  },
);
