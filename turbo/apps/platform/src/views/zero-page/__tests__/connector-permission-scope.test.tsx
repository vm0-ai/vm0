/**
 * Tests for ScopeReviewModal component.
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setScopeReviewType$ } from "../../../signals/zero-page/settings/connectors.ts";
import type { ConnectorType } from "@vm0/api-contracts/contracts/connectors";
import { zeroConnectorScopeDiffContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

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
    mockApi(zeroConnectorScopeDiffContract.getScopeDiff, ({ respond }) => {
      return respond(200, scopeDiff);
    }),
  );
  detachedSetupPage({ context, path: "/connectors" });
  await waitFor(() => {
    expect(
      screen.getByRole("heading", { name: "Connectors" }),
    ).toBeInTheDocument();
  });
  context.store.set(setScopeReviewType$, connectorType);
}

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

    // Label and ConnectorIcon img are rendered inside the dialog
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("GitHub");
    expect(dialog.querySelector("img")).toBeInTheDocument();
  });

  it("shows added scopes with + prefix (CONN-D-034)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: ["repo", "project"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(screen.getByText("New permissions")).toBeInTheDocument();
    });
    const newPermissionsSection = screen
      .getByText("New permissions")
      .closest("div");
    expect(newPermissionsSection).toBeInTheDocument();
    expect(
      within(newPermissionsSection!).getByText("repo"),
    ).toBeInTheDocument();
    expect(
      within(newPermissionsSection!).getByText("project"),
    ).toBeInTheDocument();
  });

  it("shows removed scopes with - prefix (CONN-D-035)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: [],
      removedScopes: ["read:user"],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(screen.getByText("Removed permissions")).toBeInTheDocument();
    });
    const removedPermissionsSection = screen
      .getByText("Removed permissions")
      .closest("div");
    expect(removedPermissionsSection).toBeInTheDocument();
    expect(
      within(removedPermissionsSection!).getByText("read:user"),
    ).toBeInTheDocument();
  });

  it("shows Reconnect and Close buttons when scope data is loaded (CONN-D-036)", async () => {
    await openScopeReviewModal("github", {
      addedScopes: ["repo"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Reconnect";
        }),
      ).toBeDefined();
    });
    const dialog = screen.getByRole("dialog");
    const closeButtons = within(dialog).getAllByRole("button");
    const textCloseButton = closeButtons.find((btn) => {
      return btn.textContent?.trim() === "Close";
    });
    expect(textCloseButton).toBeInTheDocument();
  });
});

describe("scope review modal - states", () => {
  it("loading state shows dialog without Reconnect button (CONN-S-037)", async () => {
    server.use(
      mockApi(zeroConnectorScopeDiffContract.getScopeDiff, ({ never }) => {
        return never();
      }),
    );

    detachedSetupPage({ context, path: "/connectors" });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
    context.store.set(setScopeReviewType$, "github");

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.queryAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Reconnect";
      }),
    ).toBeUndefined();
  });

  it("error state shows dialog without Reconnect button (CONN-C-038)", async () => {
    server.use(
      mockApi(zeroConnectorScopeDiffContract.getScopeDiff, ({ respond }) => {
        return respond(404, {
          error: { message: "Internal error", code: "NOT_FOUND" },
        });
      }),
    );

    detachedSetupPage({ context, path: "/connectors" });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
    context.store.set(setScopeReviewType$, "github");

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.queryAllByRole("button").find((el) => {
        return el.textContent?.trim() === "Reconnect";
      }),
    ).toBeUndefined();
  });
});

describe("scope review modal - interactions", () => {
  it("reconnect button triggers connector reconnection (CONN-I-039)", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue({ closed: true } as unknown as Window);

    await openScopeReviewModal("github", {
      addedScopes: ["repo"],
      removedScopes: [],
      currentScopes: [],
      storedScopes: [],
    });

    await waitFor(() => {
      expect(
        screen.getAllByRole("button").find((el) => {
          return el.textContent?.trim() === "Reconnect";
        }),
      ).toBeDefined();
    });

    const reconnectBtn = screen.getAllByRole("button").find((el) => {
      return el.textContent?.trim() === "Reconnect";
    });
    expect(reconnectBtn).toBeDefined();
    click(reconnectBtn!);

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

    const dialog = screen.getByRole("dialog");
    const closeButtons = within(dialog).getAllByRole("button");
    const textCloseButton = closeButtons.find((btn) => {
      return btn.textContent?.trim() === "Close";
    });
    if (!textCloseButton) {
      throw new Error("Close button not found");
    }
    click(textCloseButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
