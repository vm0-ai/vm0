import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("TelegramIntegration");

interface TelegramIntegrationData {
  bot: { id: string; username: string };
  agent: { id: string; name: string; scopeSlug: string } | null;
  isAdmin: boolean;
  needsLink: boolean;
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
            : { id: "", name: agentName, scopeSlug: "" },
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
