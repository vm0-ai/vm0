import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { StoreProvider } from "ccstate-react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  CONNECTOR_TYPES,
  type ConnectorResponse,
  type ConnectorType,
  type ScopeDiff,
} from "@vm0/core";
import { ZeroSkillsTab } from "../zero-skills-tab.tsx";

const context = testContext();

function mockConnectors(connectors: ConnectorResponse[]) {
  server.use(
    http.get("*/api/connectors", () => {
      return HttpResponse.json({
        connectors,
        configuredTypes: Object.keys(CONNECTOR_TYPES),
        connectorProvidedSecretNames: [],
      });
    }),
  );
}

function makeConnector(
  overrides: Partial<ConnectorResponse> & { type: ConnectorType },
): ConnectorResponse {
  return {
    id: `conn-${overrides.type}`,
    authMethod: "oauth",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    needsReconnect: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const noop = () => {};

/**
 * Bootstrap app signals (auth, fetch) then render ZeroSkillsTab directly.
 * Uses setupPage with the full page render (required by lint rules for view tests),
 * then renders the component under test in a fresh render tree with the same store.
 */
async function renderSkillsTab(addedSkills: string[]) {
  // Mock chat-threads endpoint that the full page render triggers
  server.use(
    http.get("*/api/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
  );

  // Full page render bootstraps auth/fetch/signals; the ZeroSkillsTab lives
  // on the /team/:name route, but we test it as a standalone component
  // rendered with the same ccstate store.
  await setupPage({ context, path: "/" });

  // Render ZeroSkillsTab in a separate render tree that shares the store
  const { unmount } = render(
    createElement(
      StoreProvider,
      { value: context.store },
      createElement(ZeroSkillsTab, {
        addedSkills,
        addedSkillsLoading: false,
        skillsDirty: false,
        skillsSaving: false,
        onAddSkill: noop,
        onRemoveSkill: noop,
        onSaveSkills: noop,
        onDiscardSkills: noop,
      }),
    ),
  );
  context.signal.addEventListener("abort", unmount);
}

describe("zero skill card status display", () => {
  it("shows @username for connected OAuth connector with externalUsername", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        externalUsername: "testuser",
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderSkillsTab(["github"]);

    await waitFor(() => {
      expect(screen.getByText("@testuser")).toBeInTheDocument();
    });
  });

  it("shows 'API key' for connected API token connector", async () => {
    mockConnectors([
      makeConnector({
        type: "axiom",
        authMethod: "api-token",
      }),
    ]);

    await renderSkillsTab(["axiom"]);

    await waitFor(() => {
      expect(screen.getByText("API key")).toBeInTheDocument();
    });
  });

  it("shows 'Connected' for connected OAuth connector without username", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        externalUsername: null,
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderSkillsTab(["github"]);

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
  });

  it("shows 'Connection expired' and Reconnect button for needsReconnect", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        needsReconnect: true,
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderSkillsTab(["github"]);

    await waitFor(() => {
      expect(screen.getByText("Connection expired")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Reconnect" }),
      ).toBeInTheDocument();
    });
  });

  it("shows 'Permissions update available' and Review button for scope mismatch", async () => {
    // GitHub requires ["repo", "project"] — only storing ["repo"] triggers mismatch
    mockConnectors([
      makeConnector({
        type: "github",
        oauthScopes: ["repo"],
      }),
    ]);

    await renderSkillsTab(["github"]);

    await waitFor(() => {
      expect(
        screen.getByText("Permissions update available"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Review" }),
      ).toBeInTheDocument();
    });
  });

  it("shows 'Connect' button for not-connected OAuth connector", async () => {
    mockConnectors([]);

    await renderSkillsTab(["github"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect" }),
      ).toBeInTheDocument();
    });
  });

  it("shows 'Add API key' button for not-connected API-token-only connector", async () => {
    mockConnectors([]);

    await renderSkillsTab(["axiom"]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Add API key" }),
      ).toBeInTheDocument();
    });
  });
});

describe("zero skill card button clicks", () => {
  it("calls window.open with authorize URL when Connect is clicked", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);

    mockConnectors([]);
    await renderSkillsTab(["github"]);

    const connectButton = await waitFor(() =>
      screen.getByRole("button", { name: "Connect" }),
    );

    fireEvent.click(connectButton);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/connectors/github/authorize"),
        "_blank",
        "width=600,height=700",
      );
    });

    openSpy.mockRestore();
  });

  it("calls window.open when Reconnect is clicked on expired connector", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);

    mockConnectors([
      makeConnector({
        type: "github",
        needsReconnect: true,
        oauthScopes: ["repo", "project"],
      }),
    ]);

    await renderSkillsTab(["github"]);

    const reconnectButton = await waitFor(() =>
      screen.getByRole("button", { name: "Reconnect" }),
    );

    fireEvent.click(reconnectButton);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/connectors/github/authorize"),
        "_blank",
        "width=600,height=700",
      );
    });

    openSpy.mockRestore();
  });

  it("opens ConnectModal when Add API key is clicked", async () => {
    mockConnectors([]);
    await renderSkillsTab(["axiom"]);

    const addApiKeyButton = await waitFor(() =>
      screen.getByRole("button", { name: "Add API key" }),
    );

    fireEvent.click(addApiKeyButton);

    // ConnectModal should open showing the connector's dialog with API token form
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });
});

describe("zero skill card scope review modal", () => {
  it("opens ScopeReviewModal and shows scope diff when Review is clicked", async () => {
    mockConnectors([
      makeConnector({
        type: "github",
        oauthScopes: ["repo"],
      }),
    ]);

    const scopeDiff: ScopeDiff = {
      addedScopes: ["project"],
      removedScopes: [],
      currentScopes: ["repo", "project"],
      storedScopes: ["repo"],
    };

    server.use(
      http.get("*/api/connectors/github/scope-diff", () => {
        return HttpResponse.json(scopeDiff);
      }),
    );

    await renderSkillsTab(["github"]);

    const reviewButton = await waitFor(() =>
      screen.getByRole("button", { name: "Review" }),
    );

    fireEvent.click(reviewButton);

    // ScopeReviewModal should open
    await waitFor(() => {
      expect(
        screen.getByText("GitHub — Permissions Update"),
      ).toBeInTheDocument();
    });

    // Added scope should render
    await waitFor(() => {
      expect(screen.getByText("project")).toBeInTheDocument();
      expect(screen.getByText("New permissions")).toBeInTheDocument();
    });
  });

  it("calls window.open when Reconnect is clicked in ScopeReviewModal", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);

    mockConnectors([
      makeConnector({
        type: "github",
        oauthScopes: ["repo"],
      }),
    ]);

    server.use(
      http.get("*/api/connectors/github/scope-diff", () => {
        return HttpResponse.json({
          addedScopes: ["project"],
          removedScopes: [],
          currentScopes: ["repo", "project"],
          storedScopes: ["repo"],
        } satisfies ScopeDiff);
      }),
    );

    await renderSkillsTab(["github"]);

    const reviewButton = await waitFor(() =>
      screen.getByRole("button", { name: "Review" }),
    );

    fireEvent.click(reviewButton);

    // Wait for modal to appear
    await waitFor(() => {
      expect(
        screen.getByText("GitHub — Permissions Update"),
      ).toBeInTheDocument();
    });

    // Click Reconnect in the modal
    const reconnectButton = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(reconnectButton);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/connectors/github/authorize"),
        "_blank",
        "width=600,height=700",
      );
    });

    openSpy.mockRestore();
  });
});
