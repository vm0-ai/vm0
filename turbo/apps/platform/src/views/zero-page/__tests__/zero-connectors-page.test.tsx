import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorSecretContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";
import {
  zeroConnectorOauthStartContract,
  zeroConnectorManualGrantContract,
  zeroConnectorOauthDeviceAuthSessionContract,
  zeroConnectorScopeDiffContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { zeroUserPermissionGrantsContract } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import type {
  ConnectorAuthMethodId,
  ConnectorType,
} from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { setFeatureSwitch$ } from "../../../signals/external/feature-switch.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { reloadAgentConnectorAuthorizations$ } from "../../../signals/zero-page/agent-connector-authorizations.ts";

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
  const button = queryButtonByText(text, container);
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function queryButtonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

function queryMenuItemByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

function menuItemByText(text: string): HTMLElement {
  const menuItem = queryMenuItemByText(text);
  if (!menuItem) {
    throw new Error(`${text} menu item not found`);
  }
  return menuItem;
}

function dialogForElement(element: HTMLElement): HTMLElement {
  const dialog = element.closest('[role="dialog"]');
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("dialog not found for element");
  }
  return dialog;
}

function queryConnectorCardByLabel(label: string): HTMLElement | null {
  const labelElement = screen
    .queryAllByTestId("connector-card-label")
    .find((element) => {
      return element.textContent === label;
    });
  const card = labelElement?.closest(".zero-card");
  if (labelElement && !(card instanceof HTMLElement)) {
    throw new Error(`${label} connector card label has no card container`);
  }
  return card instanceof HTMLElement ? card : null;
}

function connectorCardByLabel(label: string): HTMLElement {
  const card = queryConnectorCardByLabel(label);
  if (!(card instanceof HTMLElement)) {
    throw new Error(`${label} connector card not found`);
  }
  return card;
}

function applyUserConnectorUpdate(
  current: readonly string[],
  body: {
    readonly enabledTypes: readonly string[];
    readonly operation?: "replace" | "add" | "remove";
  },
): string[] {
  if (body.operation === "add") {
    return Array.from(new Set([...current, ...body.enabledTypes]));
  }
  if (body.operation === "remove") {
    return current.filter((type) => {
      return !body.enabledTypes.includes(type);
    });
  }
  return [...body.enabledTypes];
}

function reconnectReasonHelpButton(container: ParentNode): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((button) => {
      return (
        button.getAttribute("aria-label") === "Why this connection expired"
      );
    }) ?? null
  );
}

function teamAgent(
  id: string,
  displayName: string,
  avatarUrl: string | null = null,
): TeamComposeItem {
  return {
    id,
    ownerId: "test-user-123",
    displayName,
    description: null,
    sound: null,
    avatarUrl,
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  };
}

function mockConnectors(
  connectors: {
    type: ConnectorType;
    authMethod?: ConnectorAuthMethodId;
    externalUsername?: string;
    connectionStatus?: ConnectorResponse["connectionStatus"];
    reconnectReason?: ConnectorResponse["reconnectReason"];
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
        reconnectReason: connector.reconnectReason ?? null,
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
    prefixTemplates: ["https://api.acme.test/v1/"],
    fields: [
      {
        key: "secret",
        label: "Secret",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.secret}}",
      },
    ],
    queryInjections: [],
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    hasSecret: false,
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function publicStatusItem(args: {
  readonly connectorRef: ConnectorType;
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly authMethods: PublicConnectorCatalogStatusItem["authMethods"];
  readonly singleAuthCodeAuthMethodId?: string | null;
  readonly connectNotice?: PublicConnectorCatalogStatusItem["connectNotice"];
}): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: args.connectorRef,
    label: args.label,
    description: args.description ?? `${args.label} public description`,
    category: args.category ?? "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: args.authMethods,
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: false,
    connectionStatus: "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: args.singleAuthCodeAuthMethodId ?? null,
    connectNotice: args.connectNotice ?? null,
  };
}

