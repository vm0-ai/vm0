import { screen, waitFor } from "@testing-library/react";
import {
  integrationsTelegramContract,
  type TelegramBotStatus,
} from "@okouai/api-contracts/contracts/integrations-telegram";
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

function telegramConnectPath(signature = "b".repeat(64)): string {
  const params = new URLSearchParams({
    bot: botId,
    tgUser: "99001",
    tgUserName: "alice",
    tgDisplayName: "Alice Tester",
    ts: "1700000000",
    sig: signature,
  });
  return `/telegram/connect?${params.toString()}`;
}

describe("zero Telegram connect page", () => {
  it("shows invalid signed links through the rendered page", async () => {
    detachedSetupPage({ context, path: telegramConnectPath("invalid") });

    await expect(
      screen.findByRole("heading", { name: "Connect link is invalid" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByText("The signature on this link is not valid."),
    ).toBeInTheDocument();
  });

  it("links the Telegram user and shows the connected state", async () => {
    let capturedLinkBody: unknown = null;
    context.mocks.data.telegramIntegration({
      statuses: [telegramStatus()],
    });
    context.mocks.api(
      integrationsTelegramContract.link,
      ({ body, respond }) => {
        capturedLinkBody = body;
        return respond(200, {
          botUsername: "agent_bot",
          telegramUserId: "99001",
        });
      },
    );
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
    // Product brand is carried by the app/API Host. Keeping this request body
    // byte-for-byte compatible lets old and new app/API versions interoperate.
    expect(capturedLinkBody).toStrictEqual({
      telegramBotId: botId,
      connectSignature: {
        telegramUserId: "99001",
        telegramUsername: "alice",
        telegramDisplayName: "Alice Tester",
        timestamp: 1_700_000_000,
        signature: "b".repeat(64),
      },
    });
  });
});
