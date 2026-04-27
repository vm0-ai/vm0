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
const internalTelegramBotTokenForm$ = state("");
const internalTelegramBotAgentForm$ = state<string | null>(null);
const internalTelegramSavingBotId$ = state<string | null>(null);
const internalTelegramDisconnectingBotId$ = state<string | null>(null);

export const telegramBotTokenForm$ = computed((get) => {
  return get(internalTelegramBotTokenForm$);
});

export const telegramBotAgentForm$ = computed((get) => {
  return get(internalTelegramBotAgentForm$);
});

export const telegramSavingBotId$ = computed((get) => {
  return get(internalTelegramSavingBotId$);
});

export const telegramDisconnectingBotId$ = computed((get) => {
  return get(internalTelegramDisconnectingBotId$);
});

export const setTelegramBotTokenForm$ = command(({ set }, value: string) => {
  set(internalTelegramBotTokenForm$, value);
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

export const setTelegramDisconnectingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramDisconnectingBotId$, value);
  },
);

export const resetTelegramSettingsUi$ = command(({ set }) => {
  set(internalTelegramBotTokenForm$, "");
  set(internalTelegramBotAgentForm$, null);
  set(internalTelegramSavingBotId$, null);
  set(internalTelegramDisconnectingBotId$, null);
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

export const disconnectTelegramBot$ = command(
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
    toast.success("Telegram bot disconnected");
  },
);
