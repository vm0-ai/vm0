// @vitest-environment happy-dom

import { useAuth } from "@clerk/nextjs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockAuth({ isSignedIn: false });

    renderConnectClient();

    expect(
      screen.getByRole("link", { name: /sign in to vm0/i }),
    ).toHaveAttribute(
      "href",
      expect.stringContaining("/sign-in?redirect_url="),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts telegramBotId and connectSignature on confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          botUsername: "vm0_test_bot",
          telegramUserId: "99002",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockAuth({ token: "clerk-token" });

    renderConnectClient();
    await userEvent.click(
      screen.getByRole("button", { name: /connect telegram/i }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/integrations/telegram/link",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer clerk-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          telegramBotId: "bot-123",
          connectSignature: {
            telegramUserId: "99002",
            timestamp: 1777200000,
            signature: "a".repeat(64),
          },
        }),
      }),
    );
    expect(
      await screen.findByText(/telegram user 99002 is now linked/i),
    ).toBeInTheDocument();
  });

  it("surfaces invalid or expired signature errors from the backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message:
                "Invalid or expired connect link. Please use /connect again in Telegram.",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
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
