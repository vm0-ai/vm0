/**
 * Display and conditional tests for the /connectors page (ZeroConnectorsPage component).
 *
 * Tests display rendering and conditional UI states via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

function mockConnectors(
  connectors: {
    type: ConnectorType;
    externalUsername?: string;
    needsReconnect?: boolean;
    oauthScopes?: string[];
  }[],
) {
  server.use(
    http.get("*/api/zero/connectors", () => {
      return HttpResponse.json({
        connectors: connectors.map((c) => {
          return {
            id: crypto.randomUUID(),
            type: c.type,
            authMethod: "oauth",
            externalId: null,
            externalUsername: c.externalUsername ?? null,
            externalEmail: null,
            oauthScopes: c.oauthScopes ?? null,
            needsReconnect: c.needsReconnect ?? false,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          };
        }),
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

describe("connectors page - count display", () => {
  it("connected connectors count is displayed (CONN-D-001)", async () => {
    mockConnectors([{ type: "github" }, { type: "linear" }]);

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Connected (2)")).toBeInTheDocument();
    });
  });

  it("available connectors count is displayed (CONN-D-002)", async () => {
    mockConnectors([{ type: "github" }]);

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      const availableHeading = screen.getByText(/^Available \(\d+\)$/);
      expect(availableHeading).toBeInTheDocument();
      const count = Number.parseInt(
        availableHeading.textContent?.match(/\d+/)?.[0] ?? "0",
      );
      expect(count).toBeGreaterThan(0);
    });
  });
});

describe("connectors page - connector status indicators", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connector shows connecting state while polling (CONN-D-003)", async () => {
    // Start with a connected connector that needs reconnect so the
    // "Reconnect" button triggers the OAuth polling flow via GlobalConnectorCard.
    mockConnectors([
      {
        type: "github",
        needsReconnect: true,
        oauthScopes: ["repo", "project"],
      },
    ]);

    const fakeWindow = { closed: false };
    vi.spyOn(window, "open").mockReturnValue(
      fakeWindow as unknown as Window & typeof globalThis,
    );

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Reconnect")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText("Reconnect"));

    await waitFor(() => {
      // "Connecting…" appears in GlobalConnectorCard when isPolling is true.
      // The span contains an SVG icon + "Connecting…" text.
      // Use getAllByText with a function matcher since the text is alongside a child SVG.
      const elements = screen.getAllByText((_, element) => {
        return element?.textContent?.includes("Connecting…") ?? false;
      });
      expect(elements.length).toBeGreaterThan(0);
    });
  });

  it("connector shows reconnect needed state (CONN-D-004)", async () => {
    mockConnectors([{ type: "github", needsReconnect: true }]);

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Connection expired")).toBeInTheDocument();
    });
    expect(screen.getByText("Reconnect")).toBeInTheDocument();
  });

  it("connector shows scope mismatch state (CONN-D-005)", async () => {
    // GitHub requires ["repo", "project"] scopes; empty array triggers mismatch
    mockConnectors([
      { type: "github", oauthScopes: [], needsReconnect: false },
    ]);

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByText("Permissions update available"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("connected connector shows username (CONN-D-006)", async () => {
    // Pass the required GitHub OAuth scopes to avoid triggering scope mismatch state
    mockConnectors([
      {
        type: "github",
        externalUsername: "octocat",
        oauthScopes: ["repo", "project"],
      },
    ]);

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("@octocat")).toBeInTheDocument();
    });
  });
});

describe("connectors page - loading state", () => {
  it("loading skeleton shown while connectors load (CONN-D-007)", async () => {
    server.use(
      http.get("*/api/zero/connectors", () => {
        return new Promise<never>(() => {
          // Never resolves — keeps component in loading state
        });
      }),
    );

    await setupPage({ context, path: "/connectors" });

    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});

describe("connectors page - help text", () => {
  it("help text is shown per connector type (CONN-D-008)", async () => {
    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByText(CONNECTOR_TYPES.github.helpText),
      ).toBeInTheDocument();
    });
  });
});

describe("connectors page - empty state", () => {
  it("empty state shown when no connectors match search (CONN-C-009)", async () => {
    const user = userEvent.setup();
    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search connectors");
    await user.clear(searchInput);
    await user.type(searchInput, "nonexistent-connector-xyz");

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
  });
});
