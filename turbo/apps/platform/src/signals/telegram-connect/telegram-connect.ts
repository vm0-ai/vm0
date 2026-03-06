import { command, computed, state } from "ccstate";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import {
  parseTelegramPostMessage,
  type TelegramAuthResult,
} from "../integrations-page/telegram-auth-parser.ts";
import { openTelegramLoginPopup } from "../integrations-page/telegram-login-popup.ts";

const L = logger("TelegramConnect");

interface TelegramInstallationInfo {
  id: string;
  botUsername: string;
}

interface ConnectSignatureParams {
  telegramUserId: string;
  timestamp: string;
  signature: string;
}

type TelegramConnectStep = "install" | "connect-account" | "complete";

interface TelegramConnectState {
  status:
    | "checking"
    | "ready"
    | "registering"
    | "linking"
    | "success"
    | "error";
  step: TelegramConnectStep;
  isLinked: boolean;
  installation: TelegramInstallationInfo | null;
  botId: string | null;
  botUsername: string | null;
  domainConfigured: boolean;
  connectParams: ConnectSignatureParams | null;
  error: string | null;
}

type RegisterTelegramBotResult =
  | {
      success: true;
      installationId: string;
      botUsername: string;
    }
  | { success: false };

const telegramConnectState$ = state<TelegramConnectState>({
  status: "checking",
  step: "install",
  isLinked: false,
  installation: null,
  botId: null,
  botUsername: null,
  domainConfigured: false,
  connectParams: null,
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
export const telegramConnectParams$ = computed(
  (get) => get(telegramConnectState$).connectParams,
);
export const telegramConnectStep$ = computed(
  (get) => get(telegramConnectState$).step,
);
export const telegramConnectDomainConfigured$ = computed(
  (get) => get(telegramConnectState$).domainConfigured,
);
export const telegramConnectBotUsername$ = computed(
  (get) => get(telegramConnectState$).botUsername,
);
export const telegramConnectBotId$ = computed(
  (get) => get(telegramConnectState$).botId,
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
  async (
    { get, set },
    opts?: { botId?: string; connectParams?: ConnectSignatureParams },
  ) => {
    const botId = opts?.botId;
    const connectParams = opts?.connectParams ?? null;
    set(telegramConnectState$, {
      status: "checking",
      step: "install",
      isLinked: false,
      installation: null,
      botId: botId ?? null,
      botUsername: null,
      domainConfigured: false,
      connectParams,
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

      // If not linked and no connect params, check if user already has an
      // installation (e.g. page was refreshed after registration).
      if (!data.linked && !connectParams) {
        const integrationResp = await fetchFn("/api/integrations/telegram");
        if (integrationResp.ok) {
          const integration = (await integrationResp.json()) as {
            installationId: string;
            bot: { id: string; username: string };
            isAdmin: boolean;
            isConnected: boolean;
            domainConfigured: boolean;
          };
          if (integration.isAdmin && !integration.isConnected) {
            set(telegramConnectState$, {
              status: "ready",
              step: "connect-account",
              isLinked: false,
              installation: {
                id: integration.installationId,
                botUsername: integration.bot.username,
              },
              botId: integration.bot.id,
              botUsername: integration.bot.username,
              domainConfigured: integration.domainConfigured,
              connectParams: null,
              error: null,
            });
            return;
          }
        }
      }

      set(telegramConnectState$, {
        status: "ready",
        step: "install",
        isLinked: data.linked,
        installation: data.installation ?? null,
        botId: botId ?? null,
        botUsername: null,
        domainConfigured: false,
        connectParams,
        error: null,
      });
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to check link status:", error);
      set(telegramConnectState$, {
        status: "error",
        step: "install",
        isLinked: false,
        installation: null,
        botId: botId ?? null,
        botUsername: null,
        domainConfigured: false,
        connectParams,
        error: "Failed to check connection status. Please try again.",
      });
    }
  },
);

/**
 * Link user via signed connect params from /connect command.
 */
export const linkTelegramBot$ = command(
  async (
    { get, set },
    params: {
      installationId: string;
      telegramUserId: string;
      timestamp: string;
      signature: string;
    },
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
        body: JSON.stringify({
          installationId: params.installationId,
          connectSignature: {
            telegramUserId: params.telegramUserId,
            timestamp: Number(params.timestamp),
            signature: params.signature,
          },
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(data.error?.message ?? "Failed to link account");
      }

      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "success" as const,
      }));

      return {
        success: true,
        installationId: params.installationId,
        botUsername,
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
 * On success, transitions to "connect-account" step instead of navigating away.
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
        botId: string;
        botUsername: string;
        domainConfigured: boolean;
      };

      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "ready" as const,
        step: "connect-account" as const,
        installation: { id: result.id, botUsername: result.botUsername },
        botId: result.botId,
        botUsername: result.botUsername,
        domainConfigured: result.domainConfigured,
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

/**
 * Connect user's Telegram account from the connect page via OAuth postMessage.
 */
const connectTelegramFromConnectPage$ = command(
  async (
    { get, set },
    params: { installationId: string; auth: TelegramAuthResult },
  ) => {
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
        body: JSON.stringify({
          installationId: params.installationId,
          telegramAuth: params.auth,
        }),
      });

      if (!response.ok) {
        const data = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(
          data.error?.message ?? "Failed to connect Telegram account",
        );
      }

      const botUsername = get(telegramConnectState$).botUsername;
      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "ready" as const,
        step: "complete" as const,
      }));
      if (botUsername) {
        window.open(`tg://resolve?domain=${botUsername}`, "_blank");
      }
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to connect Telegram from connect page:", error);
      set(telegramConnectState$, (prev) => ({
        ...prev,
        status: "ready" as const,
        error:
          error instanceof Error
            ? error.message
            : "Failed to connect Telegram account",
      }));
    }
  },
);

/**
 * Listen for Telegram OAuth postMessage on the connect page.
 */
export const startTelegramConnectLoginListener$ = command(
  ({ get, set }, signal: AbortSignal) => {
    function handleMessage(event: MessageEvent) {
      const auth = parseTelegramPostMessage(event.data);
      if (!auth) {
        return;
      }

      const state = get(telegramConnectState$);
      // Use the installation id from the register result, or fall back to existing installation
      const installationId = state.installation?.id;
      if (!installationId) {
        return;
      }

      set(connectTelegramFromConnectPage$, {
        installationId,
        auth,
      }).catch(() => {
        // Error is handled inside via state update
      });
    }

    window.addEventListener("message", handleMessage);
    signal.addEventListener("abort", () => {
      window.removeEventListener("message", handleMessage);
    });
  },
);

/**
 * Skip the connect-account step and go directly to complete.
 * Auto-opens Telegram so the user can start chatting.
 */
export const skipTelegramConnect$ = command(({ get, set }) => {
  const botUsername = get(telegramConnectState$).botUsername;
  set(telegramConnectState$, (prev) => ({
    ...prev,
    step: "complete" as const,
  }));
  if (botUsername) {
    window.open(`tg://resolve?domain=${botUsername}`, "_blank");
  }
});

/**
 * Open the Telegram login popup (shared utility).
 */
export const openTelegramConnectLoginPopup$ = command((_ctx, botId: string) => {
  openTelegramLoginPopup(botId);
});
