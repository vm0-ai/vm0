import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { TelegramBotStatus } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import {
  getMockTelegramIntegration,
  setMockTelegramIntegration,
} from "../../../mocks/handlers/api-integrations-telegram.ts";
import { hasSubscription, triggerAblyEvent } from "../../../mocks/ably.ts";
import { resetMockOrg, setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { pathname$, searchParams$ } from "../../../signals/route.ts";

const context = testContext();

const ZERO_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000002";

function zeroAgent(): TeamComposeItem {
  return {
    id: ZERO_AGENT_ID,
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function supportAgent(): TeamComposeItem {
  return {
    id: SUPPORT_AGENT_ID,
    displayName: "Support",
    description: null,
    sound: null,
    avatarUrl: null,
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  };
}

function telegramStatus(
  id: string,
  overrides: Partial<TelegramBotStatus> = {},
): TelegramBotStatus {
  return {
    id,
    username: `${id}_bot`,
    avatarUrl: null,
    agent: { id: ZERO_AGENT_ID, name: "Zero" },
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

function setupTelegramPage() {
  setMockTeam([zeroAgent(), supportAgent()]);
  detachedSetupPage({
    context,
    path: "/settings/telegram",
  });
}

describe("telegram settings page", () => {
  beforeEach(() => {
    resetMockOrg();
  });

  it("lists multiple Telegram bots", async () => {
    const alphaAvatarPath = `/${[
      "api",
      "integrations",
      "telegram",
      "alpha",
      "avatar",
    ].join("/")}`;
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          avatarUrl: alphaAvatarPath,
          isConnected: true,
        }),
        telegramStatus("beta", {
          username: "beta_bot",
          agent: { id: SUPPORT_AGENT_ID, name: "Support" },
        }),
      ],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByTestId("telegram-beta-badge")).toHaveTextContent(
        "Beta",
      );
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
      expect(screen.getByText("@beta_bot")).toBeInTheDocument();
      expect(
        screen.getByTestId("telegram-bot-avatar-fallback-beta"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("telegram-bot-count")).toHaveTextContent(
        "This organization has 2 Telegram bots",
      );
    });

    const alphaAvatar = screen.getByTestId("telegram-bot-avatar-alpha");
    expect(alphaAvatar).toHaveAttribute(
      "src",
      `http://localhost:3000${alphaAvatarPath}`,
    );
    fireEvent.error(alphaAvatar);
    expect(
      screen.getByTestId("telegram-bot-avatar-fallback-alpha"),
    ).toBeInTheDocument();
  });

  it("refreshes connection status when Telegram changes over Ably", async () => {
    setMockTelegramIntegration({
      statuses: [telegramStatus("alpha", { username: "alpha_bot" })],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
      expect(screen.getByText("Not connected")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(hasSubscription("telegram:changed")).toBeTruthy();
    });

    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          isConnected: true,
        }),
      ],
    });
    triggerAblyEvent("telegram:changed");

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });

  it("walks through Telegram bot setup and redirects to connect after adding a bot", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    setMockTelegramIntegration({
      statuses: [],
      setupStatus: {
        id: "bot_registered",
        username: "registered_bot",
        domainConfigured: false,
        privacyDisabled: false,
      },
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("No Telegram bots yet")).toBeInTheDocument();
      expect(screen.getByTestId("telegram-bot-count")).toHaveTextContent(
        "This organization has no Telegram bots",
      );
    });

    click(screen.getByText("Add bot"));
    const dialog = await screen.findByRole("dialog");

    const botFatherLink = within(dialog).getByText("@BotFather");
    expect(botFatherLink).toHaveAttribute("href", "https://t.me/BotFather");
    expect(within(dialog).getByText("/newbot")).toBeInTheDocument();

    click(within(dialog).getByLabelText("Copy /newbot"));
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Copy /newbot")).toHaveTextContent(
        "copied!",
      );
    });
    await fill(screen.getByLabelText("Bot token"), "123:token");
    click(within(dialog).getByText("Next"));

    await waitFor(() => {
      expect(within(dialog).getByText("/setdomain")).toBeInTheDocument();
      expect(within(dialog).getByText(location.hostname)).toBeInTheDocument();
    });
    click(within(dialog).getByLabelText("Copy /setdomain"));
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Copy /setdomain"),
      ).toHaveTextContent("copied!");
    });
    click(within(dialog).getByLabelText(`Copy ${location.hostname}`));
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText(`Copy ${location.hostname}`),
      ).toHaveTextContent("copied!");
    });
    click(within(dialog).getByText("Next"));
    await waitFor(() => {
      expect(
        within(dialog).getByText(
          "Domain is not visible to Telegram yet. Check BotFather and try again.",
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("Set the Telegram login domain"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(/allow the connect flow for this bot/),
      ).toBeInTheDocument();
    });
    setMockTelegramIntegration({
      setupStatus: {
        id: "bot_registered",
        username: "registered_bot",
        domainConfigured: true,
        privacyDisabled: false,
      },
    });
    click(within(dialog).getByText("Next"));

    await waitFor(() => {
      expect(within(dialog).getByText("/setprivacy")).toBeInTheDocument();
      expect(within(dialog).getByText("disable")).toBeInTheDocument();
      expect(
        within(dialog).getByText(
          /read group context around mentions and replies/,
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText("If you keep privacy mode on"),
      ).not.toBeInTheDocument();
    });
    click(within(dialog).getByLabelText("Copy /setprivacy"));
    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Copy /setprivacy"),
      ).toHaveTextContent("copied!");
    });
    click(within(dialog).getByText("Next"));
    await waitFor(() => {
      expect(
        within(dialog).getByText(
          "Privacy mode still appears to be on. Turn it off in BotFather, then try again.",
        ),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("Optional: turn off privacy mode"),
      ).toBeInTheDocument();
    });
    setMockTelegramIntegration({
      setupStatus: {
        id: "bot_registered",
        username: "registered_bot",
        domainConfigured: true,
        privacyDisabled: true,
      },
    });
    click(within(dialog).getByText("Next"));

    await waitFor(() => {
      expect(screen.getByLabelText("Default agent")).toHaveTextContent("Zero");
      expect(
        within(dialog).getByText(/mention the bot in a group or send it a DM/),
      ).toBeInTheDocument();
      expect(
        within(dialog).queryByText(
          "Privacy mode still appears to be on. Turn it off in BotFather, then try again.",
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      getMockTelegramIntegration().statuses.bot_registered,
    ).toBeUndefined();
    expect(context.store.get(pathname$)).toBe("/settings/telegram");

    click(within(dialog).getByText("Add bot"));

    await waitFor(() => {
      expect(
        getMockTelegramIntegration().statuses.bot_registered,
      ).toBeDefined();
      expect(context.store.get(pathname$)).toBe("/telegram/connect");
      expect(context.store.get(searchParams$).get("bot")).toBe(
        "bot_registered",
      );
    });
  });

  it("allows privacy confirmation before creating a Telegram bot", async () => {
    setMockTelegramIntegration({
      statuses: [],
      setupStatus: {
        id: "bot_registered",
        username: "registered_bot",
        domainConfigured: true,
        privacyDisabled: false,
      },
    });
    setupTelegramPage();

    click(await screen.findByText("Add bot"));
    const dialog = await screen.findByRole("dialog");
    await fill(screen.getByLabelText("Bot token"), "123:token");
    click(within(dialog).getByText("Next"));
    await waitFor(() => {
      expect(within(dialog).getByText("Domain detected")).toBeInTheDocument();
    });
    click(within(dialog).getByText("Next"));

    setMockTelegramIntegration({
      setupStatus: {
        id: "bot_registered",
        username: "registered_bot",
        domainConfigured: true,
        privacyDisabled: true,
      },
    });
    click(within(dialog).getByText("Next"));

    await waitFor(() => {
      expect(screen.getByLabelText("Default agent")).toHaveTextContent("Zero");
    });
    expect(
      getMockTelegramIntegration().statuses.bot_registered,
    ).toBeUndefined();
    expect(context.store.get(pathname$)).toBe("/settings/telegram");
    click(within(dialog).getByText("Add bot"));

    await waitFor(() => {
      expect(
        getMockTelegramIntegration().statuses.bot_registered,
      ).toBeDefined();
      expect(context.store.get(pathname$)).toBe("/telegram/connect");
    });
  });

  it("resets Telegram bot setup when reopening the add bot dialog", async () => {
    setMockTelegramIntegration({
      statuses: [],
      setupStatus: {
        id: "bot_registered",
        username: "registered_bot",
        domainConfigured: true,
        privacyDisabled: false,
      },
    });
    setupTelegramPage();

    click(await screen.findByText("Add bot"));
    let dialog = await screen.findByRole("dialog");
    await fill(screen.getByLabelText("Bot token"), "123:token");
    click(within(dialog).getByText("Next"));
    await waitFor(() => {
      expect(
        within(dialog).getByText("Set the Telegram login domain"),
      ).toBeInTheDocument();
    });

    click(within(dialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(screen.getByText("Add bot"));
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Create a bot token in BotFather"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Bot token")).toHaveValue("");
    expect(
      within(dialog).queryByText("Set the Telegram login domain"),
    ).not.toBeInTheDocument();
  });

  it("updates a bot default agent from the agent select", async () => {
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          agent: { id: ZERO_AGENT_ID, name: "Zero" },
        }),
      ],
    });
    setupTelegramPage();

    const agentSelect = await screen.findByLabelText(
      "Default agent for alpha_bot",
    );
    expect(agentSelect).toHaveTextContent("Zero");
    click(agentSelect);
    await waitFor(() => {
      expect(screen.getAllByText("Support").length).toBeGreaterThan(0);
    });
    const supportOption = screen.getAllByText("Support").find((element) => {
      return element.tagName.toLowerCase() !== "option";
    });
    expect(supportOption).toBeDefined();
    click(supportOption!);

    await waitFor(() => {
      expect(getMockTelegramIntegration().statuses.alpha).toMatchObject({
        agent: { id: SUPPORT_AGENT_ID },
      });
      expect(screen.queryByText("Routes to Support")).not.toBeInTheDocument();
    });
  });

  it("lets org admins manage bots owned by another user", async () => {
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          isOwner: false,
          agent: { id: ZERO_AGENT_ID, name: "Zero" },
        }),
      ],
    });
    setupTelegramPage();

    const agentSelect = await screen.findByLabelText(
      "Default agent for alpha_bot",
    );
    expect(agentSelect).toHaveTextContent("Zero");
    click(agentSelect);
    await waitFor(() => {
      expect(screen.getAllByText("Support").length).toBeGreaterThan(0);
    });
    const supportOption = screen.getAllByText("Support").find((element) => {
      return element.tagName.toLowerCase() !== "option";
    });
    expect(supportOption).toBeDefined();
    click(supportOption!);

    await waitFor(() => {
      expect(getMockTelegramIntegration().statuses.alpha).toMatchObject({
        agent: { id: SUPPORT_AGENT_ID },
      });
      expect(screen.queryByText("Routes to Support")).not.toBeInTheDocument();
    });
  });

  it("limits non-admin non-owners to account connection actions", async () => {
    setMockOrg({ role: "member" });
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          isOwner: false,
          isConnected: false,
        }),
      ],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });

    expect(
      screen.queryByLabelText("Default agent for alpha_bot"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("More options for @alpha_bot"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Uninstall")).not.toBeInTheDocument();

    const connectLink = screen.getAllByRole("link").find((element) => {
      return element.textContent === "Connect";
    });
    expect(connectLink).toBeDefined();
    expect(connectLink).toHaveAttribute("href", "/telegram/connect?bot=alpha");
  });

  it("lets non-admin non-owners disconnect their own Telegram link only", async () => {
    setMockOrg({ role: "member" });
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          isOwner: false,
          isConnected: true,
        }),
      ],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });

    expect(
      screen.queryByLabelText("Default agent for alpha_bot"),
    ).not.toBeInTheDocument();
    click(screen.getByLabelText("More options for @alpha_bot"));
    const disconnectButton = await screen.findByLabelText(
      "Disconnect @alpha_bot",
    );
    expect(screen.queryByText("Uninstall")).not.toBeInTheDocument();
    click(disconnectButton);

    await waitFor(() => {
      expect(getMockTelegramIntegration().statuses.alpha).toMatchObject({
        isConnected: false,
      });
      expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
    });
  });

  it("disconnects a Telegram account without uninstalling the bot", async () => {
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          isConnected: true,
        }),
        telegramStatus("beta", { username: "beta_bot" }),
      ],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });

    expect(screen.queryByText("Uninstall")).not.toBeInTheDocument();
    click(screen.getByLabelText("More options for @alpha_bot"));
    const disconnectButton = await screen.findByLabelText(
      "Disconnect @alpha_bot",
    );
    expect(screen.queryByText("Uninstall")).not.toBeInTheDocument();
    expect(disconnectButton).toBeDefined();
    click(disconnectButton);

    await vi.waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
      expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
      expect(screen.getByText("@beta_bot")).toBeInTheDocument();
      expect(getMockTelegramIntegration().statuses.alpha).toMatchObject({
        isConnected: false,
      });
    });
  });

  it("opens the connect route for an unconnected Telegram bot", async () => {
    setMockTelegramIntegration({
      statuses: [telegramStatus("alpha", { username: "alpha_bot" })],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });

    const connectLink = screen.getAllByRole("link").find((element) => {
      return element.textContent === "Connect";
    });
    expect(connectLink).toBeDefined();
    expect(connectLink).toHaveAttribute("href", "/telegram/connect?bot=alpha");
    click(connectLink!);

    await waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/telegram/connect");
    });
  });

  it("reinstalls an invalid Telegram bot token from settings", async () => {
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          tokenStatus: "invalid",
        }),
      ],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
      expect(screen.getByText("Token invalid")).toBeInTheDocument();
    });

    click(screen.getByText("Reinstall"));
    const dialog = await screen.findByRole("dialog");
    await fill(screen.getByLabelText("New bot token"), "123:new-token");
    const reinstallButton = screen.getAllByRole("button").find((element) => {
      return element.textContent === "Reinstall" && dialog.contains(element);
    });
    expect(reinstallButton).toBeDefined();
    click(reinstallButton!);

    await waitFor(() => {
      expect(getMockTelegramIntegration().statuses.alpha).toMatchObject({
        tokenStatus: "valid",
      });
      expect(screen.queryByText("Token invalid")).not.toBeInTheDocument();
    });
  });

  it("opens the connect route in a new tab on command click", async () => {
    setMockTelegramIntegration({
      statuses: [telegramStatus("alpha", { username: "alpha_bot" })],
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });

    const connectLink = screen.getAllByRole("link").find((element) => {
      return element.textContent === "Connect";
    });
    expect(connectLink).toBeDefined();
    fireEvent.click(connectLink!, { metaKey: true });

    expect(openSpy).toHaveBeenCalledWith(
      `${window.location.origin}/telegram/connect?bot=alpha`,
      "_blank",
    );
    expect(context.store.get(pathname$)).toBe("/settings/telegram");
  });

  it("uninstalls a specific Telegram bot after confirmation", async () => {
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", { username: "alpha_bot" }),
        telegramStatus("beta", { username: "beta_bot" }),
      ],
    });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options for @alpha_bot"));
    const uninstallButton = await screen.findByLabelText(
      "Uninstall @alpha_bot",
    );
    click(uninstallButton);

    const dialog = await screen.findByRole("dialog");
    const confirmButton = screen.getAllByRole("button").find((element) => {
      return element.textContent === "Uninstall" && dialog.contains(element);
    });
    expect(confirmButton).toBeDefined();
    click(confirmButton!);

    await vi.waitFor(() => {
      expect(screen.queryByText("@alpha_bot")).not.toBeInTheDocument();
      expect(screen.getByText("@beta_bot")).toBeInTheDocument();
      expect(getMockTelegramIntegration().statuses.alpha).toBeUndefined();
    });
  });
});
