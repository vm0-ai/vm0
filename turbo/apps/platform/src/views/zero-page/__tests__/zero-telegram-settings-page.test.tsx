import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

const context = testContext();

const ZERO_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000002";

function zeroAgent(): TeamComposeItem {
  return {
    id: ZERO_AGENT_ID,
    displayName: "Zero",
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

  it("shows the empty state and adds a Telegram bot", async () => {
    setMockTelegramIntegration({ statuses: [] });
    setupTelegramPage();

    await waitFor(() => {
      expect(screen.getByText("No Telegram bots yet")).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Bot token"), "123:token");
    click(screen.getByText("Add bot"));

    await waitFor(() => {
      expect(screen.getByText("@registered_bot")).toBeInTheDocument();
      expect(
        getMockTelegramIntegration().statuses.bot_registered,
      ).toBeDefined();
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
      expect(screen.getByText("Routes to default-agent")).toBeInTheDocument();
    });
  });

  it("disconnects a specific Telegram bot", async () => {
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

    const disconnectButton = screen.getAllByRole("button").find((element) => {
      return element.textContent === "Disconnect";
    });
    expect(disconnectButton).toBeDefined();
    click(disconnectButton!);

    await vi.waitFor(() => {
      expect(screen.queryByText("@alpha_bot")).not.toBeInTheDocument();
      expect(screen.getByText("@beta_bot")).toBeInTheDocument();
      expect(getMockTelegramIntegration().statuses.alpha).toBeUndefined();
    });
  });
});
