import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorResponse,
  type ConnectorType,
} from "@vm0/core";

const context = testContext();
const user = userEvent.setup();

function makeConnector(
  type: "github" | "notion" | "slack",
  overrides?: Partial<ConnectorResponse>,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    type,
    authMethod: "oauth",
    externalId: `ext-${type}-1`,
    externalUsername: type === "github" ? "octocat" : "notion-user",
    externalEmail: null,
    oauthScopes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("connections tab", () => {
  it("shows empty state when no connectors are connected or used", async () => {
    await setupPage({
      context,
      path: "/settings?tab=connections",
    });

    expect(screen.getByText(/no connectors in list/i)).toBeInTheDocument();
  });

  it("shows connected status when a connector exists", async () => {
    setMockConnectors([makeConnector("github")]);

    await setupPage({ context, path: "/settings?tab=connections" });

    expect(screen.getByText("Connected as octocat")).toBeInTheDocument();
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

    await setupPage({ context, path: "/settings?tab=connections" });

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
      within(dialog).getByText(/are you sure you want to uninstall github/i),
    ).toBeInTheDocument();

    const confirmButton = within(dialog).getByRole("button", {
      name: /^uninstall$/i,
    });
    await user.click(confirmButton);

    // Verify delete API was called and dialog closed
    await vi.waitFor(() => {
      expect(deletedType).toBe("github");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("switches to Connections tab from providers tab", async () => {
    setMockConnectors([makeConnector("github"), makeConnector("notion")]);

    await setupPage({ context, path: "/settings" });

    // Default tab is providers
    expect(screen.getByText("Model Providers")).toBeInTheDocument();

    // Click Connections tab
    const connectionsTab = screen.getByRole("tab", { name: /connections/i });
    await user.click(connectionsTab);

    // Should show connected connectors
    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.getByText("Notion")).toBeInTheDocument();
  });
});

describe("add connection via api token", () => {
  it("connects mercury via api token and shows connected status", async () => {
    let capturedSecretBody: { name: string; value: string } | null = null;
    let mercuryConnected = false;

    server.use(
      http.get("/api/connectors", () => {
        return HttpResponse.json({
          connectors: mercuryConnected
            ? [
                {
                  id: null,
                  type: "mercury",
                  authMethod: "api-token",
                  externalId: null,
                  externalUsername: null,
                  externalEmail: null,
                  oauthScopes: null,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ]
            : [],
          configuredTypes: Object.keys(CONNECTOR_TYPES) as ConnectorType[],
          connectorProvidedSecretNames: [],
        });
      }),
      http.put("/api/secrets", async ({ request }) => {
        capturedSecretBody = (await request.json()) as {
          name: string;
          value: string;
        };
        mercuryConnected = true;
        return HttpResponse.json({
          id: crypto.randomUUID(),
          name: capturedSecretBody.name,
          description: null,
          type: "user",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }),
    );

    await setupPage({
      context,
      path: "/settings?tab=connections",
      featureSwitches: { mercuryConnector: false },
    });

    // Click "Add connection" to open the dialog
    await user.click(screen.getByRole("button", { name: /add connection/i }));

    // In the Add Connection dialog, find the Mercury card and click Connect
    const addDialog = await screen.findByRole("dialog", {
      name: /add connection/i,
    });
    const mercuryCard = within(addDialog)
      .getByText("Mercury")
      .closest('[class*="rounded-xl"]') as HTMLElement;
    await user.click(
      within(mercuryCard).getByRole("button", { name: /connect/i }),
    );

    // The Connect modal for Mercury should open
    const connectModal = await screen.findByRole("dialog", {
      name: /^mercury$/i,
    });

    // Fill in the API Token field
    const tokenInput = within(connectModal).getByPlaceholderText(
      /secret-token:mercury_production_/i,
    );
    await user.click(tokenInput);
    await user.paste("secret-token:mercury_production_test123");

    // Submit
    await user.click(
      within(connectModal).getByRole("button", { name: /^save$/i }),
    );

    // Verify the correct secret was sent and Mercury is now shown as connected
    await vi.waitFor(() => {
      expect(capturedSecretBody).toStrictEqual({
        name: "MERCURY_TOKEN",
        value: "secret-token:mercury_production_test123",
      });
      expect(
        screen.getAllByText("Connected via API Token").length,
      ).toBeGreaterThan(0);
    });
  });
});
