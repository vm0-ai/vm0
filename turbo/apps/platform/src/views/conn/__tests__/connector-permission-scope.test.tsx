/**
 * Tests for ConnectorPermissionDialog and ScopeReviewModal.
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import {
  setPermissionDialogType$,
  setScopeReviewType$,
} from "../../../signals/zero-page/settings/connectors.ts";
import type { ConnectorType } from "@vm0/core";

const context = testContext();

afterEach(() => {
  vi.restoreAllMocks();
});

function mockAgents(
  agents: { id: string; displayName: string; avatarUrl?: string }[],
) {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json(
        agents.map((a) => {
          return {
            id: a.id,
            displayName: a.displayName,
            description: null,
            sound: null,
            avatarUrl: a.avatarUrl ?? null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
          };
        }),
      );
    }),
  );
}

async function openPermissionDialog(connectorType: ConnectorType = "github") {
  await setupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connectors" }),
    ).toBeInTheDocument();
  });
  context.store.set(setPermissionDialogType$, connectorType);
}

async function openScopeReviewModal(
  connectorType: ConnectorType,
  scopeDiff: {
    addedScopes: string[];
    removedScopes: string[];
    currentScopes: string[];
    storedScopes: string[];
  },
) {
  server.use(
    http.get("*/api/zero/connectors/:type/scope-diff", () => {
      return HttpResponse.json(scopeDiff);
    }),
  );
  await setupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connectors" }),
    ).toBeInTheDocument();
  });
  context.store.set(setScopeReviewType$, connectorType);
}

describe("connector permission dialog - display", () => {
  it("shows connector icon and label (CONN-D-025)", async () => {
    mockAgents([]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Label displayed in dialog header and ConnectorIcon as img
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("GitHub");
    expect(dialog.querySelector("img")).toBeInTheDocument();
  });

  it("shows agent avatars and names in grid (CONN-D-026)", async () => {
    mockAgents([
      { id: "agent-1", displayName: "Agent Alpha" },
      { id: "agent-2", displayName: "Agent Beta" },
    ]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });
    expect(screen.getByText("Agent Beta")).toBeInTheDocument();

    // Each agent card shows an avatar img
    const agentButtons = screen.getAllByRole("button", {
      name: /Agent (Alpha|Beta)/,
    });
    for (const btn of agentButtons) {
      expect(btn.querySelector("img")).toBeInTheDocument();
    }
  });

  it("selected agent shows checkmark instead of avatar (CONN-D-027)", async () => {
    const user = userEvent.setup();
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    const agentButton = screen.getByRole("button", { name: /Agent Alpha/ });
    // Before selection: avatar img present
    expect(agentButton.querySelector("img")).toBeInTheDocument();

    await user.click(agentButton);

    // After selection: checkmark SVG present, no img
    expect(agentButton.querySelector("svg")).toBeInTheDocument();
    expect(agentButton.querySelector("img")).not.toBeInTheDocument();
  });

  it("shows N+ more indicator for overflow agents (CONN-D-028)", async () => {
    const agents = Array.from({ length: 18 }, (_, i) => {
      return {
        id: `agent-${i}`,
        displayName: `Agent ${String(i).padStart(2, "0")}`,
      };
    });
    mockAgents(agents);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent 00")).toBeInTheDocument();
    });

    expect(screen.getByText("2+ more")).toBeInTheDocument();
  });
});

