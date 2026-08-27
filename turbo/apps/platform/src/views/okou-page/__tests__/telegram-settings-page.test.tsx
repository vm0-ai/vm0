import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  holdElementAnimations,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

// Keep runtime route-import transforms outside assertion timeouts. Production
// still resolves this module only after matching a settings route.
import "../../../signals/route-setups/settings.ts";

const context = testContext();

const ZERO_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000002";

function agent(): AgentResponse {
  return {
    agentId: ZERO_AGENT_ID,
    ownerId: "user_mock",
    displayName: null,
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
}

function supportAgent(): AgentResponse {
  return {
    agentId: SUPPORT_AGENT_ID,
    ownerId: "user_mock",
    displayName: "Support",
    description: null,
    sound: null,
    avatarUrl: null,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "private",
  };
}

function setupTelegramPage(): void {
  context.mocks.data.agents([agent(), supportAgent()]);
  detachedSetupPage({
    context,
    path: "/settings/telegram",
  });
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
    const createStep = within(dialog).getByText(
      "Ready to create the integration",
    );
    const finishCloseAnimation = holdElementAnimations(dialog);
    click(within(dialog).getByText("Add bot"));

    await waitFor(() => {
      expect(within(dialog).getByText("Add bot")).toBeEnabled();
    });
    expect(dialog).toBeInTheDocument();
    expect(createStep).toBeVisible();

    finishCloseAnimation();

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
      expect(screen.getByText("Back to Telegram settings")).toBeInTheDocument();
    });
  });
});