function mockPublicConnectorStatus(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
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

function setupConnectorStatusFilterPage(path = "/connectors"): void {
  mockConnectors([{ type: "github", externalUsername: "octocat" }]);
  context.mocks.data.team([
    teamAgent("c0000000-0000-4000-a000-000000000020", "Research", "preset:0"),
  ]);
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledTypes: ["github"] });
  });

  detachedSetupPage({
    context,
    path,
  });
}

async function expectConnectorCardsVisible(expected: {
  readonly github: boolean;
  readonly asana: boolean;
}): Promise<void> {
  await waitFor(() => {
    if (expected.github) {
      expect(queryConnectorCardByLabel("GitHub")).toBeInTheDocument();
    } else {
      expect(queryConnectorCardByLabel("GitHub")).not.toBeInTheDocument();
    }

    if (expected.asana) {
      expect(queryConnectorCardByLabel("Asana")).toBeInTheDocument();
    } else {
      expect(queryConnectorCardByLabel("Asana")).not.toBeInTheDocument();
    }
  });
}

describe("connectors page", () => {
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

  it("does not show reconnect reason help on the connection expired badge", async () => {
    mockConnectors([
      {
        type: "github",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      },
    ]);

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("GitHub")).getByText("Connection expired"),
      ).toBeInTheDocument();
    });
    expect(
      reconnectReasonHelpButton(connectorCardByLabel("GitHub")),
    ).not.toBeInTheDocument();
  });

  it("moves reconnect into the connector options menu", async () => {
    mockConnectors([
      {
        type: "meta-ads",
        connectionStatus: "reconnect-required",
      },
    ]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        expect(params.type).toBe("meta-ads");
        return respond(200, {
          authorizationUrl: "https://oauth.test/meta-ads/authorize",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      const card = connectorCardByLabel("Meta Ads");
      expect(within(card).getByText("Connection expired")).toBeInTheDocument();
      expect(queryButtonByText("Reconnect", card)).not.toBeInTheDocument();
    });

    click(
      within(connectorCardByLabel("Meta Ads")).getByLabelText("More options"),
    );

    await waitFor(() => {
      expect(menuItemByText("Reconnect")).toBeInTheDocument();
    });
    click(menuItemByText("Reconnect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/meta-ads/authorize",
      );
    });
  });

  it("moves scope review into the connector options menu", async () => {
    const storedScopes = ["https://www.googleapis.com/auth/adwords"];
    const addedScopes = [
      "https://www.googleapis.com/auth/datamanager",
      "https://www.googleapis.com/auth/userinfo.email",
    ];
    mockConnectors([
      {
        type: "google-ads",
        oauthScopes: storedScopes,
      },
    ]);
    context.mocks.api(
      zeroConnectorScopeDiffContract.getScopeDiff,
      ({ params, respond }) => {
        expect(params.type).toBe("google-ads");
        return respond(200, {
          addedScopes,
          removedScopes: [],
          currentScopes: [...storedScopes, ...addedScopes],
          storedScopes,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      const card = connectorCardByLabel("Google Ads");
      expect(within(card).getByText("Update permissions")).toBeInTheDocument();
      expect(
        within(card).queryByText("Permissions update available"),
      ).not.toBeInTheDocument();
      expect(queryButtonByText("Review", card)).not.toBeInTheDocument();
    });

    click(
      within(connectorCardByLabel("Google Ads")).getByLabelText("More options"),
    );

    await waitFor(() => {
      expect(menuItemByText("Review permissions")).toBeInTheDocument();
    });
    click(menuItemByText("Review permissions"));

    const dialog = await screen.findByRole("dialog", {
      name: "Google Ads permissions update",
    });
    expect(within(dialog).getByText("New permissions")).toBeInTheDocument();
    expect(within(dialog).getByText(addedScopes[0])).toBeInTheDocument();
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
    expect(search()).toBe("?keywords=vcs");

    context.store.set(detachedNavigateTo$, ROUTES.connectors);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Find connectors")).toHaveValue("");
      expect(search()).toBe("");
    });
    expect(screen.getByText("Slack")).toBeInTheDocument();
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

  it("filters connectors by connected status", async () => {
    setupConnectorStatusFilterPage();
    await expectConnectorCardsVisible({ github: true, asana: true });

    const filterTrigger = screen.getByLabelText("Filter connectors");
    click(filterTrigger);
    click(menuItemByText("Connected"));

    await expectConnectorCardsVisible({ github: true, asana: false });
    expect(search()).toBe("?connection=connected");
  });

  it("filters connectors by not connected status", async () => {
    setupConnectorStatusFilterPage("/connectors?connection=connected");
    await expectConnectorCardsVisible({ github: true, asana: false });

    const filterTrigger = screen.getByLabelText("Filter connectors");
    click(filterTrigger);
    click(menuItemByText("Not connected"));

    await expectConnectorCardsVisible({ github: false, asana: true });
    expect(search()).toBe("?connection=not-connected");
  });

  it("clears connector status filter", async () => {
    setupConnectorStatusFilterPage(
      "/connectors?keywords=connect&connection=not-connected",
    );
    await expectConnectorCardsVisible({ github: false, asana: true });

    const filterTrigger = screen.getByLabelText("Filter connectors");
    click(filterTrigger);
    click(menuItemByText("All"));

    await expectConnectorCardsVisible({ github: true, asana: true });
    const params = new URLSearchParams(search());
    expect(params.get("keywords")).toBe("connect");
    expect(params.has("connection")).toBeFalsy();
  });

  it("filters connectors by agent", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000010";
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.data.team([teamAgent(agentId, "Research Agent", "preset:0")]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledTypes: params.id === agentId ? ["github"] : [],
      });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("Asana")).toBeInTheDocument();
    });

    const filterTrigger = screen.getByLabelText("Filter connectors");
    click(filterTrigger);
    click(menuItemByText("Research Agent"));

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.queryByText("Asana")).not.toBeInTheDocument();
    });
    expect(search()).toContain("connection=agent");
    expect(search()).toContain(agentId);
  });

  it("refreshes agent-filtered connectors when authorizations reload", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000010";
    let enabledTypes = ["github"];
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.data.team([teamAgent(agentId, "Research Agent", "preset:0")]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledTypes: params.id === agentId ? enabledTypes : [],
      });
    });

    detachedSetupPage({
      context,
      path: `/connectors?connection=agent:${agentId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.queryByText("Asana")).not.toBeInTheDocument();
    });

    enabledTypes = ["github", "asana"];
    await context.store.set(reloadAgentConnectorAuthorizations$);

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
      expect(screen.getByText("Asana")).toBeInTheDocument();
    });
  });

  it("hydrates connector search from URL keywords", async () => {
    mockConnectors([
      { type: "github", externalUsername: "octocat" },
      { type: "axiom", authMethod: "api-token" },
    ]);

    detachedSetupPage({ context, path: "/connectors?keywords=logs" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await waitFor(() => {
      expect(searchInput).toHaveValue("logs");
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("shows an empty state when connector search has no matches", async () => {
    mockConnectors([]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "nonexistent-connector-xyz");

    await expect(
      screen.findByText(/No connectors matching/),
    ).resolves.toBeInTheDocument();
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

    await expect(
      screen.findByText(/No connectors matching/),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Connect AWS")).not.toBeInTheDocument();
  });

  it("refreshes connector catalog status when connector feature switches change", async () => {
    mockConnectors([]);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.AwsConnector]: false },
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "aws");

    await expect(
      screen.findByText(/No connectors matching/),
    ).resolves.toBeInTheDocument();

    context.mocks.api(zeroFeatureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.AwsConnector]: true },
        effectiveSwitches: { [FeatureSwitchKey.AwsConnector]: true },
      });
    });
    await context.store.set(
      setFeatureSwitch$,
      { [FeatureSwitchKey.AwsConnector]: true },
      context.signal,
    );

    await expect(
      screen.findByLabelText("Connect AWS"),
    ).resolves.toBeInTheDocument();
  });

  it("manages connector access for agents", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000001";
    const supportAgentId = "c0000000-0000-4000-a000-000000000002";
    const enabledByAgent = new Map<string, string[]>([
      [researchAgentId, ["github"]],
      [supportAgentId, []],
    ]);
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.data.team([
      teamAgent(researchAgentId, "Research Agent"),
      teamAgent(supportAgentId, "Support Agent"),
    ]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledTypes: enabledByAgent.get(params.id) ?? [],
      });
    });
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ params, body, respond }) => {
        const nextEnabledTypes = applyUserConnectorUpdate(
          enabledByAgent.get(params.id) ?? [],
          body,
        );
        enabledByAgent.set(params.id, nextEnabledTypes);
        return respond(200, { enabledTypes: nextEnabledTypes });
      },
    );
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    click(
      within(connectorCardByLabel("GitHub")).getByLabelText(
        "Manage GitHub access",
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Manage GitHub access",
    });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("Revoke GitHub access for Research Agent"),
    ).toBeInTheDocument();

    click(
      within(dialog).getByLabelText(
        "Authorize GitHub access for Support Agent",
      ),
    );

    await waitFor(() => {
      expect(enabledByAgent.get(supportAgentId)).toStrictEqual(["github"]);
      expect(
        within(dialog).getByLabelText("Revoke GitHub access for Support Agent"),
      ).toBeInTheDocument();
    });
  });

  it("ignores stale agents when loading connector access rows", async () => {
    const activeAgentId = "c0000000-0000-4000-a000-000000000001";
    const staleAgentId = "c0000000-0000-4000-a000-000000000002";
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.data.team([
      teamAgent(activeAgentId, "Research Agent"),
      teamAgent(staleAgentId, "Deleted Agent"),
    ]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
      if (params.id === staleAgentId) {
        return respond(404, {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, { enabledTypes: ["github"] });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    click(
      within(connectorCardByLabel("GitHub")).getByLabelText(
        "Manage GitHub access",
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Manage GitHub access",
    });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).queryByText("Deleted Agent")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("Loading agents..."),
    ).not.toBeInTheDocument();
  });

  it("ignores stale authorized agents when loading connector access grants", async () => {
    const activeAgentId = "c0000000-0000-4000-a000-000000000001";
    const staleAgentId = "c0000000-0000-4000-a000-000000000002";
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.data.team([
      teamAgent(activeAgentId, "Research Agent"),
      teamAgent(staleAgentId, "Deleted Agent"),
    ]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: ["github"] });
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.list,
      ({ query, respond }) => {
        if (query.agentId === staleAgentId) {
          return respond(404, {
            error: { message: "Agent not found", code: "NOT_FOUND" },
          });
        }
        return respond(200, []);
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    click(
      within(connectorCardByLabel("GitHub")).getByLabelText(
        "Manage GitHub access",
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Manage GitHub access",
    });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).queryByText("Deleted Agent")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("Loading agents..."),
    ).not.toBeInTheDocument();
  });

  it("shows authorized agent names with an overflow count on connector cards", async () => {
    const agentIds = [
      "c0000000-0000-4000-a000-000000000001",
      "c0000000-0000-4000-a000-000000000002",
      "c0000000-0000-4000-a000-000000000003",
      "c0000000-0000-4000-a000-000000000004",
    ] as const;
    const enabledByAgent = new Map<string, string[]>(
      agentIds.map((agentId) => {
        return [agentId, ["github"]];
      }),
    );

    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.data.team([
      teamAgent(agentIds[0], "Research", "preset:0"),
      teamAgent(agentIds[1], "Support", "preset:1"),
      teamAgent(agentIds[2], "Growth"),
      teamAgent(agentIds[3], "Ops", "preset:3"),
    ]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledTypes: enabledByAgent.get(params.id) ?? [],
      });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      const card = connectorCardByLabel("GitHub");
      const access = within(card).getByLabelText("Manage GitHub access");
      expect(access).toHaveTextContent("Used by");
      expect(access).toHaveTextContent("Research, Support");
      expect(access).toHaveTextContent("+2");
      expect(access).not.toHaveTextContent("Growth");
    });

    click(
      within(connectorCardByLabel("GitHub")).getByLabelText(
        "Manage GitHub access",
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Manage GitHub access",
    });
    expect(dialog).toBeInTheDocument();
  });

  it("shows an add-access affordance when no agents are authorized", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";
    mockConnectors([{ type: "github", externalUsername: "octocat" }]);
    context.mocks.data.team([teamAgent(agentId, "Research Agent", "preset:0")]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: [] });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      const card = connectorCardByLabel("GitHub");
      const empty = within(card).getByTestId("connector-card-access-empty");
      expect(empty).toHaveTextContent("Add access");
    });

    click(
      within(connectorCardByLabel("GitHub")).getByLabelText(
        "Manage GitHub access",
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Manage GitHub access",
    });
    expect(dialog).toBeInTheDocument();
  });

  it("hides permission controls for connectors without firewall rules", async () => {
    const mediaAgentId = "c0000000-0000-4000-a000-000000000003";
    mockConnectors([
      {
        type: "cloudinary",
        authMethod: "api-token",
        externalUsername: "demo-cloud",
      },
    ]);
    context.mocks.data.team([teamAgent(mediaAgentId, "Media Agent")]);
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledTypes: ["cloudinary"],
      });
    });
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      expect(screen.getByText("Cloudinary")).toBeInTheDocument();
    });
    click(
      within(connectorCardByLabel("Cloudinary")).getByLabelText(
        "Manage Cloudinary access",
      ),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Manage Cloudinary access",
    });
    expect(within(dialog).getByText("Media Agent")).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("Revoke Cloudinary access for Media Agent"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Allowed")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("No configurable permissions"),
    ).not.toBeInTheDocument();
    expect(queryButtonByText("Manage", dialog)).not.toBeInTheDocument();
  });

  it("shows Google Maps approval guidance before OAuth", async () => {
    mockConnectors([]);

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await fill(await screen.findByPlaceholderText("Find connectors"), "maps");
    click(await screen.findByLabelText("Connect Google Maps"));

    const dialog = await screen.findByRole("dialog", { name: "Google Maps" });
    expect(
      within(dialog).getByText(/Google will show a security warning/),
    ).toBeInTheDocument();
  });

  it("starts Meta Ads OAuth without review guidance", async () => {
    mockConnectors([]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        return respond(200, {
          authorizationUrl: `https://oauth.test/${params.type}/authorize`,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await fill(await screen.findByPlaceholderText("Find connectors"), "meta");
    click(await screen.findByLabelText("Connect Meta Ads"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/meta-ads/authorize",
      );
    });
    expect(
      screen.queryByText(/Meta Ads is currently in Meta's app review period/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Meta Ads" }),
    ).not.toBeInTheDocument();
  });

  it("ignores duplicate direct OAuth starts while a connector is polling", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "stripe",
        label: "Public Stripe",
        description: "Public Stripe description",
        authMethods: [
          {
            id: "oauth",
            label: "Public OAuth",
            description: null,
            grantKind: "auth-code",
            manualFields: [],
            startOptions: [],
          },
        ],
        singleAuthCodeAuthMethodId: "oauth",
      }),
    ]);
    const authWindow = createMockAuthWindow();
    const openMock = context.mocks.browser.open(authWindow);
    let startCount = 0;
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ params, respond }) => {
        startCount += 1;
        return respond(200, {
          authorizationUrl: `https://oauth.test/${params.type}/authorize`,
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "stripe");
    const connectButton = await screen.findByLabelText("Connect Public Stripe");
    click(connectButton);
    click(connectButton);

    await waitFor(() => {
      expect(startCount).toBe(1);
      expect(openMock.calls).toHaveLength(1);
      expect(authWindow.opener).toBeNull();
      expect(authWindow.location.href).toBe(
        "https://oauth.test/stripe/authorize",
      );
    });
  });

  it("closes an unopened direct OAuth popup when the start request is aborted", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "stripe",
        label: "Public Stripe",
        description: "Public Stripe description",
        authMethods: [
          {
            id: "oauth",
            label: "Public OAuth",
            description: null,
            grantKind: "auth-code",
            manualFields: [],
            startOptions: [],
          },
        ],
        singleAuthCodeAuthMethodId: "oauth",
      }),
    ]);
    const authWindow = createMockAuthWindow();
    const openMock = context.mocks.browser.open(authWindow);
    context.mocks.api(zeroConnectorOauthStartContract.start, ({ never }) => {
      return never();
    });

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "stripe");
    click(await screen.findByLabelText("Connect Public Stripe"));

    await waitFor(() => {
      expect(openMock.calls).toHaveLength(1);
    });

    context.store.set(detachedNavigateTo$, ROUTES.settings);

    await waitFor(() => {
      expect(authWindow.closed).toBeTruthy();
    });
  });

  it("starts Stripe OAuth from the connect dialog", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "stripe",
        label: "Public Stripe",
        description: "Public Stripe description",
        authMethods: [
          {
            id: "oauth",
            label: "Public OAuth",
            description: "Public OAuth description",
            grantKind: "auth-code",
            manualFields: [],
            startOptions: [],
          },
          {
            id: "cli",
            label: "Public CLI",
            description: "Public CLI description",
            grantKind: "device-auth",
            manualFields: [],
            startOptions: [
              {
                id: "mode",
                kind: "select",
                label: "Public Mode",
                required: true,
                defaultValue: "test",
                options: [
                  { value: "test", label: "Test" },
                  { value: "live", label: "Live" },
                ],
              },
            ],
          },
        ],
      }),
    ]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      zeroConnectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.type).toBe("stripe");
        expect(body?.authMethod).toBe("oauth");
        return respond(200, {
          authorizationUrl: "https://oauth.test/stripe/authorize",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: {},
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "public stripe");
    click(await screen.findByLabelText("Connect Public Stripe"));

    const dialog = await screen.findByRole("dialog", {
      name: "Public Stripe",
    });
    expect(within(dialog).getByText("Public OAuth")).toBeInTheDocument();
    expect(within(dialog).getByText("Public CLI")).toBeInTheDocument();
    click(buttonByText("Connect", dialog));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/stripe/authorize",
      );
    });
  });

  it("hides Stripe when public catalog status omits it", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([]);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: {},
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

  it("submits public device-auth start option ids", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "stripe",
        label: "Stripe",
        authMethods: [
          {
            id: "cli",
            label: "Stripe CLI",
            description: "Approve access with Stripe CLI.",
            grantKind: "device-auth",
            manualFields: [],
            startOptions: [
              {
                id: "mode",
                kind: "select",
                label: "Mode",
                required: true,
                defaultValue: "test",
                options: [
                  { value: "test", label: "Test" },
                  { value: "live", label: "Live" },
                ],
              },
            ],
          },
        ],
      }),
    ]);
    let capturedOptions: Record<string, string> | null = null;
    let startCount = 0;
    context.mocks.api(
      zeroConnectorOauthDeviceAuthSessionContract.create,
      ({ body, params, respond }) => {
        startCount += 1;
        expect(params.type).toBe("stripe");
        capturedOptions = body.options ?? null;
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000010",
          sessionToken: "stripe-device-session-token",
          type: "stripe",
          status: "pending",
          userCode: "STRIPE-DEVICE",
          verificationUri: "https://oauth.test/stripe/device",
          verificationUriComplete:
            "https://oauth.test/stripe/device?user_code=STRIPE-DEVICE",
          expiresIn: 300,
          interval: 1,
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "stripe");
    click(await screen.findByLabelText("Connect Stripe"));

    const dialog = await screen.findByRole("dialog", { name: "Stripe" });
    const connectButton = buttonByText("Connect Stripe", dialog);
    click(connectButton);
    click(connectButton);

    await waitFor(() => {
      expect(capturedOptions).toStrictEqual({ mode: "test" });
    });
    expect(startCount).toBe(1);
  });

  it("connects a manual token connector", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "axiom",
        label: "Public Axiom",
        description: "Public Axiom description",
        authMethods: [
          {
            id: "api-token",
            label: "Public API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "Public API token",
                required: true,
                placeholder: "public-xaat",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
    ]);
    let submittedValues: Record<string, string> | null = null;
    let submitCount = 0;
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        submitCount += 1;
        expect(params.type).toBe("axiom");
        submittedValues = body.values;
        return respond(200, {
          id: crypto.randomUUID(),
          type: "axiom",
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Public Axiom")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect Public Axiom"));

    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    expect(
      within(axiomDialog).queryByText(/Settings > API Tokens/u),
    ).not.toBeInTheDocument();
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-test",
    );
    const saveButton = buttonByText("Save", axiomDialog);
    click(saveButton);
    click(saveButton);

    await waitFor(() => {
      expect(submittedValues).toStrictEqual({ apiToken: "xaat-test" });
      expect(submitCount).toBe(1);
      expect(
        within(connectorCardByLabel("Public Axiom")).getByText("Connected"),
      ).toBeInTheDocument();
    });
  });

  it("submits only current public manual grant fields", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "axiom",
        label: "Public Axiom",
        authMethods: [
          {
            id: "api-token",
            label: "Public API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "Public API token",
                required: true,
                placeholder: "public-xaat",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
          {
            id: "api",
            label: "Public API Key",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiKey",
                label: "Public API key",
                required: true,
                placeholder: "public-api-key",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
    ]);
    let submittedAuthMethod: string | null = null;
    let submittedValues: Record<string, string> | null = null;
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, respond }) => {
        submittedAuthMethod = body.authMethod;
        submittedValues = body.values;
        return respond(200, {
          id: crypto.randomUUID(),
          type: "axiom",
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(screen.getByLabelText("Connect Public Axiom")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Connect Public Axiom"));

    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-test",
    );
    await fill(
      within(axiomDialog).getByPlaceholderText("public-api-key"),
      "api-key-test",
    );
    const secondSaveButton = queryAllByRoleFast("button", axiomDialog).filter(
      (button) => {
        return button.textContent?.trim() === "Save";
      },
    )[1];
    if (!secondSaveButton) {
      throw new Error("Second manual grant save button not found");
    }
    click(secondSaveButton);

    await waitFor(() => {
      expect(submittedAuthMethod).toBe("api");
      expect(submittedValues).toStrictEqual({ apiKey: "api-key-test" });
    });
  });

  it("clears post-connect permission selections between connector dialogs", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000001";
    mockConnectors([]);
    context.mocks.data.team([teamAgent(researchAgentId, "Research Agent")]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "axiom",
        label: "Public Axiom",
        authMethods: [
          {
            id: "api-token",
            label: "Public API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "Public API token",
                required: true,
                placeholder: "public-xaat",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
      publicStatusItem({
        connectorRef: "stripe",
        label: "Public Stripe",
        authMethods: [
          {
            id: "api-token",
            label: "Public API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiKey",
                label: "Public API key",
                required: true,
                placeholder: "public-stripe-key",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
    ]);
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        return respond(200, {
          id: crypto.randomUUID(),
          type: params.type,
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );
    let authorizationUpdateCount = 0;
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: [] });
    });
    context.mocks.api(zeroUserConnectorsContract.update, ({ respond }) => {
      authorizationUpdateCount += 1;
      return respond(200, { enabledTypes: [] });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "axiom");
    click(await screen.findByLabelText("Connect Public Axiom"));
    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-test",
    );
    click(buttonByText("Save", axiomDialog));

    const axiomPermissionDialog = dialogForElement(
      await screen.findByText(
        "You've successfully connected with Public Axiom!",
      ),
    );
    click(buttonByText("Research Agent", axiomPermissionDialog));
    click(buttonByText("Later", axiomPermissionDialog));
    await waitFor(() => {
      expect(
        screen.queryByText("You've successfully connected with Public Axiom!"),
      ).not.toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors"), "stripe");
    click(await screen.findByLabelText("Connect Public Stripe"));
    const stripeDialog = await screen.findByRole("dialog", {
      name: "Public Stripe",
    });
    await fill(
      within(stripeDialog).getByPlaceholderText("public-stripe-key"),
      "sk-test",
    );
    click(buttonByText("Save", stripeDialog));

    const stripePermissionDialog = dialogForElement(
      await screen.findByText(
        "You've successfully connected with Public Stripe!",
      ),
    );
    click(buttonByText("Confirm", stripePermissionDialog));

    await waitFor(() => {
      expect(
        screen.queryByText("You've successfully connected with Public Stripe!"),
      ).not.toBeInTheDocument();
    });
    expect(authorizationUpdateCount).toBe(0);
    expect(
      screen.queryByText("Public Stripe enabled for 1 agent"),
    ).not.toBeInTheDocument();
  });

  it("keeps the post-connect permission dialog open when authorization fails", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000001";
    mockConnectors([]);
    context.mocks.data.team([teamAgent(researchAgentId, "Research Agent")]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "axiom",
        label: "Public Axiom",
        authMethods: [
          {
            id: "api-token",
            label: "Public API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "Public API token",
                required: true,
                placeholder: "public-xaat",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
    ]);
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        return respond(200, {
          id: crypto.randomUUID(),
          type: params.type,
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: [] });
    });
    context.mocks.api(zeroUserConnectorsContract.update, ({ respond }) => {
      return respond(400, {
        error: {
          code: "CONNECTOR_ACCESS_UPDATE_FAILED",
          message: "Could not update connector access",
        },
      });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "axiom");
    click(await screen.findByLabelText("Connect Public Axiom"));
    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-test",
    );
    click(buttonByText("Save", axiomDialog));

    const permissionDialog = dialogForElement(
      await screen.findByText(
        "You've successfully connected with Public Axiom!",
      ),
    );
    click(buttonByText("Research Agent", permissionDialog));
    click(buttonByText("Confirm", permissionDialog));

    await waitFor(() => {
      expect(
        screen.getByText("Could not update connector access"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("You've successfully connected with Public Axiom!"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Public Axiom enabled for 1 agent"),
    ).not.toBeInTheDocument();
  });

  it("skips stale agents when confirming the post-connect permission dialog", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000001";
    const staleAgentId = "c0000000-0000-4000-a000-000000000002";
    mockConnectors([]);
    context.mocks.data.team([
      teamAgent(researchAgentId, "Research Agent"),
      teamAgent(staleAgentId, "Deleted Agent"),
    ]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorRef: "axiom",
        label: "Public Axiom",
        authMethods: [
          {
            id: "api-token",
            label: "Public API Token",
            description: null,
            grantKind: "manual",
            manualFields: [
              {
                id: "apiToken",
                label: "Public API token",
                required: true,
                placeholder: "public-xaat",
                inputType: "password",
              },
            ],
            startOptions: [],
          },
        ],
      }),
    ]);
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        return respond(200, {
          id: crypto.randomUUID(),
          type: params.type,
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        });
      },
    );
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: [] });
    });
    const authorizedAgentIds: string[] = [];
    context.mocks.api(
      zeroUserConnectorsContract.update,
      ({ params, respond }) => {
        if (params.id === staleAgentId) {
          return respond(404, {
            error: {
              code: "NOT_FOUND",
              message: "Agent not found",
            },
          });
        }
        authorizedAgentIds.push(params.id);
        return respond(200, { enabledTypes: ["axiom"] });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "axiom");
    click(await screen.findByLabelText("Connect Public Axiom"));
    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-test",
    );
    click(buttonByText("Save", axiomDialog));

    const permissionDialog = dialogForElement(
      await screen.findByText(
        "You've successfully connected with Public Axiom!",
      ),
    );
    click(buttonByText("Research Agent", permissionDialog));
    click(buttonByText("Deleted Agent", permissionDialog));
    click(buttonByText("Confirm", permissionDialog));

    await waitFor(() => {
      expect(
        screen.queryByText("You've successfully connected with Public Axiom!"),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByText("Public Axiom enabled for 1 agent"),
    ).toBeInTheDocument();
    expect(authorizedAgentIds).toStrictEqual([researchAgentId]);
    expect(screen.queryByText("Agent not found")).not.toBeInTheDocument();
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