describe("connector permission dialog - interactions", () => {
  it("search input filters agent list (CONN-I-029)", async () => {
    const user = userEvent.setup();
    mockAgents([
      { id: "agent-1", displayName: "Agent Alpha" },
      { id: "agent-2", displayName: "Agent Beta" },
      { id: "agent-3", displayName: "Helper Bot" },
    ]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("Search your agents"), "alpha");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });
    expect(screen.queryByText("Agent Beta")).not.toBeInTheDocument();
    expect(screen.queryByText("Helper Bot")).not.toBeInTheDocument();
  });

  it("agent click toggles selection between selected and deselected (CONN-I-030)", async () => {
    const user = userEvent.setup();
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    const agentButton = screen.getByRole("button", { name: /Agent Alpha/ });

    // Click once → selected (checkmark SVG)
    await user.click(agentButton);
    expect(agentButton.querySelector("svg")).toBeInTheDocument();

    // Click again → deselected (avatar img)
    await user.click(agentButton);
    expect(agentButton.querySelector("img")).toBeInTheDocument();
  });

  it("later button closes dialog without saving agent permissions (CONN-I-031)", async () => {
    const user = userEvent.setup();
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    let putCalled = false;
    server.use(
      http.put("*/api/zero/agents/:id/user-connectors", () => {
        putCalled = true;
        return HttpResponse.json({ enabledTypes: ["github"] });
      }),
    );

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    // Select an agent, then click Later
    await user.click(screen.getByRole("button", { name: /Agent Alpha/ }));
    await user.click(screen.getByRole("button", { name: "Later" }));

    await waitFor(() => {
      expect(
        screen.queryByText(/successfully connected with GitHub/),
      ).not.toBeInTheDocument();
    });

    expect(putCalled).toBeFalsy();
  });

  it("confirm button saves selected agent permissions (CONN-I-032)", async () => {
    const user = userEvent.setup();
    mockAgents([{ id: "agent-1", displayName: "Agent Alpha" }]);

    server.use(
      http.put("*/api/zero/agents/:id/user-connectors", async ({ request }) => {
        const body = (await request.json()) as { enabledTypes: string[] };
        return HttpResponse.json({ enabledTypes: body.enabledTypes });
      }),
    );

    await openPermissionDialog("github");

    await waitFor(() => {
      expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /Agent Alpha/ }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(
        screen.getByText("GitHub enabled for 1 agent"),
      ).toBeInTheDocument();
    });
  });
});

describe("scope review modal - display", () => {
  it("shows connector icon and label (CONN-D-033)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: ["repo"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    // Label and icon are rendered inside the dialog
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("GitHub");
    expect(dialog.querySelector(".shrink-0")).toBeInTheDocument();
  });

  it("shows added scopes with + prefix (CONN-D-034)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: ["repo", "project"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      const plusItems = screen.getAllByText("+");
      expect(plusItems.length).toBeGreaterThan(0);
    });
    expect(screen.getByText("repo")).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
  });

  it("shows removed scopes with - prefix (CONN-D-035)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: [],
      removedScopes: ["read:user"],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      const minusItems = screen.getAllByText("-");
      expect(minusItems.length).toBeGreaterThan(0);
    });
    expect(screen.getByText("read:user")).toBeInTheDocument();
  });

  it("shows Permissions Update text (CONN-D-036)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: ["repo"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(screen.getByText(/Permissions Update/)).toBeInTheDocument();
    });
  });
});

describe("scope review modal - states", () => {
  it("loading state shows Loading scope changes... (CONN-S-037)", async () => {
    server.use(
      http.get("*/api/zero/connectors/:type/scope-diff", () => {
        return new Promise<never>(() => {
          // Never resolves — keeps component in loading state
        });
      }),
    );

    await setupPage({ context, path: "/connectors" });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
    context.store.set(setScopeReviewType$, "github" as ConnectorType);

    await waitFor(() => {
      expect(screen.getByText("Loading scope changes...")).toBeInTheDocument();
    });
  });

  it("error state shows error message (CONN-C-038)", async () => {
    server.use(
      http.get("*/api/zero/connectors/:type/scope-diff", () => {
        return HttpResponse.json(
          { message: "Internal error" },
          { status: 500 },
        );
      }),
    );

    await setupPage({ context, path: "/connectors" });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
    context.store.set(setScopeReviewType$, "github" as ConnectorType);

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load scope changes."),
      ).toBeInTheDocument();
    });
  });
});

describe("scope review modal - interactions", () => {
  it("reconnect button triggers connector reconnection (CONN-I-039)", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as Window);

    await openScopeReviewModal("github", {
      addedScopes: ["repo"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reconnect" }),
      ).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/zero/connectors/github/authorize"),
        "_blank",
        expect.any(String),
      );
    });
  });

  it("close button closes the ScopeReviewModal (CONN-I-040)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: ["repo"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const user = userEvent.setup();
    // Click the explicit Close button (not the dialog's X button)
    const dialog = screen.getByRole("dialog");
    const closeButtons = dialog.querySelectorAll("button");
    const closeButton = Array.from(closeButtons).find((btn) => {
      return btn.textContent?.trim() === "Close";
    });
    expect(closeButton).toBeInTheDocument();
    await user.click(closeButton!);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
