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
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { mockConnectors } from "./zero-connectors-page-test-helpers.ts";
import { zeroConnectorsByTypeContract } from "@vm0/core/contracts/zero-connectors";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("connectors page", () => {
  it("renders the page header and search input", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Connectors" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText("Find connectors")).toBeInTheDocument();
  });

  it("shows available connectors when none are connected", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId("connector-category-ai"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-category-ai-general-models"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("connector-category-engineering-team-execution"),
    ).not.toBeInTheDocument();
  });

  it("shows connected connectors", async () => {
    mockConnectors([{ type: "github", externalUsername: "testuser" }]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByLabelText("More options")).toBeInTheDocument();
  });

  it("filters connectors by search term", async () => {
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Find connectors");
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

    const searchInput = screen.getByPlaceholderText("Find connectors");
    await fill(searchInput, "nonexistent-connector-xyz");

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
  });

  it("matches connectors by tag keyword", async () => {
    // GitHub declares tags: ["gh", "gh_api_key", "git", "vcs", "scm", "repos"].
    // "vcs" is not in the GitHub label/type/helpText, so a match on "vcs"
    // exercises the tags match path specifically.
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Find connectors");
    await fill(searchInput, "vcs");

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    // Slack's label, type, helpText, and tags do not contain "vcs".
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
  });

  it("matches connectors by helpText (description) keyword", async () => {
    // Axiom's helpText contains "query logs" but neither its label ("Axiom")
    // nor its type ("axiom") contains "logs", so matching on "logs"
    // exercises the helpText match path specifically.
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText("Find connectors");
    await fill(searchInput, "logs");

    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    // GitHub's label, type, helpText, and tags do not contain "logs".
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("shows loading toast then success toast on disconnect", async () => {
    mockConnectors([{ type: "github", externalUsername: "testuser" }]);

    const deleteDeferred = createDeferredPromise<void>(context.signal);

    server.use(
      mockApi(zeroConnectorsByTypeContract.delete, async ({ respond }) => {
        await deleteDeferred.promise;
        return respond(204);
      }),
    );

    detachedSetupPage({ context, path: "/connectors" });

    // Wait for the connected GitHub card to appear
    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    // Radix DropdownMenu opens on click
    const moreButton = screen.getByLabelText("More options");
    click(moreButton);

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });
    click(screen.getByText("Disconnect"));

    // Loading toast should appear while API is in-flight
    await waitFor(() => {
      expect(screen.getByText("Disconnecting GitHub...")).toBeInTheDocument();
    });

    // Resolve the API call
    deleteDeferred.resolve();

    // Success toast should replace the loading toast
    await waitFor(() => {
      expect(screen.getByText("GitHub disconnected")).toBeInTheDocument();
    });
  });

  it("shows error toast when disconnect fails", async () => {
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
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });

    // Radix DropdownMenu opens on click
    const moreButton = screen.getByLabelText("More options");
    click(moreButton);

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });
    click(screen.getByText("Disconnect"));

    await waitFor(() => {
      expect(
        screen.getByText("Failed to disconnect GitHub"),
      ).toBeInTheDocument();
    });
  });
});
