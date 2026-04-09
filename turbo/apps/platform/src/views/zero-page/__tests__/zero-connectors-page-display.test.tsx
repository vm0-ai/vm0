/**
 * Display and conditional tests for the /connectors page (ZeroConnectorsPage component).
 *
 * Tests display rendering and conditional UI states via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { mockConnectors } from "./zero-connectors-page-test-helpers.ts";

const context = testContext();

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

    // Return a fake popup that stays open so the connector enters polling state.
    vi.spyOn(window, "open").mockReturnValue({ closed: false } as Window);

    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Reconnect")).toBeInTheDocument();
    });

    // After page load, block the connectors API so the polling loop stays
    // in flight and "Connecting…" remains visible. The never-resolving promise
    // is cancelled by the abort signal via fetchOptions.signal in setLoop.
    server.use(
      http.get("*/api/zero/connectors", () => {
        return new Promise<never>(() => {});
      }),
    );

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

    const skeletons = screen.getAllByTestId("connector-skeleton");
    expect(skeletons.length).toBeGreaterThan(0);
  });
});

describe("connectors page - help text", () => {
  it("help text is shown per connector type (CONN-D-008)", async () => {
    await setupPage({ context, path: "/connectors" });

    await waitFor(() => {
      const helpTexts = screen.getAllByTestId("connector-help-text");
      // At least one connector card must render a non-empty help text
      const nonEmpty = helpTexts.filter((el) => {
        return (el.textContent ?? "").trim().length > 0;
      });
      expect(nonEmpty.length).toBeGreaterThan(0);
    });
  });
});
