import {
  zeroConnectorOauthStartContract,
  zeroConnectorScopeDiffContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
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
  queryAllByRoleFast,
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

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
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

function customConnector(
  overrides: Partial<CustomConnectorResponse>,
): CustomConnectorResponse {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "acme-search",
    displayName: "Acme Search",
    prefixes: ["https://api.acme.test/v1/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
    hasSecret: false,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function mockCustomConnectorStory(): void {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });

  let connectors: CustomConnectorResponse[] = [];

  context.mocks.api(zeroCustomConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  context.mocks.api(
    zeroCustomConnectorsContract.create,
    ({ body, respond }) => {
      const created = customConnector({
        displayName: body.displayName,
        prefixes: body.prefixes,
        headerName: body.headerName,
        headerTemplate: body.headerTemplate,
      });
      connectors = [...connectors, created];
      return respond(201, created);
    },
  );
  context.mocks.api(
    zeroCustomConnectorSecretContract.set,
    ({ params, respond }) => {
      connectors = connectors.map((connector) => {
        return connector.id === params.id
          ? { ...connector, hasSecret: true }
          : connector;
      });
      return respond(204);
    },
  );
  context.mocks.api(
    zeroCustomConnectorSecretContract.delete,
    ({ params, respond }) => {
      connectors = connectors.map((connector) => {
        return connector.id === params.id
          ? { ...connector, hasSecret: false }
          : connector;
      });
      return respond(204);
    },
  );
  context.mocks.api(
    zeroCustomConnectorByIdContract.patch,
    ({ params, body, respond }) => {
      let renamed = connectors.find((connector) => {
        return connector.id === params.id;
      });
      connectors = connectors.map((connector) => {
        if (connector.id !== params.id) {
          return connector;
        }
        renamed = { ...connector, displayName: body.displayName };
        return renamed;
      });
      return respond(200, renamed ?? customConnector({}));
    },
  );
  context.mocks.api(
    zeroCustomConnectorByIdContract.delete,
    ({ params, respond }) => {
      connectors = connectors.filter((connector) => {
        return connector.id !== params.id;
      });
      return respond(204);
    },
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

  it("manages a custom connector from creation through deletion", async () => {
    mockCustomConnectorStory();

    detachedSetupPage({ context, path: "/connectors" });

    click(await screen.findByText("Custom"));

    await waitFor(() => {
      expect(screen.getByText("New connector")).toBeInTheDocument();
      expect(
        screen.getByText(
          "No custom connectors yet. Create one to register an API for every member to use.",
        ),
      ).toBeInTheDocument();
    });

    click(screen.getByText("New connector"));

    const createDialog = await screen.findByRole("dialog");
    await fill(within(createDialog).getByLabelText("Display name"), "Acme API");
    await fill(
      within(createDialog).getByLabelText(/Prefixes/u),
      "https://api.acme.test/v1/",
    );
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      expect(screen.getByText("Acme API")).toBeInTheDocument();
      expect(screen.getByText("https://api.acme.test/v1/")).toBeInTheDocument();
    });

    click(screen.getByText("Connect"));

    const connectDialog = await screen.findByRole("dialog");
    expect(
      within(connectDialog).getByText("Connect Acme API"),
    ).toBeInTheDocument();
    await fill(within(connectDialog).getByLabelText("Secret"), "acme-secret");
    click(buttonByText("Save", connectDialog));

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Rename"));

    const renameDialog = await screen.findByRole("dialog");
    await fill(
      within(renameDialog).getByLabelText("Display name"),
      "Acme Billing API",
    );
    click(buttonByText("Save", renameDialog));

    await waitFor(() => {
      expect(screen.getByText("Acme Billing API")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByText("Connect")).toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Delete"));

    const deleteDialog = await screen.findByRole("dialog");
    expect(
      within(deleteDialog).getByText("Delete Acme Billing API?"),
    ).toBeInTheDocument();
    click(buttonByText("Delete", deleteDialog));

    await waitFor(() => {
      expect(
        screen.getByText(
          "No custom connectors yet. Create one to register an API for every member to use.",
        ),
      ).toBeInTheDocument();
    });
  });
});
