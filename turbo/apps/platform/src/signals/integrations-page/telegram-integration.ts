import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { fetch$ } from "../fetch.ts";
import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("TelegramIntegration");

interface TelegramIntegrationData {
  installationId: string;
  bot: { id: string; username: string };
  agent: { id: string; name: string; scopeSlug: string } | null;
  isAdmin: boolean;
  isConnected: boolean;
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

interface TelegramAuthData {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

const connectTelegramViaLogin$ = command(
  async (
    { get, set },
    params: { installationId: string; auth: TelegramAuthData },
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

interface TelegramAuthResult {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

function extractAuth(d: Record<string, unknown>): TelegramAuthResult | null {
  if (!d.id || !d.auth_date || !d.hash) {
    return null;
  }
  return {
    id: Number(d.id),
    first_name: (d.first_name as string) ?? undefined,
    last_name: (d.last_name as string) ?? undefined,
    username: (d.username as string) ?? undefined,
    photo_url: (d.photo_url as string) ?? undefined,
    auth_date: Number(d.auth_date),
    hash: d.hash as string,
  };
}

function tryParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
  }
}

function parseTelegramPostMessage(data: unknown): TelegramAuthResult | null {
  // Telegram may double-encode the JSON string
  let raw: unknown = data;
  while (typeof raw === "string") {
    const parsed = tryParseJson(raw);
    if (parsed === undefined) {
      return null;
    }
    raw = parsed;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  // Our callback route sends { type: "telegram-auth", data: {...} }
  if (obj.type === "telegram-auth" && obj.data) {
    return extractAuth(obj.data as Record<string, unknown>);
  }

  // Telegram sends { event: "auth_result", result: {...} }
  if (obj.event === "auth_result" && obj.result) {
    return extractAuth(obj.result as Record<string, unknown>);
  }

  return null;
}

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
  // Telegram's /setdomain only accepts bare domains (no port), so origin
  // must strip the port. return_to keeps the full origin so the callback
  // reaches the correct server.
  const bareOrigin = `${window.location.protocol}//${window.location.hostname}`;
  const origin = encodeURIComponent(bareOrigin);
  const returnTo = encodeURIComponent(
    `${window.location.origin}/api/integrations/telegram/auth-callback`,
  );
  const authUrl = `https://oauth.telegram.org/auth?bot_id=${botId}&origin=${origin}&request_access=write&return_to=${returnTo}`;

  const width = 550;
  const height = 450;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;

  window.open(
    authUrl,
    "telegram_login",
    `width=${width},height=${height},left=${left},top=${top}`,
  );
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
