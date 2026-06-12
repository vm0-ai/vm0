import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  CONNECTOR_TYPES,
  type ConnectorAuthMethodConfig,
  type ConnectorAuthMethodId,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

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

function connectorCardByLabel(label: string): HTMLElement {
  const labelElement = screen
    .getAllByTestId("connector-card-label")
    .find((element) => {
      return element.textContent === label;
    });
  const card = labelElement?.closest(".zero-card");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`${label} connector card not found`);
  }
  return card;
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
  const restoreConnectorRegistry: (() => void)[] = [];

  afterEach(() => {
    while (restoreConnectorRegistry.length > 0) {
      restoreConnectorRegistry.pop()?.();
    }
  });

  it("lets users browse connectors by grouped categories", async () => {
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
  });

  it("navigates connector categories and opens a connector from the keyboard", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-category-menu-ai"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("connector-category-menu-ai"));
    click(screen.getByTestId("connector-category-menu-ai-general-models"));
    click(
      screen.getByTestId("connector-category-menu-engineering-team-execution"),
    );

    const axiomCard = await screen.findByLabelText("Connect Axiom");
    fireEvent.keyDown(axiomCard, { key: " ", code: "Space" });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Axiom" })).toBeInTheDocument();
      expect(screen.getByText("Save")).toBeInTheDocument();
    });
  });

  it("filters connectors by integration keywords", async () => {
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "vcs");

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
  });

  it("filters connectors by capability keywords", async () => {
    mockConnectors([
      { type: "github", externalUsername: "octocat" },
      { type: "axiom", authMethod: "api-token" },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "logs");

    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("shows an empty state when connector search has no matches", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "nonexistent-connector-xyz");

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
  });

  it("hides a fully feature-gated connector when its switch is disabled", async () => {
    mockConnectors([]);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.AwsConnector]: false },
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "aws");

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Connect AWS")).not.toBeInTheDocument();
  });

  it("shows a partially gated connector with only ungated auth methods", async () => {
    mockConnectors([]);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: false },
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "stripe");
    click(await screen.findByLabelText("Connect Stripe"));

    const connectDialog = await screen.findByRole("dialog", {
      name: "Stripe",
    });
    expect(
      within(connectDialog).getByText("Sign in with Stripe"),
    ).toBeInTheDocument();
    expect(
      within(connectDialog).getAllByText("API Key").length,
    ).toBeGreaterThan(0);
    expect(
      within(connectDialog).queryByText("OAuth (Recommended)"),
    ).not.toBeInTheDocument();
  });

  it("hides statically hidden auth methods from the connect dialog", async () => {
    mockConnectors([]);
    const authMethods = CONNECTOR_TYPES.stripe.authMethods;
    const originalOauth = authMethods.oauth;

    restoreConnectorRegistry.push(() => {
      Object.defineProperty(authMethods, "oauth", {
        value: originalOauth,
        configurable: true,
        enumerable: true,
      });
    });
    Object.defineProperty(authMethods, "oauth", {
      value: {
        ...originalOauth,
        visible: false,
      } satisfies ConnectorAuthMethodConfig,
      configurable: true,
      enumerable: true,
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: true },
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "stripe");
    click(await screen.findByLabelText("Connect Stripe"));

    const connectDialog = await screen.findByRole("dialog", {
      name: "Stripe",
    });
    expect(
      within(connectDialog).getByText("Sign in with Stripe"),
    ).toBeInTheDocument();
    expect(
      within(connectDialog).getAllByText("API Key").length,
    ).toBeGreaterThan(0);
    expect(
      within(connectDialog).queryByText("OAuth (Recommended)"),
    ).not.toBeInTheDocument();
  });

  it("hides a connector when all auth methods are statically hidden", async () => {
    mockConnectors([]);
    const authMethods = CONNECTOR_TYPES.stripe.authMethods;
    const originalOauth = authMethods.oauth;
    const originalCli = authMethods.cli;
    const originalApiToken = authMethods["api-token"];

    restoreConnectorRegistry.push(() => {
      Object.defineProperty(authMethods, "oauth", {
        value: originalOauth,
        configurable: true,
        enumerable: true,
      });
    });
    Object.defineProperty(authMethods, "oauth", {
      value: {
        ...originalOauth,
        visible: false,
      } satisfies ConnectorAuthMethodConfig,
      configurable: true,
      enumerable: true,
    });
    restoreConnectorRegistry.push(() => {
      Object.defineProperty(authMethods, "cli", {
        value: originalCli,
        configurable: true,
        enumerable: true,
      });
    });
    Object.defineProperty(authMethods, "cli", {
      value: {
        ...originalCli,
        visible: false,
      } satisfies ConnectorAuthMethodConfig,
      configurable: true,
      enumerable: true,
    });
    restoreConnectorRegistry.push(() => {
      Object.defineProperty(authMethods, "api-token", {
        value: originalApiToken,
        configurable: true,
        enumerable: true,
      });
    });
    Object.defineProperty(authMethods, "api-token", {
      value: {
        ...originalApiToken,
        visible: false,
      } satisfies ConnectorAuthMethodConfig,
      configurable: true,
      enumerable: true,
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.StripeConnector]: true },
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "stripe");

    await waitFor(() => {
      expect(screen.getByText(/No connectors matching/)).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Connect Stripe")).not.toBeInTheDocument();
  });

  it("completes a device-auth connector grant", async () => {
    mockConnectors([]);

    context.mocks.browser.open(createMockAuthWindow());
    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Base44")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Connect Base44"));

    const deviceDialog = await screen.findByRole("dialog", { name: "Base44" });
    click(buttonByText("Connect Base44", deviceDialog));

    await waitFor(() => {
      expect(
        screen.getByTestId("connector-oauth-device-code"),
      ).toHaveTextContent("VM0-DEVICE");
    });
    click(screen.getByTestId("connector-oauth-device-open"));

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("Base44")).getByText("Connected"),
      ).toBeInTheDocument();
    });
  });

  it("connects a manual token connector", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect Axiom"));

    const axiomDialog = await screen.findByRole("dialog", { name: "Axiom" });
    await fill(
      within(axiomDialog).getByPlaceholderText("xaat-..."),
      "xaat-test",
    );
    click(buttonByText("Save", axiomDialog));

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("Axiom")).getByText("Connected"),
      ).toBeInTheDocument();
    });

    click(within(connectorCardByLabel("Axiom")).getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Axiom")).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Axiom")).queryByText("Connected"),
      ).not.toBeInTheDocument();
    });
  });

  it("connects AWS with an authorization code and authorizes an agent", async () => {
    mockConnectors([]);
    context.mocks.data.team([
      {
        id: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user-123",
        displayName: "Research Agent",
        description: null,
        sound: null,
        avatarUrl: null,
        customSkills: [],
        visibility: "public",
        headVersionId: "version_1",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ]);
    context.mocks.browser.open(createMockAuthWindow());

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.AwsConnector]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors"), "aws");
    click(await screen.findByLabelText("Connect AWS"));

    const connectDialog = await screen.findByRole("dialog", { name: "AWS" });
    expect(
      within(connectDialog).getByText(
        /temporary AWS connector expires after up to 12 hours/,
      ),
    ).toBeInTheDocument();

    click(buttonByText("Start AWS sign-in", connectDialog));

    await waitFor(() => {
      expect(
        buttonByText("Open AWS sign-in", connectDialog),
      ).toBeInTheDocument();
    });

    click(buttonByText("Open AWS sign-in", connectDialog));
    await fill(
      within(connectDialog).getByTestId("connector-external-code-input"),
      "AWS-CODE",
    );
    click(
      within(connectDialog).getByTestId("connector-external-code-complete"),
    );

    await waitFor(() => {
      expect(
        screen.getByText("You've successfully connected with AWS!"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Research Agent"));
    click(buttonByText("Confirm"));

    await waitFor(() => {
      expect(screen.getByText("AWS enabled for 1 agent")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        within(connectorCardByLabel("AWS")).getByText(
          /@arn:aws:iam::000000000000:user\/mock-aws/u,
        ),
      ).toBeInTheDocument();
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
