import type { TelegramBotStatus } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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

function setupTelegramPage(): void {
  context.mocks.data.team([zeroAgent(), supportAgent()]);
  detachedSetupPage({
    context,
    path: "/settings/telegram",
  });
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((element) => {
    return element.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

describe("telegram settings page", () => {
  it("sets up a Telegram bot and redirects to the connect route", async () => {
    context.mocks.browser.clipboardWriteText();
    context.mocks.data.telegramIntegration({
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
    });
    click(screen.getByText("Add bot"));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("@BotFather")).toHaveAttribute(
      "href",
      "https://t.me/BotFather",
    );
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
    });
    click(within(dialog).getByText("Next"));
    await waitFor(() => {
      expect(
        within(dialog).getByText(
          "Domain is not visible to Telegram yet. Check BotFather and try again.",
        ),
      ).toBeInTheDocument();
    });

    context.mocks.data.telegramIntegration({
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
    });
    click(within(dialog).getByText("Next"));
    await waitFor(() => {
      expect(
        within(dialog).getByText(
          "Privacy mode still appears to be on. Turn it off in BotFather, then try again.",
        ),
      ).toBeInTheDocument();
    });

    context.mocks.data.telegramIntegration({
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
    click(within(dialog).getByText("Add bot"));

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
      expect(screen.getByText("Back to Telegram settings")).toBeInTheDocument();
    });
  });

  it("resets bot setup when the add dialog is reopened", async () => {
    context.mocks.data.telegramIntegration({
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
  });

  it("manages bots by ownership and refreshes Telegram status", async () => {
    context.mocks.data.telegramIntegration({
      statuses: [telegramStatus("alpha", { username: "alpha_bot" })],
    });

    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
      expect(screen.getByText("Not connected")).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("telegram:changed"),
      ).toBeTruthy();
    });

    context.mocks.data.telegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          isConnected: true,
          connectedUser: {
            telegramUserId: "tg_alpha",
            telegramUsername: "alpha_user",
            telegramDisplayName: "Alpha User",
          },
        }),
      ],
    });
    context.mocks.ably.trigger("telegram:changed");

    await waitFor(() => {
      expect(screen.getByText("Connected (@alpha_user)")).toBeInTheDocument();
    });

    const agentSelect = screen.getByLabelText("Default agent for alpha_bot");
    expect(agentSelect).toHaveTextContent("Zero");
    click(agentSelect);
    click(await screen.findByText("Support"));

    await waitFor(() => {
      expect(
        screen.getByLabelText("Default agent for alpha_bot"),
      ).toHaveTextContent("Support");
    });
  });

  it("limits non-admin non-owners to their own account connection actions", async () => {
    context.mocks.data.org({ role: "member" });
    context.mocks.data.telegramIntegration({
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
      expect(screen.getAllByText("Not connected").length).toBeGreaterThan(0);
    });
  });

  it("opens connect, reconnects invalid tokens, and uninstalls bots", async () => {
    context.mocks.data.telegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          tokenStatus: "invalid",
        }),
        telegramStatus("beta", { username: "beta_bot" }),
      ],
    });

    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
      expect(screen.getByText("Token invalid")).toBeInTheDocument();
    });

    click(screen.getByText("Reinstall"));
    let dialog = await screen.findByRole("dialog");
    await fill(screen.getByLabelText("New bot token"), "123:new-token");
    const reinstallButton = queryAllByRoleFast("button").find((element) => {
      return element.textContent === "Reinstall" && dialog.contains(element);
    });
    if (!reinstallButton) {
      throw new Error("Reinstall button not found");
    }
    click(reinstallButton);

    await waitFor(() => {
      expect(screen.queryByText("Token invalid")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("More options for @alpha_bot"));
    click(await screen.findByLabelText("Uninstall @alpha_bot"));

    dialog = await screen.findByRole("dialog");
    const uninstallButton = queryAllByRoleFast("button").find((element) => {
      return element.textContent === "Uninstall" && dialog.contains(element);
    });
    if (!uninstallButton) {
      throw new Error("Uninstall button not found");
    }
    click(uninstallButton);

    await waitFor(() => {
      expect(screen.queryByText("@alpha_bot")).not.toBeInTheDocument();
      expect(screen.getByText("@beta_bot")).toBeInTheDocument();
    });
  });

  it("shows connected identities and keeps bot dialogs cancelable", async () => {
    const alphaAvatarUrl = "/telegram/alpha/avatar.png";

    context.mocks.data.telegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
          avatarUrl: alphaAvatarUrl,
          tokenStatus: "invalid",
        }),
        telegramStatus("beta", {
          username: "beta_bot",
          isConnected: true,
          connectedUser: {
            telegramUserId: "tg_beta",
            telegramUsername: null,
            telegramDisplayName: "Beta User",
          },
        }),
        telegramStatus("gamma", {
          username: "gamma_bot",
          isConnected: true,
          connectedUser: {
            telegramUserId: "tg_gamma",
            telegramUsername: null,
            telegramDisplayName: "   ",
          },
        }),
      ],
    });

    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("Connected (Beta User)")).toBeInTheDocument();
      expect(screen.getByText("Connected (tg_gamma)")).toBeInTheDocument();
    });

    const alphaAvatar = screen.getByTestId(
      "telegram-bot-avatar-alpha",
    ) as HTMLImageElement;
    expect(alphaAvatar.src).toContain(alphaAvatarUrl);
    fireEvent.error(alphaAvatar);
    await waitFor(() => {
      expect(
        screen.getByTestId("telegram-bot-avatar-fallback-alpha"),
      ).toBeInTheDocument();
    });

    click(screen.getByText("Add bot"));
    let dialog = await screen.findByRole("dialog");
    click(buttonByText("Cancel", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(screen.getByText("Reinstall"));
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/fresh BotFather token for @alpha_bot/u),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("More options for @alpha_bot"));
    click(await screen.findByLabelText("Uninstall @alpha_bot"));
    dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/This removes @alpha_bot/u),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", dialog));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });
  });

  it("opens Telegram connect in a new tab for command-click style actions", async () => {
    context.mocks.data.telegramIntegration({
      statuses: [telegramStatus("alpha", { username: "alpha_bot" })],
    });
    const openMock = context.mocks.browser.open();

    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
    });

    const connectLink = queryAllByRoleFast("link").find((element) => {
      return element.textContent === "Connect";
    });
    if (!connectLink) {
      throw new Error("Telegram connect link not found");
    }
    fireEvent.click(connectLink, { metaKey: true });

    expect(connectLink).toHaveAttribute("href", "/telegram/connect?bot=alpha");
    expect(openMock.calls[0]?.url).toBe(
      `${window.location.origin}/telegram/connect?bot=alpha`,
    );
    expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
  });
});
