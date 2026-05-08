import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { zeroIntegrationsTelegramContract } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { parseTelegramConnectParams } from "../../../signals/zero-page/telegram-connect-params.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const context = testContext();
const mockApi = createMockApi(context);

const VALID_PATH =
  "/telegram/connect?bot=bot-123&tgUser=99002&ts=1777200000&sig=" +
  "a".repeat(64) +
  "&tgUserName=ada_tg&tgDisplayName=Ada%20Lovelace";

function buttonWithText(text: string): HTMLButtonElement {
  const button = screen.getAllByRole("button").find((element) => {
    return element.textContent === text;
  });
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

function buttonWithAriaLabel(label: string): HTMLButtonElement {
  const button = screen.getAllByRole("button").find((element) => {
    return element.getAttribute("aria-label") === label;
  });
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

describe("zero telegram connect page", () => {
  it("rejects missing params before rendering the confirmation flow", () => {
    const parsed = parseTelegramConnectParams(
      new URLSearchParams({
        bot: "bot-123",
        tgUser: "99002",
        ts: "1777200000",
      }),
    );

    expect(parsed.ok).toBeFalsy();
    if (!parsed.ok) {
      expect(parsed.error.title).toBe("Connect link is incomplete");
    }
  });

  it("rejects malformed signatures before calling the link route", () => {
    const parsed = parseTelegramConnectParams(
      new URLSearchParams({
        bot: "bot-123",
        tgUser: "99002",
        ts: "1777200000",
        sig: "not-a-signature",
      }),
    );

    expect(parsed.ok).toBeFalsy();
    if (!parsed.ok) {
      expect(parsed.error.message).toContain("signature");
    }
  });

  it("requires sign-in before confirmation", async () => {
    let called = false;
    mockedClerk.redirectToSignIn.mockClear();
    server.use(
      mockApi(zeroIntegrationsTelegramContract.link, ({ respond }) => {
        called = true;
        return respond(200, {
          botUsername: "vm0_test_bot",
          telegramUserId: "99002",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: VALID_PATH,
      user: null,
      session: null,
    });

    await waitFor(() => {
      expect(mockedClerk.redirectToSignIn).toHaveBeenCalledWith();
    });
    expect(called).toBeFalsy();
  });

  it("posts telegramBotId and connectSignature on confirmation", async () => {
    let requestBody: unknown;
    let authorizationHeader: string | null = null;
    const assignSpy = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});

    server.use(
      mockApi(
        zeroIntegrationsTelegramContract.link,
        ({ body, request, respond }) => {
          authorizationHeader = request.headers.get("Authorization");
          requestBody = body;
          return respond(200, {
            botUsername: "vm0_test_bot",
            telegramUserId: "99002",
          });
        },
      ),
    );

    detachedSetupPage({
      context,
      path: VALID_PATH,
      session: { token: "clerk-token" },
    });

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Link your account to this Telegram bot so you can interact with your agent directly from Telegram.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("99002")).not.toBeInTheDocument();
    expect(screen.queryByText("Use Telegram Login")).not.toBeInTheDocument();
    click(buttonWithText("Connect"));

    await waitFor(() => {
      expect(authorizationHeader).toBe("Bearer clerk-token");
    });
    expect(requestBody).toStrictEqual({
      telegramBotId: "bot-123",
      connectSignature: {
        telegramUserId: "99002",
        telegramUsername: "ada_tg",
        telegramDisplayName: "Ada Lovelace",
        timestamp: 1_777_200_000,
        signature: "a".repeat(64),
      },
    });
    await expect(
      screen.findByText("Connected to Telegram!"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("@vm0_test_bot")).toBeInTheDocument();
    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith(
        "tg://resolve?domain=vm0_test_bot",
      );
    });
  });

  it("shows already connected state when the current user is linked", async () => {
    let linkCalled = false;
    server.use(
      mockApi(
        zeroIntegrationsTelegramContract.getLinkStatus,
        ({ query, respond }) => {
          expect(query.botId).toBe("bot-123");
          return respond(200, {
            linked: true,
            telegramUserId: "99002",
            botUsername: "vm0_test_bot",
          });
        },
      ),
      mockApi(zeroIntegrationsTelegramContract.link, ({ respond }) => {
        linkCalled = true;
        return respond(200, {
          botUsername: "vm0_test_bot",
          telegramUserId: "99002",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: VALID_PATH,
      session: { token: "clerk-token" },
    });

    await expect(
      screen.findByText("Already connected to Telegram"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("@vm0_test_bot")).toBeInTheDocument();
    expect(screen.queryByText("99002")).not.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    expect(screen.queryByText("Use Telegram Login")).not.toBeInTheDocument();
    expect(linkCalled).toBeFalsy();
  });

  it("opens Telegram Login and links the returned Telegram user", async () => {
    let requestBody: unknown;
    const assignSpy = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    server.use(
      mockApi(
        zeroIntegrationsTelegramContract.getLinkStatus,
        ({ query, respond }) => {
          expect(query.botId).toBe("bot-123");
          expect(query.origin).toBe(window.location.origin);
          return respond(200, {
            linked: false,
            installation: {
              id: "bot-123",
              botUsername: "vm0_test_bot",
              domainConfigured: true,
            },
          });
        },
      ),
      mockApi(zeroIntegrationsTelegramContract.link, ({ body, respond }) => {
        requestBody = body;
        return respond(200, {
          botUsername: "vm0_test_bot",
          telegramUserId: "99003",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/telegram/connect?bot=bot-123",
      session: { token: "clerk-token" },
    });

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
    });
    click(buttonWithText("Continue with Telegram"));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("https://oauth.telegram.org/auth"),
        "telegram_login",
        expect.stringContaining("width=550"),
      );
    });
    const rawAuthUrl = String(openSpy.mock.calls[0]?.[0]);
    const authUrl = new URL(rawAuthUrl);
    expect(`${authUrl.origin}${authUrl.pathname}`).toBe(
      "https://oauth.telegram.org/auth",
    );
    expect(authUrl.searchParams.get("bot_id")).toBe("bot-123");
    const returnTo = new URL(authUrl.searchParams.get("return_to") ?? "");
    const callbackPath = `/${[
      "api",
      "integrations",
      "telegram",
      "auth-callback",
    ].join("/")}`;
    expect(returnTo.pathname).toBe(callbackPath);
    expect(returnTo.searchParams.get("targetOrigin")).toBe(location.origin);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "telegram-auth",
          data: {
            id: "99003",
            first_name: "Test",
            username: "telegram_test",
            auth_date: "1777200000",
            hash: "telegram-hash",
          },
        },
      }),
    );

    await waitFor(() => {
      expect(requestBody).toMatchObject({
        telegramBotId: "bot-123",
        telegramAuth: {
          id: 99_003,
          first_name: "Test",
          username: "telegram_test",
          auth_date: 1_777_200_000,
          hash: "telegram-hash",
        },
      });
    });
    await expect(
      screen.findByText("Connected to Telegram!"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("@vm0_test_bot")).toBeInTheDocument();
    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith(
        "tg://resolve?domain=vm0_test_bot",
      );
    });
  });

  it("shows BotFather domain setup guidance when web login domain is missing", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });
    const writeTextSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    server.use(
      mockApi(
        zeroIntegrationsTelegramContract.getLinkStatus,
        ({ query, respond }) => {
          expect(query.botId).toBe("bot-123");
          expect(query.origin).toBe(window.location.origin);
          return respond(200, {
            linked: false,
            installation: {
              id: "bot-123",
              botUsername: "vm0_test_bot",
              domainConfigured: false,
            },
          });
        },
      ),
    );

    detachedSetupPage({
      context,
      path: "/telegram/connect?bot=bot-123",
      session: { token: "clerk-token" },
    });

    await expect(
      screen.findByText("Set Telegram login domain"),
    ).resolves.toBeInTheDocument();
    expect(screen.getByText("@vm0_test_bot")).toBeInTheDocument();
    expect(screen.getByText("/setdomain")).toBeInTheDocument();
    expect(screen.getByText("@BotFather")).toBeInTheDocument();
    expect(screen.getByText(window.location.hostname)).toBeInTheDocument();
    expect(screen.getByText("Checking domain status...")).toBeInTheDocument();
    expect(
      screen.queryByText("Continue with Telegram"),
    ).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();

    click(buttonWithAriaLabel("Copy to clipboard"));
    await waitFor(() => {
      expect(writeTextSpy).toHaveBeenCalledWith(window.location.hostname);
    });
    expect(buttonWithAriaLabel("Copied")).toBeInTheDocument();
    expect(screen.getAllByText("Copied!").length).toBeGreaterThan(0);
  });

  it("polls BotFather domain status and switches to the login flow when ready", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      let statusCalls = 0;
      server.use(
        mockApi(
          zeroIntegrationsTelegramContract.getLinkStatus,
          ({ query, respond }) => {
            statusCalls += 1;
            expect(query.botId).toBe("bot-123");
            expect(query.origin).toBe(window.location.origin);
            return respond(200, {
              linked: false,
              installation: {
                id: "bot-123",
                botUsername: "vm0_test_bot",
                domainConfigured: statusCalls > 1,
              },
            });
          },
        ),
      );

      detachedSetupPage({
        context,
        path: "/telegram/connect?bot=bot-123",
        session: { token: "clerk-token" },
      });

      await expect(
        screen.findByText("Set Telegram login domain"),
      ).resolves.toBeInTheDocument();
      expect(screen.getByText("Checking domain status...")).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(3000);

      await waitFor(() => {
        expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
      });
      expect(screen.getByText("Continue with Telegram")).toBeInTheDocument();
      expect(
        screen.queryByText("Set Telegram login domain"),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps BotFather guidance visible while a polling refresh is pending", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    try {
      let statusCalls = 0;
      server.use(
        mockApi(
          zeroIntegrationsTelegramContract.getLinkStatus,
          ({ query, never, respond }) => {
            statusCalls += 1;
            expect(query.botId).toBe("bot-123");
            expect(query.origin).toBe(window.location.origin);
            if (statusCalls > 1) {
              return never();
            }
            return respond(200, {
              linked: false,
              installation: {
                id: "bot-123",
                botUsername: "vm0_test_bot",
                domainConfigured: false,
              },
            });
          },
        ),
      );

      detachedSetupPage({
        context,
        path: "/telegram/connect?bot=bot-123",
        session: { token: "clerk-token" },
      });

      await expect(
        screen.findByText("Set Telegram login domain"),
      ).resolves.toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => {
        expect(statusCalls).toBeGreaterThan(1);
      });

      expect(screen.getByText("Set Telegram login domain")).toBeInTheDocument();
      expect(screen.getByText("Checking domain status...")).toBeInTheDocument();
      expect(
        screen.queryByText("Checking connection..."),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          "Please wait while we check your Telegram connection.",
        ),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces invalid or expired signature errors from the backend", async () => {
    server.use(
      mockApi(zeroIntegrationsTelegramContract.link, ({ respond }) => {
        return respond(400, {
          error: {
            message:
              "Invalid or expired connect link. Please use /connect again in Telegram.",
            code: "BAD_REQUEST",
          },
        });
      }),
    );

    detachedSetupPage({
      context,
      path: VALID_PATH,
      session: { token: "clerk-token" },
    });

    await waitFor(() => {
      expect(screen.getByText("Connect to Telegram")).toBeInTheDocument();
    });
    click(buttonWithText("Connect"));

    await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
      "Invalid or expired connect link",
    );
  });
});
