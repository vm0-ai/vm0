import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("TelegramConnect");

interface TelegramInstallationInfo {
  id: string;
  botUsername: string;
}

interface TelegramConnectState {
  status:
    | "checking"
    | "ready"
    | "registering"
    | "linking"
    | "success"
    | "error";
  isLinked: boolean;
  installation: TelegramInstallationInfo | null;
  error: string | null;
}

type RegisterTelegramBotResult =
  | {
      success: true;
      installationId: string;
      botUsername: string;
      deepLink?: string;
    }
  | { success: false };

const telegramConnectState$ = state<TelegramConnectState>({
  status: "checking",
  isLinked: false,
  installation: null,
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
export const telegramConnectInstallation$ = computed(
  (get) => get(telegramConnectState$).installation,
);

const telegramBotTokenInput$ = state("");

export const telegramBotToken$ = computed((get) => get(telegramBotTokenInput$));

export const setTelegramBotToken$ = command(({ set }, value: string) => {
  set(telegramBotTokenInput$, value);
});

/**
 * Check if the user is already linked to a Telegram bot.
 * When botId is provided, also checks for an existing installation to enable re-linking.
 */
export const initTelegramConnect$ = command(
  async ({ get, set }, botId?: string) => {
    set(telegramConnectState$, {
      status: "checking",
      isLinked: false,
      installation: null,
      error: null,
    });

    try {
      const fetchFn = get(fetch$);
      const url = botId
        ? `/api/integrations/telegram/link?botId=${encodeURIComponent(botId)}`
        : "/api/integrations/telegram/link";
      const response = await fetchFn(url);

      if (!response.ok) {
        throw new Error("Failed to check link status");
      }

      const data = (await response.json()) as {
        linked: boolean;
        telegramUserId?: string;
        installation?: TelegramInstallationInfo;
      };

      set(telegramConnectState$, {
        status: "ready",
        isLinked: data.linked,
        installation: data.installation ?? null,
        error: null,
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to check link status:", error);
      set(telegramConnectState$, {
        status: "error",
        isLinked: false,
        installation: null,
        error: "Failed to check connection status. Please try again.",
      });
    }
  },
);

/**
 * Link user to an existing Telegram bot installation.
 * Generates a deep link token and returns the Telegram deep link URL.
 */
export const linkTelegramBot$ = command(
  async (
    { get, set },
    installationId: string,
  ): Promise<RegisterTelegramBotResult> => {
    const botUsername =
      get(telegramConnectState$).installation?.botUsername ?? "";

    set(telegramConnectState$, (prev) => ({
      ...prev,
      status: "linking" as const,
      error: null,
    }));

    try {
      const fetchFn = get(fetch$);
      const response = await fetchFn("/api/integrations/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      });

      if (!response.ok) {
        const data = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(data.error?.message ?? "Failed to link account");
      }

      const data = (await response.json()) as {
        token: string;
        deepLink: string | null;
      };

      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "success" as const,
      }));

      return {
        success: true,
        installationId,
        botUsername,
        deepLink: data.deepLink ?? undefined,
      };
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to link Telegram bot:", error);
      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "ready" as const,
        error:
          error instanceof Error ? error.message : "Failed to link account",
      }));
      return { success: false };
    }
  },
);

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
