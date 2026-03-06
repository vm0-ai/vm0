import { describe, expect, it } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const context = testContext();
const user = userEvent.setup();

describe("telegram settings page", () => {
  it("renders bot info and default agent for admin user", async () => {
    await setupPage({ context, path: "/settings/telegram" });

    expect(context.store.get(pathname$)).toBe("/settings/telegram");

    // Page title (h1 heading)
    expect(
      screen.getByRole("heading", { name: "VM0 in Telegram" }),
    ).toBeInTheDocument();

    // Bot info section
    expect(screen.getByText("@test_bot")).toBeInTheDocument();
    expect(screen.getByText("bot_123")).toBeInTheDocument();

    // Default agent section (admin view)
    expect(screen.getByText("Default agent")).toBeInTheDocument();
    expect(
      screen.getByText("Default agent you would like to use in Telegram"),
    ).toBeInTheDocument();

    // Agent select should show the default agent name
    expect(screen.getByText("default-agent")).toBeInTheDocument();

    // Available commands section
    expect(screen.getByText("Your available commands")).toBeInTheDocument();
    expect(screen.getByText("/new_session")).toBeInTheDocument();
    expect(screen.getByText("/connect")).toBeInTheDocument();
    expect(screen.getByText("/disconnect")).toBeInTheDocument();
    expect(screen.getByText("/settings")).toBeInTheDocument();
    expect(screen.getByText("/help")).toBeInTheDocument();

    // Disconnect section (heading + button)
    expect(
      screen.getByRole("heading", { name: "Uninstall Telegram" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /uninstall/i }),
    ).toBeInTheDocument();
  });

  it("renders read-only view for non-admin user", async () => {
    server.use(
      http.get("/api/integrations/telegram", () => {
        return HttpResponse.json({
          bot: { id: "bot_123", username: "test_bot" },
          agent: {
            id: "compose_1",
            name: "default-agent",
            scopeSlug: "test-scope",
          },
          isAdmin: false,
          environment: {
            requiredSecrets: ["ANTHROPIC_API_KEY"],
            requiredVars: [],
            missingSecrets: [],
            missingVars: [],
          },
        });
      }),
    );

    await setupPage({ context, path: "/settings/telegram" });

    // Non-admin text
    expect(
      screen.getByText("Default agent you use in Telegram"),
    ).toBeInTheDocument();
    expect(screen.getByText(/managed by the bot admin/)).toBeInTheDocument();

    // Agent name should still be displayed but not in a select
    expect(screen.getByText("default-agent")).toBeInTheDocument();
  });

  it("shows missing environment banner when secrets are missing", async () => {
    server.use(
      http.get("/api/integrations/telegram", () => {
        return HttpResponse.json({
          bot: { id: "bot_123", username: "test_bot" },
          agent: {
            id: "compose_1",
            name: "default-agent",
            scopeSlug: "test-scope",
          },
          isAdmin: true,
          environment: {
            requiredSecrets: ["ANTHROPIC_API_KEY"],
            requiredVars: [],
            missingSecrets: ["ANTHROPIC_API_KEY"],
            missingVars: [],
          },
        });
      }),
    );

    await setupPage({ context, path: "/settings/telegram" });

    // Should show the missing env warning banner
    expect(screen.getByText(/missing some/)).toBeInTheDocument();

    // Should show a link to secrets or variables settings
    expect(
      screen.getByRole("link", { name: /secrets or variables/i }),
    ).toBeInTheDocument();
  });

  it("opens uninstall confirmation dialog", async () => {
    await setupPage({ context, path: "/settings/telegram" });

    // Click the disconnect button
    const disconnectButton = screen.getByRole("button", {
      name: /uninstall/i,
    });
    await user.click(disconnectButton);

    // Confirm dialog should appear
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Uninstall Telegram")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/remove the Telegram bot installation/),
    ).toBeInTheDocument();

    // Should have Cancel and Disconnect buttons
    expect(
      within(dialog).getByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /uninstall/i }),
    ).toBeInTheDocument();
  });

  it("closes uninstall dialog on cancel", async () => {
    await setupPage({ context, path: "/settings/telegram" });

    // Open the dialog
    const disconnectButton = screen.getByRole("button", {
      name: /uninstall/i,
    });
    await user.click(disconnectButton);

    const dialog = await screen.findByRole("dialog");
    const cancelButton = within(dialog).getByRole("button", {
      name: /cancel/i,
    });
    await user.click(cancelButton);

    // Dialog should close
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("settings integrations tab with telegram", () => {
  it("shows Telegram integration card with Settings button when feature enabled", async () => {
    await setupPage({
      context,
      path: "/settings?tab=integrations",
      featureSwitches: { telegramIntegration: true },
    });

    expect(context.store.get(pathname$)).toBe("/settings");

    // The Telegram card should be visible
    expect(screen.getByText("VM0 in Telegram")).toBeInTheDocument();
    expect(
      screen.getByText("Use your VM0 agent in Telegram"),
    ).toBeInTheDocument();

    // Should show a Settings link inside the Telegram card
    const telegramCard = screen
      .getByText("Use your VM0 agent in Telegram")
      .closest("div.rounded-xl") as HTMLElement;
    expect(
      within(telegramCard).getByRole("link", { name: /settings/i }),
    ).toBeInTheDocument();
  });

  it("shows Install link when bot is not linked", async () => {
    server.use(
      http.get("/api/integrations/telegram", () => {
        return HttpResponse.json(
          {
            error: { code: "NOT_FOUND", message: "Not linked" },
          },
          { status: 404 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=integrations",
      featureSwitches: { telegramIntegration: true },
    });

    // Should show the Telegram card
    expect(screen.getByText("VM0 in Telegram")).toBeInTheDocument();

    // Should show Install link (not Settings)
    const telegramCard = screen
      .getByText("Use your VM0 agent in Telegram")
      .closest("div.rounded-xl") as HTMLElement;
    expect(
      within(telegramCard).getByRole("link", { name: /install/i }),
    ).toBeInTheDocument();
  });
});
