import { screen, waitFor } from "@testing-library/react";
import type { TelegramBotStatus } from "@okouai/api-contracts/contracts/integrations-telegram";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { parseTelegramConnectParams } from "../../../signals/okou-page/telegram-connect-params.ts";

const context = testContext();

const botId = "bot_connect_test";

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function telegramStatus(): TelegramBotStatus {
  return {
    id: botId,
    username: "agent_bot",
    avatarUrl: null,
    agent: { id: "c0000000-0000-4000-a000-000000000001", name: "zero" },
    isOwner: true,
    isConnected: false,
    connectedUser: null,
    tokenStatus: "valid",
    domainConfigured: true,
    environment: {
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    },
  };
}

function telegramConnectPath(): string {
  const params = new URLSearchParams({
    bot: botId,
    tgUser: "99001",
    tgUserName: "alice",
    tgDisplayName: "Alice Tester",
    ts: "1700000000",
    sig: "b".repeat(64),
    brand: "okou",
  });
  return `/telegram/connect?${params.toString()}`;
}

describe("zero Telegram connect page", () => {
  it("preserves a validated public brand in signed connect parameters", () => {
    const parsed = parseTelegramConnectParams(
      new URL(telegramConnectPath(), "https://app.okou.ai").searchParams,
    );
    expect(parsed).toMatchObject({
      ok: true,
      params: {
        telegramBotId: botId,
        connectSignature: { publicBrand: "okou" },
      },
    });
    if (!parsed.ok) {
      throw new Error("Expected branded Telegram connect params to parse");
    }
    expect(parsed.returnPath).toContain("brand=okou");
  });

  it("rejects an invalid public brand in signed connect parameters", () => {
    const params = new URL(telegramConnectPath(), "https://app.okou.ai")
      .searchParams;
    params.set("brand", "owner_named_bot");
    expect(parseTelegramConnectParams(params)).toMatchObject({
      ok: false,
      error: { code: "invalid_signature" },
    });
  });

  it("links the Telegram user and shows the connected state", async () => {
    context.mocks.data.telegramIntegration({
      statuses: [telegramStatus()],
    });
    context.mocks.browser.locationAssign();

    detachedSetupPage({ context, path: telegramConnectPath() });

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Link your account to this Telegram bot so you can interact with your agent directly from Telegram.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Connect"));

    await waitFor(() => {
      expect(screen.getByText("Connected to Telegram!")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "You're connected to @agent_bot. Send a message in Telegram to start chatting.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Open Telegram")).toBeInTheDocument();
    expect(screen.getByText("Back to Telegram settings")).toBeInTheDocument();
  });
});
