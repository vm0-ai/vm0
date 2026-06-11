import { screen, waitFor } from "@testing-library/react";
import {
  zeroIntegrationsTelegramContract,
  type TelegramBotStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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
  });
  return `/telegram/connect?${params.toString()}`;
}

function unsignedTelegramConnectPath(): string {
  return `/telegram/connect?bot=${botId}`;
}

describe("zero Telegram connect page", () => {
  it("shows an invalid state when the connect link is incomplete", async () => {
    detachedSetupPage({ context, path: "/telegram/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Connect link is incomplete"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Open a fresh /connect link from Telegram and try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to Telegram settings")).toBeInTheDocument();
  });

  it("shows an already-connected state for a linked Telegram user", async () => {
    context.mocks.data.telegramIntegration({
      statuses: [
        {
          ...telegramStatus(),
          isConnected: true,
          connectedUser: {
            telegramUserId: "99001",
            telegramUsername: "alice",
            telegramDisplayName: "Alice Tester",
          },
        },
      ],
    });
    context.mocks.api(
      zeroIntegrationsTelegramContract.getLinkStatus,
      ({ respond }) => {
        return respond(200, {
          linked: true,
          telegramUserId: "99001",
          botUsername: "agent_bot",
        });
      },
    );

    detachedSetupPage({ context, path: unsignedTelegramConnectPath() });

    await waitFor(() => {
      expect(
        screen.getByText("Already connected to Telegram"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("@agent_bot")).toBeInTheDocument();
    expect(screen.getByText("Open Telegram")).toBeInTheDocument();
    expect(screen.getByText("Back to Telegram settings")).toBeInTheDocument();
  });

  it("shows Telegram domain setup instructions before unsigned login", async () => {
    context.mocks.data.telegramIntegration({
      statuses: [
        {
          ...telegramStatus(),
          domainConfigured: false,
        },
      ],
    });
    context.mocks.api(
      zeroIntegrationsTelegramContract.getLinkStatus,
      ({ respond }) => {
        return respond(200, {
          linked: false,
          installation: {
            id: botId,
            botUsername: "agent_bot",
            domainConfigured: false,
          },
        });
      },
    );

    detachedSetupPage({ context, path: unsignedTelegramConnectPath() });

    await waitFor(() => {
      expect(screen.getByText("Set Telegram login domain")).toBeInTheDocument();
    });
    expect(screen.getByText("@agent_bot")).toBeInTheDocument();
    expect(screen.getByText("/setdomain")).toBeInTheDocument();
    expect(screen.getByText("/connect")).toBeInTheDocument();
    expect(screen.getByText("Checking domain status...")).toBeInTheDocument();
    expect(screen.getByText("Open BotFather")).toBeInTheDocument();
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
    expect(screen.getByText("@agent_bot")).toBeInTheDocument();
    expect(screen.getByText("Open Telegram")).toBeInTheDocument();
    expect(screen.getByText("Back to Telegram settings")).toBeInTheDocument();
  });

  it("links through Telegram web login when the connect link has no signature", async () => {
    context.mocks.data.telegramIntegration({
      statuses: [telegramStatus()],
    });
    context.mocks.api(
      zeroIntegrationsTelegramContract.getLinkStatus,
      ({ respond }) => {
        return respond(200, {
          linked: false,
          installation: {
            id: botId,
            botUsername: "agent_bot",
            loginBotId: botId,
            domainConfigured: true,
          },
        });
      },
    );
    const openMock = context.mocks.browser.open();
    context.mocks.browser.locationAssign();

    detachedSetupPage({ context, path: unsignedTelegramConnectPath() });

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
    });

    click(buttonByText("Continue with Telegram"));

    await waitFor(() => {
      expect(openMock.calls).toHaveLength(1);
    });
    const authUrl = new URL(openMock.calls[0]?.url ?? "");
    expect(authUrl.origin).toBe("https://oauth.telegram.org");
    expect(authUrl.searchParams.get("bot_id")).toBe(botId);
    expect(openMock.calls[0]?.target).toBe("telegram_login");

    window.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "telegram-auth",
          data: {
            id: 99_001,
            first_name: "Alice",
            last_name: "Tester",
            username: "alice",
            auth_date: 1_700_000_000,
            hash: "telegram-hash",
          },
        }),
      }),
    );

    await waitFor(() => {
      expect(screen.getByText("Connected to Telegram!")).toBeInTheDocument();
    });
    expect(screen.getByText("@agent_bot")).toBeInTheDocument();
    expect(screen.getByText("Open Telegram")).toBeInTheDocument();
  });
});
