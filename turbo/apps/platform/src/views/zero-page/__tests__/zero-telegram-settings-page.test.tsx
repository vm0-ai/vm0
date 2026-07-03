import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
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

function setupTelegramPage(): void {
  context.mocks.data.team([zeroAgent(), supportAgent()]);
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
    click(within(dialog).getByText("Add bot"));

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
      expect(screen.getByText("Back to Telegram settings")).toBeInTheDocument();
    });
  });
});
