/**
 * Tests for the /connectors page (ZeroConnectorsPage component).
 *
 * Tests page-level behavior via setupPage following platform testing principles:
 * - Entry point: setupPage({ path: "/connectors" })
 * - Mock (external): Web API via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { mockConnectors } from "./zero-connectors-page-test-helpers.ts";
import { zeroConnectorsByTypeContract } from "@vm0/core";
import { mockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();

describe("connectors page", () => {
  it("renders the page header and search input", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText("Search connectors"),
    ).toBeInTheDocument();
  });

  it("shows available connectors when none are connected", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    // Default mock returns no connected connectors, so all should be in "Available"
    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.getByText(/Available/)).toBeInTheDocument();
    // "Connected" section should not appear
    expect(screen.queryByText(/Connected \(/)).not.toBeInTheDocument();
  });

  it("shows connected and available sections when some connectors are connected", async () => {
    mockConnectors([{ type: "github", externalUsername: "testuser" }]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText(/Connected \(/)).toBeInTheDocument();
    });
    // The connected connector should show the GitHub label
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText(/Available/)).toBeInTheDocument();
  });

  it("filters connectors by search term", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search connectors");
    await fill(searchInput, "github");

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    // Slack should not be visible when searching for "github"
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
  });

  it("shows empty state when search has no matches", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Search connectors");
    await fill(searchInput, "nonexistent-connector-xyz");

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
  });

  it("shows loading toast then success toast on disconnect", async () => {
    const user = userEvent.setup();
    mockConnectors([{ type: "github", externalUsername: "testuser" }]);

    let deleteResolve: () => void;
    const deletePromise = new Promise<void>((resolve) => {
      deleteResolve = resolve;
    });

    server.use(
      mockApi(zeroConnectorsByTypeContract.delete, async ({ respond }) => {
        await deletePromise;
        return respond(204);
      }),
    );

    detachedSetupPage({ context, path: "/connectors" });

    // Wait for the connected GitHub card to appear
    await waitFor(() => {
      expect(screen.getByText(/Connected \(/)).toBeInTheDocument();
    });

    // Radix DropdownMenu opens on click
    const moreButton = screen.getByLabelText("More options");
    await user.click(moreButton);

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Disconnect"));

    // Loading toast should appear while API is in-flight
    await waitFor(() => {
      expect(screen.getByText("Disconnecting GitHub...")).toBeInTheDocument();
    });

    // Resolve the API call
    deleteResolve!();

    // Success toast should replace the loading toast
    await waitFor(() => {
      expect(screen.getByText("GitHub disconnected")).toBeInTheDocument();
    });
  });

  it("shows error toast when disconnect fails", async () => {
    const user = userEvent.setup();
    mockConnectors([{ type: "github", externalUsername: "testuser" }]);

    server.use(
      mockApi(zeroConnectorsByTypeContract.delete, ({ respond }) => {
        return respond(404, {
          error: { message: "Failed to disconnect", code: "NOT_FOUND" },
        });
      }),
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText(/Connected \(/)).toBeInTheDocument();
    });

    // Radix DropdownMenu opens on click
    const moreButton = screen.getByLabelText("More options");
    await user.click(moreButton);

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Disconnect"));

    await waitFor(() => {
      expect(
        screen.getByText("Failed to disconnect GitHub"),
      ).toBeInTheDocument();
    });
  });
});
