import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";
import {
  parseTelegramPostMessage,
  type TelegramAuthResult,
} from "./telegram-auth-parser.ts";
import { openTelegramLoginPopup } from "./telegram-login-popup.ts";

const L = logger("TelegramIntegration");

interface TelegramIntegrationData {
  installationId: string;
  bot: { id: string; username: string };
  agent: { id: string; name: string; orgSlug: string } | null;
  isAdmin: boolean;
  isConnected: boolean;
  domainConfigured: boolean;
  environment: {
    requiredSecrets: string[];
    requiredVars: string[];
    missingSecrets: string[];
    missingVars: string[];
  };
}

interface TelegramIntegrationState {
  data: TelegramIntegrationData | null;
  loading: boolean;
  error: string | null;
  notLinked: boolean;
}

const telegramIntegrationState$ = state<TelegramIntegrationState>({
  data: null,
  loading: false,
  error: null,
  notLinked: false,
});

export const telegramIntegrationData$ = computed(
  (get) => get(telegramIntegrationState$).data,
);
export const telegramIntegrationLoading$ = computed(
  (get) => get(telegramIntegrationState$).loading,
);
export const telegramIntegrationNotLinked$ = computed(
  (get) => get(telegramIntegrationState$).notLinked,
);
export const telegramIntegrationIsConnected$ = computed(
  (get) => get(telegramIntegrationState$).data?.isConnected ?? false,
);

export const fetchTelegramIntegration$ = command(async ({ get, set }) => {
  set(telegramIntegrationState$, (prev) => ({
    ...prev,
    loading: true,
    error: null,
  }));

  try {
    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/telegram");

    if (response.status === 404) {
      set(telegramIntegrationState$, {
        data: null,
        loading: false,
        error: null,
        notLinked: true,
      });
      return;
    }

    if (!response.ok) {
      throw new Error(
        `Failed to fetch Telegram integration: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as TelegramIntegrationData;
    set(telegramIntegrationState$, {
      data,
      loading: false,
      error: null,
      notLinked: false,
    });
  } catch (error) {
    throwIfAbort(error);
    L.error("Failed to fetch Telegram integration:", error);
    set(telegramIntegrationState$, (prev) => ({
      ...prev,
      loading: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
  }
});

const telegramDisconnectDialogState$ = state(false);

export const telegramDisconnectDialogOpen$ = computed((get) =>
  get(telegramDisconnectDialogState$),
);

export const openTelegramDisconnectDialog$ = command(({ set }) => {
  set(telegramDisconnectDialogState$, true);
});

export const closeTelegramDisconnectDialog$ = command(({ set }) => {
  set(telegramDisconnectDialogState$, false);
});

export const updateTelegramDefaultAgent$ = command(
  async ({ get, set }, agentName: string) => {
    // Optimistically update agent name so the UI doesn't flash a loading state
    set(telegramIntegrationState$, (prev) => {
      if (!prev.data) {
        return prev;
      }
      return {
        ...prev,
        data: {
          ...prev.data,
          agent: prev.data.agent
            ? { ...prev.data.agent, name: agentName }
            : { id: "", name: agentName, orgSlug: "" },
        },
      };
    });

    const fetchFn = get(fetch$);
    const response = await fetchFn("/api/integrations/telegram", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentName }),
    });

    if (!response.ok) {
      toast.error("Failed to update default agent");
      // Re-fetch to revert optimistic update
      await set(fetchTelegramIntegration$);
      return;
    }

    toast.success(`Default agent updated to ${agentName}`);

    // Silently refresh to pick up updated environment status without loading spinner
    try {
      const refreshResponse = await fetchFn("/api/integrations/telegram");
      if (refreshResponse.ok) {
        const data = (await refreshResponse.json()) as TelegramIntegrationData;
        set(telegramIntegrationState$, (prev) => ({
          ...prev,
          data,
        }));
      }
    } catch (error) {
      throwIfAbort(error);
      L.error("Failed to refresh after agent update:", error);
    }
  },
);

const connectTelegramViaLogin$ = command(
  async (
    { get, set },
    params: { installationId: string; auth: TelegramAuthResult },
  ) => {
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
      const data = (await response.json()) as { error?: { message?: string } };
      toast.error(data.error?.message ?? "Failed to connect Telegram account");
      return;
    }

    toast.success("Telegram account connected!");
    await set(fetchTelegramIntegration$);
  },
);

// ---------------------------------------------------------------------------
// Telegram Login popup helpers
// ---------------------------------------------------------------------------

export const startTelegramLoginListener$ = command(
  ({ get, set }, signal: AbortSignal) => {
    function handleMessage(event: MessageEvent) {
      const auth = parseTelegramPostMessage(event.data);
      if (!auth) {
        return;
      }

      const installationId = get(telegramIntegrationState$).data
        ?.installationId;
      if (!installationId) {
        return;
      }

      set(connectTelegramViaLogin$, { installationId, auth }).catch(() => {
        // Error is handled inside connectTelegramViaLogin$ via toast
      });
    }

    window.addEventListener("message", handleMessage);
    signal.addEventListener("abort", () => {
      window.removeEventListener("message", handleMessage);
    });
  },
);

export const openTelegramLoginPopup$ = command((_ctx, botId: string) => {
  openTelegramLoginPopup(botId);
});

export const disconnectTelegramAccount$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/telegram/link", {
    method: "DELETE",
  });

  if (!response.ok) {
    toast.error("Failed to disconnect Telegram account");
    return;
  }

  toast.success("Telegram account disconnected");
  await set(fetchTelegramIntegration$);
});

export const disconnectTelegram$ = command(async ({ get, set }) => {
  const fetchFn = get(fetch$);
  const response = await fetchFn("/api/integrations/telegram", {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error("Failed to disconnect Telegram");
  }

  // Re-fetch to get the updated state
  await set(fetchTelegramIntegration$);
});
