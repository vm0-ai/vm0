import { command, computed, state } from "ccstate";
import { toast } from "@vm0/ui/components/ui/sonner";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  zeroIntegrationsTelegramContract,
  type TelegramBot,
  type TelegramBotStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { zeroClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { accept } from "../../lib/accept.ts";

const internalReload$ = state(0);
const internalTelegramAddDialogOpen$ = state(false);
const internalTelegramBotTokenForm$ = state("");
const internalTelegramBotAgentForm$ = state<string | null>(null);
const internalTelegramSavingBotId$ = state<string | null>(null);
const internalTelegramUnlinkingBotId$ = state<string | null>(null);
const internalTelegramUninstallingBotId$ = state<string | null>(null);
const internalTelegramUninstallDialogBotId$ = state<string | null>(null);
const internalTelegramReinstallDialogBotId$ = state<string | null>(null);
const internalTelegramReinstallTokenForm$ = state("");
const internalTelegramReinstallingBotId$ = state<string | null>(null);

export const telegramBotTokenForm$ = computed((get) => {
  return get(internalTelegramBotTokenForm$);
});

export const telegramAddDialogOpen$ = computed((get) => {
  return get(internalTelegramAddDialogOpen$);
});

export const telegramBotAgentForm$ = computed((get) => {
  return get(internalTelegramBotAgentForm$);
});

export const telegramSavingBotId$ = computed((get) => {
  return get(internalTelegramSavingBotId$);
});

export const telegramUnlinkingBotId$ = computed((get) => {
  return get(internalTelegramUnlinkingBotId$);
});

export const telegramUninstallingBotId$ = computed((get) => {
  return get(internalTelegramUninstallingBotId$);
});

export const telegramUninstallDialogBotId$ = computed((get) => {
  return get(internalTelegramUninstallDialogBotId$);
});

export const telegramReinstallDialogBotId$ = computed((get) => {
  return get(internalTelegramReinstallDialogBotId$);
});

export const telegramReinstallTokenForm$ = computed((get) => {
  return get(internalTelegramReinstallTokenForm$);
});

export const telegramReinstallingBotId$ = computed((get) => {
  return get(internalTelegramReinstallingBotId$);
});

export const setTelegramBotTokenForm$ = command(({ set }, value: string) => {
  set(internalTelegramBotTokenForm$, value);
});

export const setTelegramAddDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalTelegramAddDialogOpen$, open);
  if (!open) {
    set(internalTelegramBotTokenForm$, "");
    set(internalTelegramBotAgentForm$, null);
  }
});

export const setTelegramBotAgentForm$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramBotAgentForm$, value);
  },
);

export const setTelegramSavingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramSavingBotId$, value);
  },
);

export const setTelegramUnlinkingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramUnlinkingBotId$, value);
  },
);

export const setTelegramUninstallingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramUninstallingBotId$, value);
  },
);

export const setTelegramUninstallDialogBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramUninstallDialogBotId$, value);
  },
);

export const setTelegramReinstallDialogBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramReinstallDialogBotId$, value);
    if (!value) {
      set(internalTelegramReinstallTokenForm$, "");
    }
  },
);

export const setTelegramReinstallTokenForm$ = command(
  ({ set }, value: string) => {
    set(internalTelegramReinstallTokenForm$, value);
  },
);

export const setTelegramReinstallingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramReinstallingBotId$, value);
  },
);

export const resetTelegramSettingsUi$ = command(({ set }) => {
  set(internalTelegramAddDialogOpen$, false);
  set(internalTelegramBotTokenForm$, "");
  set(internalTelegramBotAgentForm$, null);
  set(internalTelegramSavingBotId$, null);
  set(internalTelegramUnlinkingBotId$, null);
  set(internalTelegramUninstallingBotId$, null);
  set(internalTelegramUninstallDialogBotId$, null);
  set(internalTelegramReinstallDialogBotId$, null);
  set(internalTelegramReinstallTokenForm$, "");
  set(internalTelegramReinstallingBotId$, null);
});

export const isTelegramIntegrationEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.TelegramIntegration] ?? false;
});

export const telegramBots$ = computed(async (get): Promise<TelegramBot[]> => {
  get(internalReload$);
  const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
  const result = await accept(client.list({ headers: {} }), [200], {
    toast: false,
  });
  return result.body.bots;
});

const reloadTelegramBots$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

export const registerTelegramBot$ = command(
  async (
    { get, set },
    input: { botToken: string; defaultAgentId?: string },
    signal: AbortSignal,
  ): Promise<TelegramBotStatus> => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const result = await accept(
      client.register({
        headers: {},
        body: input,
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success("Telegram bot added");
    return (result as { body: TelegramBotStatus }).body;
  },
);

export const reinstallTelegramBot$ = command(
  async (
    { get, set },
    input: { botId: string; botToken: string },
    signal: AbortSignal,
  ): Promise<TelegramBotStatus> => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const result = await accept(
      client.register({
        headers: {},
        body: { botToken: input.botToken, reinstallBotId: input.botId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success("Telegram bot reinstalled");
    return (result as { body: TelegramBotStatus }).body;
  },
);

export const updateTelegramBotAgent$ = command(
  async (
    { get, set },
    input: { botId: string; defaultAgentId: string },
    signal: AbortSignal,
  ): Promise<TelegramBotStatus> => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    const result = await accept(
      client.updateBot({
        headers: {},
        params: { botId: input.botId },
        body: { defaultAgentId: input.defaultAgentId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success("Telegram bot updated");
    return (result as { body: TelegramBotStatus }).body;
  },
);

export const disconnectTelegramAccount$ = command(
  async ({ get, set }, botId: string, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    await accept(
      client.unlink({
        headers: {},
        query: { botId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success("Telegram account disconnected");
  },
);

export const uninstallTelegramBot$ = command(
  async ({ get, set }, botId: string, signal: AbortSignal): Promise<void> => {
    const client = get(zeroClient$)(zeroIntegrationsTelegramContract);
    await accept(
      client.disconnect({
        headers: {},
        params: { botId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success("Telegram bot uninstalled");
  },
);
