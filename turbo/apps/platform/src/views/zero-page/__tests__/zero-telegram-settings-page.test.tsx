import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { TelegramBotStatus } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
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
    featureSwitches: { [FeatureSwitchKey.TelegramIntegration]: true },
  });
}

describe("telegram settings page", () => {
  beforeEach(() => {
    resetMockOrg();
  });

  it("lists multiple Telegram bots", async () => {
    setMockTelegramIntegration({
      statuses: [
        telegramStatus("alpha", {
          username: "alpha_bot",
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
      expect(screen.getByText("@alpha_bot")).toBeInTheDocument();
      expect(screen.getByText("@beta_bot")).toBeInTheDocument();
      expect(screen.getByTestId("telegram-bot-count")).toHaveTextContent(
        "2 bots",
      );
    });
  });

  it("shows the empty state and redirects to connect after adding a Telegram bot", async () => {
    setMockTelegramIntegration({ statuses: [] });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("No Telegram bots yet")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Default agent")).toHaveTextContent("Zero");
    });

    await fill(screen.getByLabelText("Bot token"), "123:token");
    click(screen.getByText("Add bot"));

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
      expect(screen.getByText("Routes to Support")).toBeInTheDocument();
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
      expect(screen.getByText("Routes to Support")).toBeInTheDocument();
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
