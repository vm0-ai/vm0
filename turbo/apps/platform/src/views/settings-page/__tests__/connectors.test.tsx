import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import {
  mockedNango,
  triggerNangoEvent,
} from "../../../__tests__/mock-nango.ts";
import type { ConnectorResponse } from "@vm0/core";

const context = testContext();
const user = userEvent.setup();

function makeConnector(
  type: "github" | "notion",
  overrides?: Partial<ConnectorResponse>,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "oauth",
    platform: "self-hosted",
    externalId: `ext-${type}-1`,
    externalUsername: type === "github" ? "octocat" : "notion-user",
    externalEmail: null,
    oauthScopes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("connectors tab", () => {
  it("shows all connector types with not-connected status", async () => {
    await setupPage({
      context,
      path: "/settings?tab=connectors",
      featureSwitches: { connectorNango: true },
    });

    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Notion")).toBeInTheDocument();
    expect(screen.getByText("Gmail")).toBeInTheDocument();

    const connectButtons = screen.getAllByText("Connect");
    expect(connectButtons).toHaveLength(3);
  });

  it("shows connected status when a connector exists", async () => {
    setMockConnectors([makeConnector("github")]);

    await setupPage({ context, path: "/settings?tab=connectors" });

    expect(screen.getByText("Connected as octocat")).toBeInTheDocument();

    // Other connectors should still show Connect buttons
    const connectButtons = screen.getAllByText("Connect");
    expect(connectButtons.length).toBeGreaterThan(0);
    // "Not connected" status has been removed from the UI
  });

  it("can disconnect a connector via kebab menu", async () => {
    setMockConnectors([makeConnector("github")]);

    let deletedType: string | null = null;
    server.use(
      http.delete("/api/connectors/:type", ({ params }) => {
        deletedType = params.type as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({ context, path: "/settings?tab=connectors" });

    // Open kebab menu for connected connector
    const optionsButton = screen.getByRole("button", {
      name: /connector options/i,
    });
    await user.click(optionsButton);

    // Click Disconnect
    const disconnectButton = await screen.findByText("Disconnect");
    await user.click(disconnectButton);

    // Confirm in dialog
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/are you sure you want to disconnect github/i),
    ).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", {
      name: /^disconnect$/i,
    });
    await user.click(confirmButton);

    // Verify delete API was called and dialog closed
    await vi.waitFor(() => {
      expect(deletedType).toBe("github");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("switches to connectors tab from providers tab", async () => {
    await setupPage({ context, path: "/settings" });

    // Default tab is providers
    expect(screen.getByText("Model Providers")).toBeInTheDocument();

    // Click Connectors tab
    const connectorsTab = screen.getByRole("tab", { name: /connectors/i });
    await user.click(connectorsTab);

    // Should show connector list
    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.getByText("Notion")).toBeInTheDocument();
  });

  it("shows gmail connector with nango platform", async () => {
    setMockConnectors([
      {
        id: crypto.randomUUID(),
        type: "gmail",
        authMethod: "oauth",
        platform: "nango",
        nangoConnectionId: "nango-uuid-123",
        externalId: "gmail-user-1",
        externalUsername: "Test User",
        externalEmail: "user@gmail.com",
        oauthScopes: ["https://mail.google.com/"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    await setupPage({
      context,
      path: "/settings?tab=connectors",
      featureSwitches: { connectorNango: true },
    });

    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Connected as Test User")).toBeInTheDocument();
  });

  it("initiates nango connect flow when clicking connect", async () => {
    // Mock create-session endpoint
    server.use(
      http.post("/api/connectors/gmail/create-session", () => {
        return HttpResponse.json({
          sessionToken: "ncs_test_token",
        });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=connectors",
      featureSwitches: { connectorNango: true },
    });

    // Wait for Gmail connector to be visible
    await vi.waitFor(() => {
      expect(screen.getByText("Gmail")).toBeInTheDocument();
    });

    // Find and click Connect button for Gmail
    // The button is outside the text area, so we search globally first
    const allConnectButtons = screen.getAllByRole("button", {
      name: /connect/i,
    });

    // Gmail should be the third connector (after GitHub and Notion)
    // Find the one that's associated with Gmail section
    await user.click(allConnectButtons[2]);

    // Verify Nango UI was opened
    await vi.waitFor(() => {
      expect(mockedNango.openConnectUI).toHaveBeenCalledWith({
        sessionToken: "ncs_test_token",
        onEvent: expect.any(Function),
      });
    });

    // Should show "Connecting..." state
    await vi.waitFor(() => {
      expect(screen.getByText("Connecting...")).toBeInTheDocument();
    });
  });

  it("shows success after nango connection completes", async () => {
    server.use(
      http.post("/api/connectors/gmail/create-session", () => {
        return HttpResponse.json({ sessionToken: "test" });
      }),
      // After connection, return the new connector
      http.get("/api/connectors", () => {
        return HttpResponse.json({
          connectors: [
            {
              id: crypto.randomUUID(),
              type: "gmail",
              authMethod: "oauth",
              platform: "nango",
              externalId: "gmail-123",
              externalUsername: "New User",
              externalEmail: "new@gmail.com",
              oauthScopes: ["https://mail.google.com/"],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=connectors",
      featureSwitches: { connectorNango: true },
    });

    // Wait for Gmail connector to be visible
    await vi.waitFor(() => {
      expect(screen.getByText("Gmail")).toBeInTheDocument();
    });

    // Find and click Connect button for Gmail (third connector)
    const allConnectButtons = screen.getAllByRole("button", {
      name: /connect/i,
    });
    await user.click(allConnectButtons[2]);

    // Simulate connection success
    await triggerNangoEvent({ type: "connect" });

    // Should show connected state
    await vi.waitFor(() => {
      expect(screen.getByText("Connected as New User")).toBeInTheDocument();
    });
  });

  it("can disconnect nango connector", async () => {
    setMockConnectors([
      {
        id: crypto.randomUUID(),
        type: "gmail",
        authMethod: "oauth",
        platform: "nango",
        nangoConnectionId: "nango-uuid-456",
        externalId: "gmail-456",
        externalUsername: "Test User",
        externalEmail: "test@gmail.com",
        oauthScopes: ["https://mail.google.com/"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    let deletedType: string | null = null;
    server.use(
      http.delete("/api/connectors/:type", ({ params }) => {
        deletedType = params.type as string;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=connectors",
      featureSwitches: { connectorNango: true },
    });

    // Open kebab menu
    const optionsButton = screen.getByRole("button", {
      name: /connector options/i,
    });
    await user.click(optionsButton);

    // Click Disconnect
    const disconnectButton = await screen.findByText("Disconnect");
    await user.click(disconnectButton);

    // Confirm
    const dialog = await screen.findByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", {
      name: /^disconnect$/i,
    });
    await user.click(confirmButton);

    // Verify gmail was deleted (which deletes from both DB and Nango)
    await vi.waitFor(() => {
      expect(deletedType).toBe("gmail");
    });
  });
});
