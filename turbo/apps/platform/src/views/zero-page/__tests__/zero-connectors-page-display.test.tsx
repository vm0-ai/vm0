/**
 * Display and conditional tests for the /connectors page (ZeroConnectorsPage component).
 *
 * Tests display rendering and conditional UI states via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { mockConnectors } from "./zero-connectors-page-test-helpers.ts";
import {
  zeroConnectorOauthStartContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

function mockConnectorOauthStart() {
  server.use(
    mockApi(zeroConnectorOauthStartContract.start, ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    }),
  );
}

function createMockAuthWindow() {
  return { closed: false, close: vi.fn(), location: { href: "" } };
}

describe("connectors page - count display", () => {
  it("ai categories render before non-ai categories (CONN-D-001)", async () => {
    mockConnectors([
      { type: "github" },
      { type: "openai", authMethod: "api-token" },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByTestId("connector-category-ai")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("connector-category-ai-general-models"),
    ).toBeInTheDocument();

    const aiGroup = screen.getByTestId("connector-category-ai");
    const engineeringGroup = screen.getByTestId(
      "connector-category-engineering-team-execution",
    );
    expect(
      aiGroup.compareDocumentPosition(engineeringGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("only matching categories are shown for search-filtered results (CONN-D-002)", async () => {
    mockConnectors([{ type: "github" }]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByTestId("connector-category-ai")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("connector-category-ai-general-models"),
    ).toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText("Find connectors"),
      "github",
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-category-engineering-team-execution"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("connector-category-ai"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-category-communication-collaboration"),
    ).not.toBeInTheDocument();
  });
});

describe("connectors page - grouped display", () => {
  it("renders a category menu that scrolls to grouped sections", async () => {
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    mockConnectors([
      { type: "github" },
      { type: "openai", authMethod: "api-token" },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await screen.findByRole("navigation", {
      name: "Connector categories",
    });

    await userEvent.click(
      screen.getByTestId("connector-category-menu-engineering-team-execution"),
    );

    // Assert the correct section was targeted (user-observable: the scrolled
    // element is the engineering section). Do not assert on the options
    // object — that couples the test to implementation detail.
    const engineeringSection = screen.getByTestId(
      "connector-category-engineering-team-execution",
    );
    const scrolledInto = scrollIntoView.mock.instances.some((instance) => {
      return instance === engineeringSection;
    });
    expect(scrolledInto).toBeTruthy();
  });

  it("connected connectors are shown before available ones within a category", async () => {
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-category-engineering-team-execution"),
      ).toBeInTheDocument();
    });

    const engineeringSection = screen.getByTestId(
      "connector-category-engineering-team-execution",
    );
    const labels = within(engineeringSection)
      .getAllByTestId("connector-card-label")
      .map((element) => {
        return element.textContent;
      });
    expect(labels[0]).toBe("GitHub");
    expect(labels).toContain("Asana");
  });
});

describe("connectors page - connector status indicators", () => {
  it("connector shows connecting state while polling (CONN-D-003)", async () => {
    // Start with a connected connector that needs reconnect so the
    // "Reconnect" button triggers the OAuth polling flow via GlobalConnectorCard.
    mockConnectors([
      {
        type: "github",
        connectionStatus: "reconnect-required",
        oauthScopes: ["repo", "project", "workflow"],
      },
    ]);

    // Return a fake popup that stays open so the connector enters polling state.
    mockConnectorOauthStart();
    vi.spyOn(window, "open").mockReturnValue(
      createMockAuthWindow() as unknown as Window,
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Reconnect")).toBeInTheDocument();
    });

    // After page load, block the connectors API so the polling loop stays
    // in flight and "Connecting…" remains visible. The never-resolving promise
    // is cancelled by the abort signal via fetchOptions.signal in setLoop.
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ never }) => {
        return never();
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
    mockConnectors([
      { type: "github", connectionStatus: "reconnect-required" },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Connection expired")).toBeInTheDocument();
    });
    expect(screen.getByText("Reconnect")).toBeInTheDocument();
  });

  it("connector shows scope mismatch state (CONN-D-005)", async () => {
    // GitHub requires ["repo", "project", "workflow"] scopes; empty array triggers mismatch
    mockConnectors([{ type: "github", oauthScopes: [] }]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByText("Permissions update available"),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Review")).toBeInTheDocument();
  });

  it("connector shows future non-refreshable expiry in days", async () => {
    mockConnectors([
      {
        type: "gitlab",
        authMethod: "api-token",
        tokenExpiresAt: new Date(
          Date.now() + 36 * 60 * 60 * 1000,
        ).toISOString(),
      },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Expires in 2 days")).toBeInTheDocument();
    });
  });

  it("does not show future refreshable expiry as user-facing status", async () => {
    mockConnectors([
      {
        type: "lark",
        authMethod: "api-token",
        tokenExpiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
    expect(screen.queryByText("Expires in 3 hours")).not.toBeInTheDocument();
  });

  it("device auth connector opens connect dialog instead of OAuth popup", async () => {
    const open = vi.spyOn(window, "open");
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.TestOauthConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
    });
    await userEvent.type(
      screen.getByPlaceholderText("Find connectors"),
      "device",
    );
    await userEvent.click(
      await screen.findByLabelText(/Connect .*Test OAuth Device \(internal\)/),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: /Test OAuth Device \(internal\)/,
        }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("OAuth Device Authorization")).toBeInTheDocument();
    expect(
      screen.getAllByText(/Connect .*Test OAuth Device \(internal\)/).length,
    ).toBeGreaterThan(0);
    expect(open).not.toHaveBeenCalled();
  });

  it("connected connector shows username (CONN-D-006)", async () => {
    // Pass the required GitHub OAuth scopes to avoid triggering scope mismatch state
    mockConnectors([
      {
        type: "github",
        externalUsername: "octocat",
        oauthScopes: ["repo", "project", "workflow"],
      },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("@octocat")).toBeInTheDocument();
    });
  });

  it("oauth-auth connector does not render the VM0 Managed badge", async () => {
    mockConnectors([
      {
        type: "github",
        authMethod: "oauth",
        oauthScopes: ["repo", "project", "workflow"],
      },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    // Wait for the connector card to render — "Connected" pills onto the
    // card once mockConnectors resolves.
    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
    expect(screen.queryByText("VM0 Managed")).not.toBeInTheDocument();
  });
});

describe("connectors page - loading state", () => {
  it("loading skeleton shown while connectors load (CONN-D-007)", async () => {
    server.use(
      mockApi(zeroConnectorsMainContract.list, ({ never }) => {
        return never();
      }),
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      const skeletons = screen.getAllByTestId("connector-skeleton");
      expect(skeletons.length).toBeGreaterThan(0);
    });
  });
});

describe("connectors page - help text", () => {
  it("help text is shown per connector type (CONN-D-008)", async () => {
    detachedSetupPage({ context, path: "/connectors" });

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
