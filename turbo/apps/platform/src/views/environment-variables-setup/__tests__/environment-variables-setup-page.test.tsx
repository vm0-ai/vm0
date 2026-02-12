import { describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { setMockConnectors } from "../../../mocks/handlers/api-connectors.ts";
import type { ConnectorResponse } from "@vm0/core";

const context = testContext();
const user = userEvent.setup();

function makeConnector(type: "github" | "notion"): ConnectorResponse {
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
  };
}

describe("environment variables setup page", () => {
  it("shows success state when no items are missing", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({
          secrets: [
            {
              id: "s1",
              name: "MY_SECRET",
              description: null,
              type: "user",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=MY_SECRET",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByText("Your secrets are configured."),
      ).toBeInTheDocument();
    });
  });

  it("shows connector card for connector-provided secrets", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Should show Connect button since github is not connected
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("shows connected state when connector is already linked", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Connected state shows Disconnect button instead of Connect
    expect(
      screen.getByRole("button", { name: "Disconnect" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Connect" }),
    ).not.toBeInTheDocument();
  });

  it("shows Disconnect button next to connected connector and removes it on click", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Connected state shows Disconnect button
    const disconnectButton = screen.getByRole("button", {
      name: "Disconnect",
    });
    expect(disconnectButton).toBeInTheDocument();

    // Click disconnect
    await user.click(disconnectButton);

    // After disconnect, should show Connect button instead
    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Disconnect" }),
    ).not.toBeInTheDocument();
  });

  it("renders manual input fields before connector cards", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    // Manual field label should appear before the connector card label
    const manualLabel = screen.getByText("MY_CUSTOM_KEY");
    const connectorLabel = screen.getByText("GitHub");
    const result = manualLabel.compareDocumentPosition(connectorLabel);
    // Node.DOCUMENT_POSITION_FOLLOWING (4) means connectorLabel comes after manualLabel
    expect(result & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows manual input fields for non-connector secrets", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("Enter value")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeInTheDocument();
  });

  it("shows both connector cards and manual fields when mixed", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("disables submit button when connectors are not satisfied", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
    });

    const submitButton = screen.getByRole("button", { name: "Verify" });
    expect(submitButton).toBeDisabled();
  });

  it("enables submit button when all connectors are satisfied", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
    });

    const submitButton = screen.getByRole("button", { name: "Verify" });

    await vi.waitFor(() => {
      expect(submitButton).toBeEnabled();
    });
  });

  it("does not show submit button when only connector items exist", async () => {
    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("button", { name: "Verify" }),
    ).not.toBeInTheDocument();
  });

  it("shows auto-success when all connectors connected and no manual items", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN",
    });

    await vi.waitFor(() => {
      expect(
        screen.getByText("Your secrets are configured."),
      ).toBeInTheDocument();
    });
  });

  it("shows validation errors when submitting empty manual fields", async () => {
    setMockConnectors([makeConnector("github")]);

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
    });

    const submitButton = screen.getByRole("button", { name: "Verify" });
    await vi.waitFor(() => {
      expect(submitButton).toBeEnabled();
    });

    await user.click(submitButton);

    await vi.waitFor(() => {
      expect(screen.getByText("MY_CUSTOM_KEY is required")).toBeInTheDocument();
    });
  });

  it("submits manual fields and shows success", async () => {
    setMockConnectors([makeConnector("github")]);

    let capturedBody: { name: string; value: string } | null = null;

    server.use(
      http.get("/api/secrets", () => {
        return HttpResponse.json({ secrets: [] });
      }),
      http.get("/api/variables", () => {
        return HttpResponse.json({ variables: [] });
      }),
      http.put("/api/secrets", async ({ request }) => {
        capturedBody = (await request.json()) as {
          name: string;
          value: string;
        };
        return HttpResponse.json(
          {
            id: crypto.randomUUID(),
            name: capturedBody.name,
            description: null,
            type: "user",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({
      context,
      path: "/environment-variables-setup?secrets=GH_TOKEN,MY_CUSTOM_KEY",
    });

    await vi.waitFor(() => {
      expect(screen.getByText("MY_CUSTOM_KEY")).toBeInTheDocument();
    });

    // Type in the manual secret value
    const input = screen.getByPlaceholderText("Enter value");
    await user.click(input);
    await user.keyboard("my-secret-value");

    // Submit
    const submitButton = screen.getByRole("button", { name: "Verify" });
    await vi.waitFor(() => {
      expect(submitButton).toBeEnabled();
    });
    await user.click(submitButton);

    // Verify the correct data was sent
    await vi.waitFor(() => {
      expect(capturedBody).toBeTruthy();
    });
    expect(capturedBody!.name).toBe("MY_CUSTOM_KEY");
    expect(capturedBody!.value).toBe("my-secret-value");

    // Should show success state
    await vi.waitFor(() => {
      expect(
        screen.getByText("Your secrets are configured."),
      ).toBeInTheDocument();
    });
  });
});
