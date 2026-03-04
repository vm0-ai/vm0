import { beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$, searchParams$ } from "../../../signals/route.ts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

describe("telegram connect page", () => {
  beforeEach(() => {
    // Reset window.location if a previous test changed it to a non-http protocol
    // (e.g., tg:// from the success page signal during navigate$)
    if (!window.location.href.startsWith("http")) {
      window.location.href = "http://localhost/";
    }
  });

  it("redirects to provider-setup when no provider configured", async () => {
    server.use(
      http.get("/api/model-providers", () => {
        return HttpResponse.json({ modelProviders: [] });
      }),
    );

    // The redirect during setup causes an AbortError which is expected
    await setupPage({
      context,
      path: "/telegram/connect",
    }).catch(() => {});

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/provider-setup");
    });
    const params = context.store.get(searchParams$);
    const returnUrl = params.get("return");
    expect(returnUrl).toContain("/telegram/connect");
  });

  it("shows registration form when provider exists and user is not linked", async () => {
    server.use(
      http.get("*/api/integrations/telegram/link", () => {
        return HttpResponse.json({ linked: false });
      }),
    );

    await setupPage({
      context,
      path: "/telegram/connect",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Install a Telegram Bot")).toBeInTheDocument();
    });

    expect(
      screen.getByPlaceholderText("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Install Bot" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows already-installed state when user is linked", async () => {
    server.use(
      http.get("*/api/integrations/telegram/link", () => {
        return HttpResponse.json({ linked: true });
      }),
    );

    await setupPage({
      context,
      path: "/telegram/connect",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Already Installed")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Your account is already linked to a Telegram bot."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Go to Settings" }),
    ).toBeInTheDocument();
  });

  it("calls register API and navigates to success page on Install Bot", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    server.use(
      http.get("*/api/integrations/telegram/link", () => {
        return HttpResponse.json({ linked: false });
      }),
      http.post("*/api/telegram/register", async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "installation_1",
          botUsername: "my_test_bot",
        });
      }),
    );

    await setupPage({
      context,
      path: "/telegram/connect",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Install Bot" }),
      ).toBeInTheDocument();
    });

    // Type a bot token
    const tokenInput = screen.getByPlaceholderText(
      "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    );
    await user.type(tokenInput, "123456:ABC-token");

    await user.click(screen.getByRole("button", { name: "Install Bot" }));

    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.botToken).toBe("123456:ABC-token");

    await vi.waitFor(() => {
      expect(context.store.get(pathname$)).toBe("/telegram/connect/success");
    });
    const params = context.store.get(searchParams$);
    expect(params.get("bot")).toBe("my_test_bot");
  });

  it("shows error message when registration fails", async () => {
    server.use(
      http.get("*/api/integrations/telegram/link", () => {
        return HttpResponse.json({ linked: false });
      }),
      http.post("*/api/telegram/register", () => {
        return HttpResponse.json(
          { error: { message: "Invalid bot token" } },
          { status: 400 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/telegram/connect",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Install Bot" }),
      ).toBeInTheDocument();
    });

    const tokenInput = screen.getByPlaceholderText(
      "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    );
    await user.type(tokenInput, "bad-token");

    await user.click(screen.getByRole("button", { name: "Install Bot" }));

    await vi.waitFor(() => {
      expect(screen.getByText("Invalid bot token")).toBeInTheDocument();
    });
  });
});
