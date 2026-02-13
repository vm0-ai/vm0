import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { describe, expect, it, vi } from "vitest";
import { screen, within, fireEvent } from "@testing-library/react";
import { pathname$ } from "../../../signals/route.ts";
import { server } from "../../../mocks/server.ts";
import { http, HttpResponse } from "msw";
import { FeatureSwitchKey } from "@vm0/core";

const context = testContext();

/** Compose variable reference strings (built at module scope to satisfy lint rules). */
const SECRET_REF_MY_API_KEY = `\${{ secrets.MY_API_KEY }}`;
const SECRET_REF_MY_OTHER_KEY = `\${{ secrets.MY_OTHER_KEY }}`;

function mockAgentDetailAPI(options?: {
  name?: string;
  environment?: Record<string, string>;
}) {
  const name = options?.name ?? "my-agent";
  const environment = options?.environment;

  server.use(
    http.get("/api/agent/composes", ({ request }) => {
      const url = new URL(request.url);
      const queryName = url.searchParams.get("name");

      if (queryName !== name) {
        return new HttpResponse(null, { status: 404 });
      }

      return HttpResponse.json({
        id: "compose_1",
        name,
        headVersionId: "version_1",
        content: {
          version: "1",
          agents: {
            [name]: {
              description: "A test agent",
              framework: "claude-code",
              ...(environment ? { environment } : {}),
            },
          },
        },
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      });
    }),
    http.get("/api/agent/composes/:id/instructions", () => {
      return HttpResponse.json({ content: null, filename: null });
    }),
  );
}

function mockConnectorsAPI(connectors?: unknown[]) {
  server.use(
    http.get("/api/connectors", () => {
      return HttpResponse.json({
        connectors: connectors ?? [],
      });
    }),
  );
}

function mockSecretsAPI(secrets?: unknown[]) {
  server.use(
    http.get("/api/secrets", () => {
      return HttpResponse.json({
        secrets: secrets ?? [],
      });
    }),
  );
}

function mockVariablesAPI(variables?: unknown[]) {
  server.use(
    http.get("/api/variables", () => {
      return HttpResponse.json({
        variables: variables ?? [],
      });
    }),
  );
}

describe("agent connections page", () => {
  it("should redirect to /agents when feature flag is disabled", async () => {
    await setupPage({
      context,
      path: "/agents/my-agent/connections",
    });

    expect(context.store.get(pathname$)).toBe("/agents");
  });

  it("should render connections page structure", async () => {
    mockAgentDetailAPI();
    mockConnectorsAPI();
    mockSecretsAPI();
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Connections of my-agent")).toBeInTheDocument();
    });

    expect(
      screen.getByText(
        "This is the secret list used for your agents in every run",
      ),
    ).toBeInTheDocument();
  });

  it("should show connectors and secrets tabs", async () => {
    mockAgentDetailAPI();
    mockConnectorsAPI();
    mockSecretsAPI();
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Connectors" }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("tab", { name: "Secrets and variables" }),
    ).toBeInTheDocument();
  });

  it("should show connectors tab by default with connector types", async () => {
    mockAgentDetailAPI();
    mockConnectorsAPI();
    mockSecretsAPI();
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    expect(screen.getByText("Notion")).toBeInTheDocument();
  });

  it("should show connected status for connected connectors", async () => {
    mockAgentDetailAPI();
    mockConnectorsAPI([
      {
        id: "conn_1",
        type: "github",
        authMethod: "oauth",
        externalId: "12345",
        externalUsername: "testuser",
        externalEmail: "test@example.com",
        oauthScopes: ["repo"],
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    mockSecretsAPI();
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Connected as testuser")).toBeInTheDocument();
    });
  });

  it("should show Connect button for disconnected connectors", async () => {
    mockAgentDetailAPI();
    mockConnectorsAPI();
    mockSecretsAPI();
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const connectButtons = screen.getAllByText("Connect");
    expect(connectButtons.length).toBeGreaterThan(0);
  });

  it("should switch to secrets tab and show add row when no secrets required", async () => {
    mockAgentDetailAPI();
    mockConnectorsAPI();
    mockSecretsAPI();
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Secrets and variables" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Secrets and variables" }));

    await vi.waitFor(() => {
      expect(screen.getByText("New secrets and variables")).toBeInTheDocument();
    });
  });

  it("should show required secrets with configured and missing rows", async () => {
    mockAgentDetailAPI({
      environment: {
        MY_API_KEY: SECRET_REF_MY_API_KEY,
        MY_OTHER_KEY: SECRET_REF_MY_OTHER_KEY,
      },
    });
    mockConnectorsAPI();
    mockSecretsAPI([
      {
        id: "secret_1",
        name: "MY_API_KEY",
        description: null,
        type: "user",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(
        screen.getByRole("tab", { name: "Secrets and variables" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("tab", { name: "Secrets and variables" }));

    // Configured secret shows with kebab menu
    await vi.waitFor(() => {
      expect(screen.getByText("MY_API_KEY")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Secret options")).toBeInTheDocument();

    // Missing secret shows with "Missing secrets" badge and "Fill" button
    expect(screen.getByText("MY_OTHER_KEY")).toBeInTheDocument();
    expect(screen.getByText("Missing secrets")).toBeInTheDocument();
    expect(screen.getByText("Fill")).toBeInTheDocument();
  });

  it("should show three-level breadcrumb", async () => {
    mockAgentDetailAPI();
    mockConnectorsAPI();
    mockSecretsAPI();
    mockVariablesAPI();

    await setupPage({
      context,
      path: "/agents/my-agent/connections",
      featureSwitches: { [FeatureSwitchKey.AgentDetailPage]: true },
    });

    await vi.waitFor(() => {
      expect(screen.getByText("Connections of my-agent")).toBeInTheDocument();
    });

    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("Agents")).toBeInTheDocument();
    expect(within(nav).getByText("my-agent")).toBeInTheDocument();
    expect(within(nav).getByText("Connections")).toBeInTheDocument();
  });
});
