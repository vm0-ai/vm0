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

describe("slack settings page", () => {
  it("renders workspace info and default agent for admin user", async () => {
    await setupPage({ context, path: "/settings/slack" });

    expect(context.store.get(pathname$)).toBe("/settings/slack");

    // Page title (h1 heading)
    expect(
      screen.getByRole("heading", { name: "VM0 in Slack" }),
    ).toBeInTheDocument();

    // Default agent section (admin view)
    expect(screen.getByText("Default agent")).toBeInTheDocument();
    expect(
      screen.getByText("Default agent you would like to use in Slack"),
    ).toBeInTheDocument();

    // Agent select should show the default agent name
    expect(screen.getByText("default-agent")).toBeInTheDocument();

    // Available commands section
    expect(screen.getByText("Your available commands")).toBeInTheDocument();
    expect(screen.getByText("/vm0 connect")).toBeInTheDocument();
    expect(screen.getByText("/vm0 disconnect")).toBeInTheDocument();
    expect(screen.getByText("/vm0 settings")).toBeInTheDocument();

    // Disconnect section (heading + button)
    expect(
      screen.getByRole("heading", { name: "Disconnect with Slack" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it("renders read-only view for non-admin user", async () => {
    server.use(
      http.get("/api/integrations/slack", () => {
        return HttpResponse.json({
          workspace: { id: "T123", name: "Test Workspace" },
          agent: { id: "compose_1", name: "default-agent" },
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

    await setupPage({ context, path: "/settings/slack" });

    // Non-admin text
    expect(
      screen.getByText("Default agent you use in Slack"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/managed by your Slack workspace admin/),
    ).toBeInTheDocument();

    // Agent name should still be displayed but not in a select
    expect(screen.getByText("default-agent")).toBeInTheDocument();
  });

  it("shows missing environment banner when secrets are missing", async () => {
    server.use(
      http.get("/api/integrations/slack", () => {
        return HttpResponse.json({
          workspace: { id: "T123", name: "Test Workspace" },
          agent: { id: "compose_1", name: "default-agent" },
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

    await setupPage({ context, path: "/settings/slack" });

    // Should show the missing secrets warning
    expect(
      screen.getByText(/missing required secrets or variables/),
    ).toBeInTheDocument();

    // Should show Fill button
    expect(screen.getByRole("button", { name: /fill/i })).toBeInTheDocument();
  });

  it("opens disconnect confirmation dialog", async () => {
    await setupPage({ context, path: "/settings/slack" });

    // Click the disconnect button
    const disconnectButton = screen.getByRole("button", {
      name: /disconnect/i,
    });
    await user.click(disconnectButton);

    // Confirm dialog should appear
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Disconnect Slack")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/remove your Slack account connection/),
    ).toBeInTheDocument();

    // Should have Cancel and Disconnect buttons
    expect(
      within(dialog).getByRole("button", { name: /cancel/i }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it("closes disconnect dialog on cancel", async () => {
    await setupPage({ context, path: "/settings/slack" });

    // Open the dialog
    const disconnectButton = screen.getByRole("button", {
      name: /disconnect/i,
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

describe("settings integrations tab", () => {
  it("shows Slack integration card with Settings button", async () => {
    await setupPage({ context, path: "/settings?tab=integrations" });

    expect(context.store.get(pathname$)).toBe("/settings");

    // The Integrations tab should be active and show the Slack card
    expect(screen.getByText("VM0 in Slack")).toBeInTheDocument();
    expect(screen.getByText("Use your VM0 agent in Slack")).toBeInTheDocument();

    // Should show a Settings button inside the Slack card (not the nav "Settings")
    // The Slack card has an outline variant Settings button
    const slackCard = screen
      .getByText("Use your VM0 agent in Slack")
      .closest("div.rounded-lg") as HTMLElement;
    expect(
      within(slackCard).getByRole("button", { name: /settings/i }),
    ).toBeInTheDocument();
  });

  it("shows Connect link when user is not linked to Slack", async () => {
    server.use(
      http.get("/api/integrations/slack", () => {
        return HttpResponse.json(
          {
            error: { code: "NOT_FOUND", message: "Not linked" },
            installUrl: "/api/slack/oauth/install?userId=test-user",
          },
          { status: 404 },
        );
      }),
    );

    await setupPage({ context, path: "/settings?tab=integrations" });

    // Should show the Slack card
    expect(screen.getByText("VM0 in Slack")).toBeInTheDocument();

    // Should show Connect link (not Settings button within the card)
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });
});
