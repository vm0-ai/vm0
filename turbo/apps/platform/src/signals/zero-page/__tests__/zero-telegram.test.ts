import { describe, expect, it, vi } from "vitest";
import type { TelegramBotStatus } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { pathname$ } from "../../route.ts";
import {
  isTelegramIntegrationEnabled$,
  registerTelegramBot$,
  telegramBots$,
  uninstallTelegramBot$,
  updateTelegramBotAgent$,
} from "../zero-telegram.ts";
import {
  getMockTelegramIntegration,
  setMockTelegramIntegration,
} from "../../../mocks/handlers/api-integrations-telegram.ts";

const context = testContext();

function setup({
  path = "/",
  enabled = false,
}: {
  path?: string;
  enabled?: boolean;
} = {}) {
  detachedSetupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.TelegramIntegration]: enabled },
    withoutRender: true,
  });
}

function telegramStatus(
  id: string,
  overrides: Partial<TelegramBotStatus> = {},
): TelegramBotStatus {
  return {
    id,
    username: `${id}_bot`,
    agent: { id: "compose_1", name: "Default agent" },
    isOwner: true,
    isConnected: false,
    tokenStatus: "valid",
    domainConfigured: false,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
    ...overrides,
  };
}

describe("zero telegram signals", () => {
  it("derives frontend enablement from feature switches", async () => {
    setup({ enabled: true });

    await expect(
      context.store.get(isTelegramIntegrationEnabled$),
    ).resolves.toBeTruthy();
  });

  it("keeps the frontend gate disabled when the switch is off", async () => {
    setup({ enabled: false });

    await expect(
      context.store.get(isTelegramIntegrationEnabled$),
    ).resolves.toBeFalsy();
  });

  it("loads multiple Telegram bots from the multi-bot API", async () => {
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("bot_alpha"),
        telegramStatus("bot_beta", {
          agent: { id: "compose_2", name: "Support agent" },
          isConnected: true,
        }),
      ],
    });
    setup({ enabled: true });

    await expect(context.store.get(telegramBots$)).resolves.toMatchObject([
      { id: "bot_alpha", agent: { id: "compose_1" } },
      { id: "bot_beta", agent: { id: "compose_2" }, isConnected: true },
    ]);
  });

  it("registers a bot and refreshes the list state", async () => {
    setMockTelegramIntegration({ statuses: [] });
    setup({ enabled: true });

    const registered = await context.store.set(
      registerTelegramBot$,
      { botToken: "123:token", defaultAgentId: "compose_9" },
      context.signal,
    );
    const bots = await context.store.get(telegramBots$);

    expect(registered).toMatchObject({
      id: "bot_registered",
      agent: { id: "compose_9" },
    });
    expect(bots).toMatchObject([
      { id: "bot_registered", agent: { id: "compose_9" } },
    ]);
  });

  it("updates a bot default agent and refreshes mock state", async () => {
    setMockTelegramIntegration({
      statuses: [telegramStatus("bot_alpha")],
    });
    setup({ enabled: true });

    await context.store.set(
      updateTelegramBotAgent$,
      { botId: "bot_alpha", defaultAgentId: "compose_2" },
      context.signal,
    );

    expect(getMockTelegramIntegration().statuses.bot_alpha).toMatchObject({
      agent: { id: "compose_2" },
    });
    await expect(context.store.get(telegramBots$)).resolves.toMatchObject([
      { id: "bot_alpha", agent: { id: "compose_2" } },
    ]);
  });

  it("disconnects a bot and refreshes the list state", async () => {
    setMockTelegramIntegration({
      statuses: [telegramStatus("bot_alpha"), telegramStatus("bot_beta")],
    });
    setup({ enabled: true });

    await context.store.set(uninstallTelegramBot$, "bot_alpha", context.signal);

    await expect(context.store.get(telegramBots$)).resolves.toMatchObject([
      { id: "bot_beta" },
    ]);
    expect(getMockTelegramIntegration().statuses.bot_alpha).toBeUndefined();
  });
});

describe("telegram settings route gating", () => {
  it("redirects away from /settings/telegram when the switch is disabled", async () => {
    setup({ path: "/settings/telegram", enabled: false });

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/works");
    });
  });

  it("keeps /settings/telegram reachable when the switch is enabled", async () => {
    setup({ path: "/settings/telegram", enabled: true });

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/settings/telegram");
    });
  });
});
