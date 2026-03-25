import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { delay } from "signal-timers";
import {
  zeroIntegrationsTelegramContract,
  type TelegramOrgStatus,
} from "@vm0/core";
import { zeroClient$ } from "../api-client.ts";

interface TelegramOrgState {
  data: TelegramOrgStatus | null;
  loading: boolean;
  error: string | null;
}

const telegramOrgState$ = state<TelegramOrgState>({
  data: null,
  loading: false,
  error: null,
});

export const telegramOrgData$ = computed((get) => get(telegramOrgState$).data);

// ---------------------------------------------------------------------------
// Dialog visibility
// ---------------------------------------------------------------------------

const showInstallDialogState$ = state(false);

export const showTelegramInstallDialog$ = computed((get) =>
  get(showInstallDialogState$),
);

export const setShowTelegramInstallDialog$ = command(
  ({ set }, show: boolean) => {
    set(showInstallDialogState$, show);
  },
);

const showUninstallDialogState$ = state(false);

export const showTelegramUninstallDialog$ = computed((get) =>
  get(showUninstallDialogState$),
);

export const setShowTelegramUninstallDialog$ = command(
  ({ set }, show: boolean) => {
    set(showUninstallDialogState$, show);
  },
);

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const fetchTelegramOrg$ = command(async ({ get, set }) => {
  set(telegramOrgState$, (prev) => ({
    ...prev,
    loading: true,
    error: null,
  }));

  const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
  const result = await client.getStatus();

  if (result.status !== 200) {
    set(telegramOrgState$, (prev) => ({
      ...prev,
      loading: false,
      error: "Failed to fetch Telegram status",
    }));
    return;
  }

  set(telegramOrgState$, {
    data: result.body,
    loading: false,
    error: null,
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const installTelegramOrg$ = command(
  async (
    { get, set },
    params: {
      botToken: string;
      telegramAuth: Record<string, unknown>;
    },
  ) => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const result = await client.install({
      body: {
        botToken: params.botToken,
        telegramAuth: params.telegramAuth as Parameters<
          typeof client.install
        >[0]["body"]["telegramAuth"],
      },
    });

    if (result.status !== 201) {
      const errorBody = result.body as { error?: { message?: string } };
      toast.error(
        errorBody?.error?.message ?? "Failed to install Telegram bot",
      );
      return null;
    }

    toast.success("Telegram bot installed successfully");
    await set(fetchTelegramOrg$);
    return result.body;
  },
);

export const connectTelegramOrg$ = command(
  async (
    { get, set },
    params: {
      telegramAuth?: Record<string, unknown>;
      connectSignature?: {
        telegramUserId: string;
        timestamp: number;
        signature: string;
      };
    },
  ) => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const result = await client.connect({
      body: params as Parameters<typeof client.connect>[0]["body"],
    });

    if (result.status !== 200) {
      const errorBody = result.body as { error?: { message?: string } };
      toast.error(
        errorBody?.error?.message ?? "Failed to connect Telegram account",
      );
      return null;
    }

    toast.success("Telegram connected successfully");
    await set(fetchTelegramOrg$);
    return result.body;
  },
);

export const toggleTelegramOrg$ = command(
  async ({ get, set }, enabled: boolean) => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const result = await client.update({
      body: { enabled },
    });

    if (result.status !== 200) {
      toast.error("Failed to update Telegram bot");
      return;
    }

    toast.success(enabled ? "Telegram bot enabled" : "Telegram bot disabled");
    await set(fetchTelegramOrg$);
  },
);

export const disconnectTelegramOrg$ = command(async ({ get, set }) => {
  const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
  const result = await client.disconnect();

  if (result.status !== 200) {
    toast.error("Failed to disconnect Telegram");
    return;
  }

  toast.success("Disconnected from Telegram");
  await set(fetchTelegramOrg$);
});

export const uninstallTelegramOrg$ = command(async ({ get, set }) => {
  const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
  const result = await client.disconnect({
    query: { action: "uninstall" },
  });

  if (result.status !== 200) {
    toast.error("Failed to uninstall Telegram bot");
    return;
  }

  toast.success("Telegram bot uninstalled");
  await set(fetchTelegramOrg$);
});

// ---------------------------------------------------------------------------
// Polling — for member connect via /connect command in Telegram
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3000;

export const pollTelegramConnection$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = get(telegramOrgState$).data;
    if (current?.isConnected) {
      return;
    }

    while (!signal.aborted) {
      await delay(POLL_INTERVAL_MS, { signal });

      const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
      const result = await client.getStatus();
      signal.throwIfAborted();
      if (result.status !== 200) {
        continue;
      }

      set(telegramOrgState$, {
        data: result.body,
        loading: false,
        error: null,
      });

      if (result.body.isConnected) {
        toast.success("Telegram connected successfully");
        return;
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export const initTelegramOrg$ = command(async ({ set }) => {
  await set(fetchTelegramOrg$);
});
