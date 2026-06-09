import {
  zeroConnectorOauthStartContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockConnectorOauthStart(): void {
  context.mocks.api(
    zeroConnectorOauthStartContract.start,
    ({ params, respond }) => {
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
      });
    },
  );
}

function createMockAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });
  return authWindow;
}

function mockConnectors(
  connectors: {
    type: ConnectorType;
    authMethod?: ConnectorAuthMethodId;
    externalUsername?: string;
    connectionStatus?: ConnectorResponse["connectionStatus"];
    oauthScopes?: string[];
    tokenExpiresAt?: string | null;
  }[],
): void {
  context.mocks.data.connectors(
    connectors.map((connector) => {
      return {
        id: crypto.randomUUID(),
        type: connector.type,
        authMethod: connector.authMethod ?? "oauth",
        externalId: null,
        externalUsername: connector.externalUsername ?? null,
        externalEmail: null,
        oauthScopes: connector.oauthScopes ?? null,
        connectionStatus: connector.connectionStatus ?? "connected",
        tokenExpiresAt: connector.tokenExpiresAt ?? null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    }),
  );
}

describe("connectors page", () => {
  it("lets users search connectors and browse grouped categories", async () => {
    mockConnectors([
      { type: "github", externalUsername: "octocat" },
      { type: "openai", authMethod: "api-token" },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });

    const engineeringSection = screen.getByTestId(
      "connector-category-engineering-team-execution",
    );
    const engineeringLabels = within(engineeringSection)
      .getAllByTestId("connector-card-label")
      .map((element) => {
        return element.textContent;
      });
    expect(engineeringLabels[0]).toBe("GitHub");
    expect(engineeringLabels).toContain("Asana");

    const aiGroup = screen.getByTestId("connector-category-ai");
    const engineeringGroup = screen.getByTestId(
      "connector-category-engineering-team-execution",
    );
    expect(
      aiGroup.compareDocumentPosition(engineeringGroup) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const searchInput = screen.getByPlaceholderText("Find connectors");
    await fill(searchInput, "vcs");
    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();

    await fill(searchInput, "logs");
    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();

    await fill(searchInput, "nonexistent-connector-xyz");
    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
  });

  it("keeps a reconnecting connector visibly pending until the OAuth update arrives", async () => {
    mockConnectors([
      {
        type: "github",
        connectionStatus: "reconnect-required",
        oauthScopes: ["repo", "project", "workflow"],
      },
    ]);
    mockConnectorOauthStart();
    context.mocks.browser.open(createMockAuthWindow());

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("Reconnect")).toBeInTheDocument();
    });

    context.mocks.api(zeroConnectorsMainContract.list, ({ never }) => {
      return never();
    });

    await userEvent.click(screen.getByText("Reconnect"));

    await waitFor(() => {
      expect(
        screen.getAllByText((_, element) => {
          return element?.textContent?.includes("Connecting") ?? false;
        }).length,
      ).toBeGreaterThan(0);
    });
  });

  it("opens the right consent surface for token, Google, and scope-review flows", async () => {
    mockConnectors([{ type: "github", oauthScopes: [] }]);
    context.mocks.api(
      zeroConnectorScopeDiffContract.getScopeDiff,
      ({ respond }) => {
        return respond(200, {
          addedScopes: ["repo", "project"],
          removedScopes: [],
          currentScopes: [],
          storedScopes: ["repo", "project"],
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect Axiom"));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
    await userEvent.keyboard("{Escape}");

    click(screen.getByLabelText("Connect Gmail"));
    await waitFor(() => {
      expect(
        screen.getByText(/Google will show a security warning/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Go to vm0\.ai \(unsafe\)/)).toBeInTheDocument();
    });
    await userEvent.keyboard("{Escape}");

    click(screen.getByText("Review"));
    await waitFor(() => {
      expect(screen.getByText("repo")).toBeInTheDocument();
      expect(screen.getByText("project")).toBeInTheDocument();
    });
  });

  it("reports a failed connector disconnect", async () => {
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.api(zeroConnectorsByTypeContract.delete, ({ respond }) => {
      return respond(404, {
        error: { message: "Failed to disconnect", code: "NOT_FOUND" },
      });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("More options")).toBeInTheDocument();
    });
    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByText("Failed to disconnect")).toBeInTheDocument();
    });
  });
});
