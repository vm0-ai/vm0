import { describe, expect, it, vi } from "vitest";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { TelegramBotStatus } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
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

function setup({ path = "/" }: { path?: string } = {}) {
  detachedSetupPage({
    context,
    path,
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
    avatarUrl: null,
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
    setup();

    await expect(context.store.get(telegramBots$)).resolves.toMatchObject([
      { id: "bot_alpha", agent: { id: "compose_1" } },
      { id: "bot_beta", agent: { id: "compose_2" }, isConnected: true },
    ]);
  });

  it("registers a bot and refreshes the list state", async () => {
    setMockTelegramIntegration({ statuses: [] });
    setup();

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
    const toastId = "telegram-agent-toast";
    const loadingSpy = vi.spyOn(toast, "loading").mockImplementation(() => {
      return toastId as ReturnType<typeof toast.loading>;
    });
    const successSpy = vi.spyOn(toast, "success").mockImplementation(() => {
      return toastId as ReturnType<typeof toast.success>;
    });
    setMockTelegramIntegration({
      statuses: [telegramStatus("bot_alpha")],
    });
    setup();

    await context.store.set(
      updateTelegramBotAgent$,
      { botId: "bot_alpha", defaultAgentId: "compose_2" },
      context.signal,
    );

    expect(getMockTelegramIntegration().statuses.bot_alpha).toMatchObject({
      agent: { id: "compose_2" },
    });
    expect(loadingSpy).toHaveBeenCalledWith("Updating default agent...");
    expect(successSpy).toHaveBeenCalledWith("Default agent updated", {
      id: toastId,
    });
    await expect(context.store.get(telegramBots$)).resolves.toMatchObject([
      { id: "bot_alpha", agent: { id: "compose_2" } },
    ]);
    loadingSpy.mockRestore();
    successSpy.mockRestore();
  });

  it("disconnects a bot and refreshes the list state", async () => {
    setMockTelegramIntegration({
      statuses: [telegramStatus("bot_alpha"), telegramStatus("bot_beta")],
    });
    setup();

    await context.store.set(uninstallTelegramBot$, "bot_alpha", context.signal);

    await expect(context.store.get(telegramBots$)).resolves.toMatchObject([
      { id: "bot_beta" },
    ]);
    expect(getMockTelegramIntegration().statuses.bot_alpha).toBeUndefined();
  });
});
