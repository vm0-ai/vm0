// @vitest-environment happy-dom

import { useAuth } from "@clerk/nextjs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { http } from "../../../../src/__tests__/msw";
import { server } from "../../../../src/mocks/server";
import { TelegramConnectClient } from "../TelegramConnectClient";
import {
  parseTelegramConnectParams,
  type TelegramConnectParams,
} from "../connect-params";

vi.mock("@clerk/nextjs", () => {
  return {
    useAuth: vi.fn(),
  };
});

const VALID_PARAMS: TelegramConnectParams = {
  telegramBotId: "bot-123",
  telegramUserId: "99002",
  timestamp: 1777200000,
  signature: "a".repeat(64),
};

function mockAuth(options: {
  isLoaded?: boolean;
  isSignedIn?: boolean;
  token?: string | null;
}) {
  vi.mocked(useAuth).mockReturnValue({
    isLoaded: options.isLoaded ?? true,
    isSignedIn: options.isSignedIn ?? true,
    getToken: vi.fn().mockResolvedValue(options.token ?? "test-token"),
  } as unknown as ReturnType<typeof useAuth>);
}

function renderConnectClient(params = VALID_PARAMS) {
  return render(
    <TelegramConnectClient
      params={params}
      paramError={null}
      returnPath="/telegram/connect?bot=bot-123&tgUser=99002&ts=1777200000&sig=aaaaaaaa"
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/telegram/connect", () => {
  it("rejects missing params before rendering the confirmation flow", () => {
    const parsed = parseTelegramConnectParams({
      bot: "bot-123",
      tgUser: "99002",
      ts: "1777200000",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.title).toBe("Connect link is incomplete");
    }
  });

  it("rejects malformed signatures before calling the link route", () => {
    const parsed = parseTelegramConnectParams({
      bot: "bot-123",
      tgUser: "99002",
      ts: "1777200000",
      sig: "not-a-signature",
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("signature");
    }
  });

  it("rejects malformed timestamps before calling the link route", () => {
    const parsed = parseTelegramConnectParams({
      bot: "bot-123",
      tgUser: "99002",
      ts: "1e3",
      sig: "a".repeat(64),
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("timestamp");
    }
  });

  it("requires sign-in before confirmation", () => {
    const handler = http.post("/api/integrations/telegram/link", () => {
      return HttpResponse.json({});
    });
    server.use(handler.handler);
    mockAuth({ isSignedIn: false });

    renderConnectClient();

    expect(
      screen.getByRole("link", { name: /sign in to vm0/i }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("/sign-in?redirect_url="),
    );
    expect(handler.mocked).not.toHaveBeenCalled();
  });

  it("posts telegramBotId and connectSignature on confirmation", async () => {
    let requestBody: unknown;
    let authorizationHeader: string | null = null;
    const handler = http.post(
      "/api/integrations/telegram/link",
      async ({ request }) => {
        authorizationHeader = request.headers.get("Authorization");
        requestBody = await request.json();
        return HttpResponse.json({
          botUsername: "vm0_test_bot",
          telegramUserId: "99002",
        });
      },
    );
    server.use(handler.handler);
    mockAuth({ token: "clerk-token" });

    renderConnectClient();
    await userEvent.click(
      screen.getByRole("button", { name: /connect telegram/i }),
    );

    await waitFor(() => {
      expect(handler.mocked).toHaveBeenCalledTimes(1);
    });
    expect(authorizationHeader).toBe("Bearer clerk-token");
    expect(requestBody).toEqual({
      telegramBotId: "bot-123",
      connectSignature: {
        telegramUserId: "99002",
        timestamp: 1777200000,
        signature: "a".repeat(64),
      },
    });
    expect(
      await screen.findByText(/telegram user 99002 is now linked/i),
    ).toBeInTheDocument();
  });

  it("surfaces invalid or expired signature errors from the backend", async () => {
    const handler = http.post("/api/integrations/telegram/link", () => {
      return HttpResponse.json(
        {
          error: {
            message:
              "Invalid or expired connect link. Please use /connect again in Telegram.",
          },
        },
        { status: 400 },
      );
    });
    server.use(handler.handler);
    mockAuth({ token: "clerk-token" });

    renderConnectClient();
    await userEvent.click(
      screen.getByRole("button", { name: /connect telegram/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid or expired connect link",
    );
  });
});
