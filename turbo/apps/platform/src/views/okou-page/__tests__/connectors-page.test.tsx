import { CLIENT_FORCE_UPGRADE_STATUS } from "@okouai/api-contracts/contracts/client-headers";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
  type AgentCustomConnectorGrants,
  type AgentCustomConnectorUpdate,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  connectorExternalCodeSessionContract,
  connectorOpenIdStartContract,
  connectorOauthStartContract,
  connectorManualGrantContract,
  connectorNoAuthGrantContract,
  connectorOauthDeviceAuthSessionContract,
  connectorScopeDiffContract,
  connectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogCategoryMetadata,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { userPermissionGrantsContract } from "@okouai/api-contracts/contracts/user-permission-grants";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY } from "@okouai/connectors/app-oauth-callback";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { setFeatureSwitch$ } from "../../../signals/external/feature-switch.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";
import { createDeferredPromise, resetSignal } from "../../../signals/utils.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { submitManualGrant$ } from "../../../signals/okou-page/settings/connectors.ts";
import { customConnectorCreateForm$ } from "../../../signals/okou-page/settings/custom-connectors.ts";

const context = testContext();
const resetAfterManualGrantConnectSignal$ = resetSignal();
const { get$: connectorAppOauthCallbackMetadata$ } = localStorageSignals(
  CONNECTOR_APP_OAUTH_CALLBACK_METADATA_STORAGE_KEY,
);

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

function buttonByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

async function waitForButtonByAriaLabel(label: string): Promise<HTMLElement> {
  return await waitFor(() => {
    return buttonByAriaLabel(label);
  });
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

function tabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((candidate) => {
    return candidate.textContent === text;
  });
  if (!tab) {
    throw new Error(`${text} tab not found`);
  }
  return tab;
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

function connectorIconByLabel(label: string): HTMLImageElement {
  const icon = connectorCardByLabel(label).querySelector("img");
  if (!(icon instanceof HTMLImageElement)) {
    throw new Error(`${label} connector icon not found`);
  }
  return icon;
}

function applyUserConnectorUpdate(
  current: readonly string[],
  body: {
    readonly enabledConnectorSlugs: readonly string[];
    readonly operation?: "replace" | "add" | "remove";
  },
): string[] {
  if (body.operation === "add") {
    return Array.from(new Set([...current, ...body.enabledConnectorSlugs]));
  }
  if (body.operation === "remove") {
    return current.filter((connectorSlug) => {
      return !body.enabledConnectorSlugs.includes(connectorSlug);
    });
  }
  return [...body.enabledConnectorSlugs];
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

function listAgent(
  id: string,
  displayName: string,
  avatarUrl: string | null = null,
): AgentResponse {
  return {
    agentId: id,
    ownerId: "test-user-123",
    displayName,
    description: null,
    sound: null,
    avatarUrl,
    modelProviderId: null,
    selectedModel: null,
    preferPersonalProvider: false,
    visibility: "public",
  };
}

function mockConnectors(
  connectors: {
    connectorSlug: ConnectorSlug;
    authMethod?: ConnectorAuthMethodId;
    externalUsername?: string;
    connectionStatus?: ConnectorResponse["connectionStatus"];
    reconnectReason?: ConnectorResponse["reconnectReason"];
    oauthScopes?: string[];
    tokenExpiresAt?: string | null;
  }[],
): ConnectorResponse[] {
  const responses = connectors.map((connector) => {
    return {
      id: crypto.randomUUID(),
      slug: connector.connectorSlug,
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
    } satisfies ConnectorResponse;
  });
  context.mocks.data.connectors(responses);
  return responses;
}

function mockGitHubConnectorAccounts(
  accountCount: number,
): ConnectorAccountConnection[] {
  mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
  const accounts = Array.from({ length: accountCount }, (_, index) => {
    const isDefault = index === 0;
    return {
      id: isDefault
        ? "00000000-0000-4000-a000-000000000001"
        : crypto.randomUUID(),
      target: { kind: "builtin" as const, connectorSlug: "github" },
      authMethod: "oauth",
      displayName: isDefault ? null : `Work ${index}`,
      isDefault,
      externalId: null,
      externalUsername: isDefault ? null : `octocat-${index}`,
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: isDefault
        ? ("reconnect-required" as const)
        : ("connected" as const),
      reconnectReason: isDefault
        ? ("authorization_expired_or_revoked" as const)
        : null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ConnectorAccountConnection;
  }).reverse();
  const defaultAccount = accounts.find((account) => {
    return account.isDefault;
  });
  if (!defaultAccount) {
    throw new Error("Expected a default account fixture");
  }
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: { kind: "builtin", connectorSlug: "github" },
          accountCount: accounts.length,
          attentionCount: 1,
          defaultConnection: defaultAccount,
        },
      ],
    });
  });
  return accounts;
}

async function setupAwsExternalCodeConnection(): Promise<{
  dialog: HTMLElement;
  complete: HTMLElement;
}> {
  mockConnectors([]);
  context.mocks.browser.open(createMockAuthWindow());
  detachedSetupPage({
    context,
    path: "/connectors",
  });

  await fill(await screen.findByPlaceholderText("Find connectors"), "aws");
  click(await screen.findByLabelText("Connect AWS"));
  const dialog = await screen.findByRole("dialog", { name: "AWS" });
  click(buttonByText("Start AWS sign-in", dialog));
  await fill(
    await within(dialog).findByTestId("connector-external-code-input"),
    "INVALID-CODE",
  );
  return {
    dialog,
    complete: within(dialog).getByTestId("connector-external-code-complete"),
  };
}

function customConnector(
  overrides: Partial<CustomConnectorHttpResponse>,
): CustomConnectorHttpResponse {
  return {
    kind: "http",
    id: "33333333-3333-4333-8333-333333333333",
    slug: "acme-search",
    displayName: "Acme Search",
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
    authMode: "manual",
    storageVersion: 1,
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    createdAt: "2026-02-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    ...overrides,
  };
}

function mcpCustomConnector(
  overrides: Partial<CustomConnectorMcpResponse> = {},
): CustomConnectorMcpResponse {
  return {
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    slug: "_acme-mcp",
    displayName: "Acme MCP",
    endpoint: "https://mcp.acme.test/server",
    transport: "streamable-http",
    prefixTemplates: [],
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
    authMode: "manual",
    permissionBundleRef: null,
    storageVersion: 1,
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function publicCustomConnectorOAuthConfig(
  config: NonNullable<CreateCustomConnectorBody["oauthConfig"]>,
) {
  const { clientSecret: _clientSecret, ...publicConfig } = config;
  return publicConfig;
}

function publicStatusItem(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly icon?: PublicConnectorCatalogStatusItem["icon"];
  readonly authMethods: PublicConnectorCatalogStatusItem["authMethods"];
  readonly singleAuthCodeAuthMethodId?: string | null;
  readonly connectNotice?: PublicConnectorCatalogStatusItem["connectNotice"];
}): PublicConnectorCatalogStatusItem {
  return {
    slug: args.connectorSlug,
    label: args.label,
    description: args.description ?? `${args.label} public description`,
    icon: args.icon ?? {
      url: `https://icons.example.test/${args.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
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
  categoryMetadata?: PublicConnectorCatalogCategoryMetadata,
): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, {
      connectors: [...connectors],
      ...(categoryMetadata ? { categoryMetadata } : {}),
    });
  });
}

function mockCustomConnectorStory(): {
  readonly createBodies: readonly CreateCustomConnectorBody[];
  readonly updateBodies: readonly UpdateCustomConnectorBody[];
} {
  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role: "admin",
  });

  let connectors: CustomConnectorHttpResponse[] = [];
  const createBodies: CreateCustomConnectorBody[] = [];
  const updateBodies: UpdateCustomConnectorBody[] = [];

  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    createBodies.push(body);
    const prefixTemplates = body.prefixTemplates ?? [];
    const fields = body.fields ?? [];
    const headerInjections = body.headerInjections ?? [];
    const created = customConnector({
      displayName: body.displayName,
      prefixTemplates,
      fields,
      headerInjections,
      queryInjections: body.queryInjections ?? [],
      authMode: body.authMode ?? "manual",
    });
    connectors = [...connectors, created];
    return respond(201, created);
  });
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ params, body, respond }) => {
      expect(body.account).toStrictEqual({ intent: "single-account" });
      let updated: CustomConnectorHttpResponse | undefined;
      connectors = connectors.map((connector) => {
        if (connector.id !== params.id) {
          return connector;
        }
        updated = {
          ...connector,
          connected: true,
          missingRequiredFields: [],
          configuredFieldKeys: body.values.map((value) => {
            return value.key;
          }),
        };
        return updated;
      });
      if (!updated) {
        throw new Error(`Expected custom connector ${params.id}`);
      }
      return respond(200, updated);
    },
  );
  context.mocks.api(
    connectorAccountsContract.disconnectSingleAccount,
    ({ body, respond }) => {
      if (body.target.kind !== "custom") {
        throw new Error("Expected a custom connector disconnect target");
      }
      const customConnectorId = body.target.customConnectorId;
      connectors = connectors.map((connector) => {
        return connector.id === customConnectorId
          ? {
              ...connector,
              connected: false,
              missingRequiredFields: ["secret"],
              configuredFieldKeys: [],
            }
          : connector;
      });
      return respond(204);
    },
  );
  context.mocks.api(
    customConnectorByIdContract.update,
    ({ params, body, respond }) => {
      updateBodies.push(body);
      if (body.kind === "mcp") {
        throw new Error("Expected an HTTP custom connector update");
      }
      let updated = connectors.find((connector) => {
        return connector.id === params.id;
      });
      connectors = connectors.map((connector) => {
        if (connector.id !== params.id) {
          return connector;
        }
        updated = {
          ...connector,
          displayName: body.displayName,
          prefixTemplates: body.prefixTemplates,
          fields: body.fields,
          headerInjections: body.headerInjections,
          queryInjections: body.queryInjections,
          authMode: body.authMode ?? connector.authMode,
          storageVersion: body.storageVersion ?? connector.storageVersion,
          ...(body.oauthConfig
            ? {
                oauthConfig: publicCustomConnectorOAuthConfig(body.oauthConfig),
              }
            : {}),
        };
        return updated;
      });
      if (!updated) {
        throw new Error(`Expected custom connector ${params.id}`);
      }
      return respond(200, updated);
    },
  );
  context.mocks.api(
    customConnectorByIdContract.delete,
    ({ params, respond }) => {
      connectors = connectors.filter((connector) => {
        return connector.id !== params.id;
      });
      return respond(204);
    },
  );
  return { createBodies, updateBodies };
}

function setupConnectorStatusFilterPage(path = "/connectors"): void {
  mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
  context.mocks.data.agents([
    listAgent("c0000000-0000-4000-a000-000000000020", "Research", "preset:0"),
  ]);
  context.mocks.api(userConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledConnectorSlugs: ["github"] });
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
  it("syncs the active connector tab with the URL query", async () => {
    mockCustomConnectorStory();

    detachedSetupPage({ context, path: "/connectors?tab=custom" });

    await waitFor(() => {
      expect(tabByText("Custom")).toHaveAttribute("aria-selected", "true");
    });
    const customTab = tabByText("Custom");
    expect(new URLSearchParams(search()).get("tab")).toBe("custom");

    click(tabByText("Built-in"));
    await waitFor(() => {
      expect(new URLSearchParams(search()).has("tab")).toBeFalsy();
      expect(tabByText("Built-in")).toHaveAttribute("aria-selected", "true");
    });

    click(customTab);
    await waitFor(() => {
      expect(new URLSearchParams(search()).get("tab")).toBe("custom");
      expect(customTab).toHaveAttribute("aria-selected", "true");
    });
  });

  it("lets users browse connectors by grouped categories", async () => {
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);

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

  it("uses bounded discovery for featured browsing and server search", async () => {
    mockConnectors([]);
    const github = publicStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      authMethods: [],
    });
    const slack = publicStatusItem({
      connectorSlug: "slack",
      label: "Slack",
      authMethods: [],
    });
    const discoveryKeywords: (string | undefined)[] = [];
    let legacyStatusRequests = 0;
    context.mocks.api(
      connectorCatalogContract.discovery,
      ({ query, respond }) => {
        discoveryKeywords.push(query.keyword);
        return respond(200, {
          connectors: query.keyword ? [slack] : [github],
          totalConnectorCount: 1234,
        });
      },
    );
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      legacyStatusRequests += 1;
      return respond(200, { connectors: [github, slack] });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: {
        [FeatureSwitchKey.ConnectorDiscovery]: true,
        [FeatureSwitchKey.ConnectorCatalogCount]: true,
      },
    });

    await expect(
      screen.findByTestId("connector-card-label"),
    ).resolves.toHaveTextContent("GitHub");
    await expect(
      screen.findByText("Connect 1,234 services for your agents to use."),
    ).resolves.toBeInTheDocument();

    await fill(await screen.findByPlaceholderText("Find connectors"), "Slack");
    await waitFor(() => {
      expect(queryConnectorCardByLabel("Slack")).toBeInTheDocument();
      expect(queryConnectorCardByLabel("GitHub")).not.toBeInTheDocument();
    });
    expect(discoveryKeywords).toContain("Slack");
    expect(legacyStatusRequests).toBe(0);
    expect(
      screen.getByText("Connect 1,234 services for your agents to use."),
    ).toBeInTheDocument();
  });

  it("shows the full connector catalog size in the page description", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        authMethods: [],
      }),
      publicStatusItem({
        connectorSlug: "slack",
        label: "Slack",
        authMethods: [],
      }),
    ]);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorCatalogCount]: true },
    });

    await expect(
      screen.findByText("Connect 2 services for your agents to use."),
    ).resolves.toBeInTheDocument();
  });

  it("keeps the catalog description count-free while the count loads", async () => {
    mockConnectors([]);
    let catalogRequestStarted = false;
    let resolveCatalog = (): void => {
      throw new Error("Catalog request did not start");
    };
    context.mocks.api(
      connectorCatalogContract.discovery,
      async ({ deferred, respond }) => {
        const catalogDeferred = deferred<void>();
        resolveCatalog = () => {
          catalogDeferred.resolve();
        };
        catalogRequestStarted = true;
        await catalogDeferred.promise;
        return respond(200, {
          connectors: [],
          totalConnectorCount: 1234,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: {
        [FeatureSwitchKey.ConnectorDiscovery]: true,
        [FeatureSwitchKey.ConnectorCatalogCount]: true,
      },
    });

    await expect(
      screen.findByText("Connect third-party services for your agents to use."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Connect 1,234 services for your agents to use."),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(catalogRequestStarted).toBeTruthy();
    });

    resolveCatalog();

    await expect(
      screen.findByText("Connect 1,234 services for your agents to use."),
    ).resolves.toBeInTheDocument();
  });

  it("keeps the existing catalog description when the count switch is disabled", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        authMethods: [],
      }),
      publicStatusItem({
        connectorSlug: "slack",
        label: "Slack",
        authMethods: [],
      }),
    ]);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorCatalogCount]: false },
    });

    await expect(
      screen.findByText("Connect third-party services for your agents to use."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Connect 2 services for your agents to use."),
    ).not.toBeInTheDocument();
  });

  it("shows only the update dialog when the client requires an upgrade", async () => {
    context.mocks.http.get("*/api/connector-catalog/status", () => {
      return Response.json(
        { error: "Client update required" },
        { status: CLIENT_FORCE_UPGRADE_STATUS },
      );
    });

    detachedSetupPage({ context, path: "/connectors" });

    const dialog = await screen.findByRole("dialog", {
      name: "Update required",
    });
    expect(dialog).toHaveTextContent(
      "This version of VM0 is no longer supported.",
    );
    expect(screen.queryByText("HTTP 426")).not.toBeInTheDocument();
  });

  it("localizes the catalog, reconnect state, and access management in Portuguese", async () => {
    document.documentElement.lang = "pt-BR";
    const researchAgentId = "c0000000-0000-4000-a000-000000000001";
    mockConnectors([
      { connectorSlug: "github", externalUsername: "octocat" },
      {
        connectorSlug: "meta-ads",
        connectionStatus: "reconnect-required",
        reconnectReason: "authorization_expired_or_revoked",
      },
    ]);
    context.mocks.data.agents([listAgent(researchAgentId, "Research Agent")]);
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: ["github"] });
    });
    context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: true },
    });

    await expect(
      screen.findByRole("heading", { name: "Conectores" }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Buscar conectores"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Engenharia e execução da equipe"),
    ).toBeInTheDocument();

    const metaAdsCard = connectorCardByLabel("Meta Ads");
    expect(
      within(metaAdsCard).getByText("A conexão expirou"),
    ).toBeInTheDocument();
    click(within(metaAdsCard).getByLabelText("Mais opções"));
    await waitFor(() => {
      expect(menuItemByText("Reconectar")).toBeInTheDocument();
    });

    click(
      within(connectorCardByLabel("GitHub")).getByLabelText(
        "Gerenciar acesso ao GitHub",
      ),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Gerenciar acesso ao GitHub",
    });
    expect(
      within(dialog).getByText(
        "Escolha quais agentes podem usar este conector.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText(
        "Revogar acesso ao GitHub para Research Agent",
      ),
    ).toBeInTheDocument();
  });

  it("localizes the AI catalog subcategories in Portuguese", async () => {
    document.documentElement.lang = "pt-BR";
    mockConnectors([]);
    mockPublicConnectorStatus(
      [
        publicStatusItem({
          connectorSlug: "openai",
          label: "OpenAI",
          category: "ai-image-video",
          authMethods: [],
        }),
        publicStatusItem({
          connectorSlug: "elevenlabs",
          label: "ElevenLabs",
          category: "ai-voice-audio",
          authMethods: [],
        }),
        publicStatusItem({
          connectorSlug: "langfuse",
          label: "Langfuse",
          category: "ai-memory-tracing-eval",
          authMethods: [],
        }),
        publicStatusItem({
          connectorSlug: "axiom",
          label: "Axiom",
          category: "engineering-team-execution",
          authMethods: [],
        }),
      ],
      {
        categories: [
          {
            id: "ai-image-video",
            label: "Image / Video Generation",
            menuLabel: "Image / Video",
            groupId: "ai",
          },
          {
            id: "ai-voice-audio",
            label: "Voice / Audio",
            menuLabel: "Voice / Audio",
            groupId: "ai",
          },
          {
            id: "ai-memory-tracing-eval",
            label: "Memory / Tracing / Evaluation",
            menuLabel: "Memory / Tracing",
            groupId: "ai",
          },
          {
            id: "engineering-team-execution",
            label: "Engineering / Team Execution",
            menuLabel: "Engineering",
            groupId: null,
          },
        ],
        groups: [{ id: "ai", label: "AI", menuLabel: "AI" }],
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await expect(
      screen.findByRole("heading", {
        name: "Geração de imagens e vídeos",
      }),
    ).resolves.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Voz e áudio" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Memória, rastreamento e avaliação",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("connector-category-menu-ai-image-video"),
    ).toHaveTextContent("Imagens e vídeos");
    expect(
      screen.getByTestId("connector-category-menu-ai-memory-tracing-eval"),
    ).toHaveTextContent("Memória e avaliação");
  });

  it("renders connector icons from server-authored catalog descriptors", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "github",
        label: "GitHub",
        icon: {
          url: "https://icons.example.test/github.svg",
          invertInDarkMode: true,
        },
        authMethods: [],
      }),
      publicStatusItem({
        connectorSlug: "slack",
        label: "Slack",
        icon: {
          url: "https://icons.example.test/slack.svg",
          invertInDarkMode: false,
          scale: 1.5,
        },
        authMethods: [],
      }),
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(queryConnectorCardByLabel("GitHub")).toBeInTheDocument();
      expect(queryConnectorCardByLabel("Slack")).toBeInTheDocument();
    });

    const githubIcon = connectorIconByLabel("GitHub");
    expect(githubIcon).toHaveAttribute(
      "src",
      "https://icons.example.test/github.svg",
    );
    expect(githubIcon).toHaveClass("zero-icon-mono");

    const slackIcon = connectorIconByLabel("Slack");
    expect(slackIcon).toHaveAttribute(
      "src",
      "https://icons.example.test/slack.svg",
    );
    expect(slackIcon).not.toHaveClass("zero-icon-mono");
    expect(slackIcon).toHaveStyle({ transform: "scale(1.5)" });
    expect(slackIcon.closest(".overflow-hidden")).toBeInTheDocument();
  });

  it("renders server-authored connector categories unknown to the browser", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus(
      [
        publicStatusItem({
          connectorSlug: "github",
          label: "Public GitHub",
          category: "partner-apps",
          authMethods: [
            {
              id: "oauth",
              label: "OAuth",
              description: null,
              grantKind: "auth-code",
              manualFields: [],
              startOptions: [],
            },
          ],
        }),
        publicStatusItem({
          connectorSlug: "stripe",
          label: "Public Stripe",
          category: "billing-apps",
          authMethods: [
            {
              id: "api-token",
              label: "API token",
              description: null,
              grantKind: "manual",
              manualFields: [],
              startOptions: [],
            },
          ],
        }),
      ],
      {
        categories: [
          {
            id: "partner-apps",
            label: "Partner Apps",
            menuLabel: "Partners",
            groupId: null,
          },
          {
            id: "billing-apps",
            label: "Billing Apps",
            menuLabel: "Billing",
            groupId: null,
          },
        ],
        groups: [],
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    const partnerSection = await screen.findByTestId(
      "connector-category-partner-apps",
    );
    expect(
      within(partnerSection).getByText("Partner Apps"),
    ).toBeInTheDocument();
    expect(queryConnectorCardByLabel("Public GitHub")).toBeInTheDocument();
    expect(
      screen.getByTestId("connector-category-menu-partner-apps"),
    ).toHaveTextContent("Partners");
  });

  it("does not render duplicate connector sections for duplicate category metadata", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus(
      [
        publicStatusItem({
          connectorSlug: "github",
          label: "Duplicate GitHub",
          category: "partner-apps",
          authMethods: [
            {
              id: "oauth",
              label: "OAuth",
              description: null,
              grantKind: "auth-code",
              manualFields: [],
              startOptions: [],
            },
          ],
        }),
      ],
      {
        categories: [
          {
            id: "partner-apps",
            label: "Partner Apps",
            menuLabel: "Partners",
            groupId: null,
          },
          {
            id: "partner-apps",
            label: "Duplicate Partner Apps",
            menuLabel: "Duplicate Partners",
            groupId: null,
          },
        ],
        groups: [],
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    const partnerSection = await screen.findByTestId(
      "connector-category-partner-apps",
    );
    expect(
      within(partnerSection).getByText("Partner Apps"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Duplicate Partner Apps"),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByTestId("connector-card-label").filter((element) => {
        return element.textContent === "Duplicate GitHub";
      }),
    ).toHaveLength(1);
  });

  it("keeps category section ids unique when a metadata group id collides with a category", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus(
      [
        publicStatusItem({
          connectorSlug: "github",
          label: "Partner GitHub",
          category: "partner-apps",
          authMethods: [
            {
              id: "oauth",
              label: "OAuth",
              description: null,
              grantKind: "auth-code",
              manualFields: [],
              startOptions: [],
            },
          ],
        }),
        publicStatusItem({
          connectorSlug: "stripe",
          label: "Billing Stripe",
          category: "billing-apps",
          authMethods: [
            {
              id: "api-token",
              label: "API token",
              description: null,
              grantKind: "manual",
              manualFields: [],
              startOptions: [],
            },
          ],
        }),
      ],
      {
        categories: [
          {
            id: "partner-apps",
            label: "Partner Apps",
            menuLabel: "Partners",
            groupId: null,
          },
          {
            id: "billing-apps",
            label: "Billing Apps",
            menuLabel: "Billing",
            groupId: "partner-apps",
          },
        ],
        groups: [
          {
            id: "partner-apps",
            label: "Partner Group",
            menuLabel: "Partner Group",
          },
        ],
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await screen.findByTestId("connector-category-partner-apps");
    expect(
      screen.getAllByTestId("connector-category-partner-apps"),
    ).toHaveLength(1);
    expect(
      screen.getAllByTestId("connector-category-billing-apps"),
    ).toHaveLength(1);
    expect(queryConnectorCardByLabel("Partner GitHub")).toBeInTheDocument();
    expect(queryConnectorCardByLabel("Billing Stripe")).toBeInTheDocument();
  });

  it("keeps connectors visible when category metadata is missing during rollout", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "github",
        label: "Fallback GitHub",
        category: "legacy-category",
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: null,
            grantKind: "auth-code",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    const fallbackSection = await screen.findByTestId(
      "connector-category-legacy-category",
    );
    expect(
      within(fallbackSection).getByText("Legacy Category"),
    ).toBeInTheDocument();
    expect(queryConnectorCardByLabel("Fallback GitHub")).toBeInTheDocument();
  });

  it("does not show reconnect reason help on the connection expired badge", async () => {
    mockConnectors([
      {
        connectorSlug: "github",
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

  it("omits standalone instructions from reconnect progress", async () => {
    mockConnectors([
      {
        connectorSlug: "meta-ads",
        connectionStatus: "reconnect-required",
      },
    ]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.browser.standaloneDisplayMode(true);
    context.mocks.api(
      connectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("meta-ads");
        expect(body.account).toStrictEqual({ intent: "single-account" });
        expect(body.callbackTarget).toBe("app");
        return respond(200, {
          authorizationUrl: "https://oauth.test/meta-ads/authorize",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: true },
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
    expect(
      within(connectorCardByLabel("Meta Ads")).getByText("Connecting…"),
    ).toBeInTheDocument();
    expect(
      within(connectorCardByLabel("Meta Ads")).queryByText(
        "Switch back here after completing sign-in.",
      ),
    ).not.toBeInTheDocument();
  });

  it("disconnects a connected catalog connector from the options menu", async () => {
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    const disconnectTargets: unknown[] = [];
    context.mocks.api(
      connectorAccountsContract.disconnectSingleAccount,
      ({ body, respond }) => {
        disconnectTargets.push(body.target);
        context.mocks.data.connectors([]);
        return respond(204);
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: false },
    });

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("GitHub")).getByLabelText("More options"),
      ).toBeInTheDocument();
    });

    click(
      within(connectorCardByLabel("GitHub")).getByLabelText("More options"),
    );
    click(menuItemByText("Disconnect"));

    await waitFor(() => {
      expect(screen.getByLabelText("Connect GitHub")).toBeInTheDocument();
    });
    expect(disconnectTargets).toStrictEqual([
      { kind: "builtin", connectorSlug: "github" },
    ]);
  });

  it("distinguishes unavailable account summaries from no accounts", async () => {
    mockConnectors([]);
    const connector = customConnector({});
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    let summariesRequestStarted = false;
    let resolveSummaries = (): void => {
      throw new Error("Account summaries request did not start");
    };
    context.mocks.api(
      connectorAccountsContract.summaries,
      async ({ deferred, respond }) => {
        const summariesDeferred = deferred<void>();
        resolveSummaries = () => {
          summariesDeferred.resolve();
        };
        summariesRequestStarted = true;
        await summariesDeferred.promise;
        return respond(404, {
          error: {
            message: "Account summaries unavailable",
            code: "NOT_FOUND",
          },
        });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await waitFor(() => {
      expect(summariesRequestStarted).toBeTruthy();
      const card = connectorCardByLabel("Ahrefs");
      expect(within(card).getByText("Loading accounts…")).toBeInTheDocument();
      expect(within(card).queryByText("No accounts")).toBeNull();
    });

    resolveSummaries();

    await waitFor(() => {
      const card = connectorCardByLabel("Ahrefs");
      expect(
        within(card).getByText("Accounts are unavailable for this connector."),
      ).toBeInTheDocument();
      expect(within(card).queryByText("No accounts")).toBeNull();
    });

    click(tabByText("Custom"));

    await waitFor(() => {
      const card = connectorCardByLabel(connector.displayName);
      expect(
        within(card).getByText("Accounts are unavailable for this connector."),
      ).toBeInTheDocument();
      expect(within(card).queryByText("No accounts")).toBeNull();
    });
  });

  it("shows the connector description when there are no accounts or agent access", async () => {
    mockConnectors([]);
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, { summaries: [] });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await waitFor(() => {
      const card = connectorCardByLabel("GitHub");
      expect(within(card).getByTestId("connector-help-text")).toHaveTextContent(
        "Connect your GitHub account to access repositories and GitHub features.",
      );
      expect(within(card).queryByText("No accounts")).toBeNull();
      expect(
        within(card).queryByTestId("connector-card-agent-access"),
      ).toBeNull();
    });
  });

  it("shows an account identity while agent access is unavailable", async () => {
    const [connector] = mockConnectors([
      { connectorSlug: "github", externalUsername: "work" },
    ]);
    if (!connector) {
      throw new Error("Expected GitHub fixture connector");
    }
    const account = {
      id: connector.id,
      target: { kind: "builtin" as const, connectorSlug: "github" },
      authMethod: connector.authMethod,
      displayName: "Work",
      isDefault: true,
      externalId: null,
      externalUsername: "work",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "reconnect-required" as const,
      reconnectReason: "authorization_expired_or_revoked" as const,
      tokenExpiresAt: null,
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
    } satisfies ConnectorAccountConnection;
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: account.target,
            accountCount: 2,
            attentionCount: 1,
            defaultConnection: account,
          },
        ],
      });
    });
    context.mocks.data.agents([
      listAgent("c0000000-0000-4000-a000-000000000001", "Research"),
    ]);
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(500, {
        error: { message: "Agent access unavailable", code: "UNAVAILABLE" },
      });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await waitFor(() => {
      const card = connectorCardByLabel("GitHub");
      expect(within(card).getByText("1/2 need attention")).toBeInTheDocument();
      expect(within(card).getByText("Access unavailable")).toBeInTheDocument();
      expect(
        within(card).getByLabelText("Manage GitHub access"),
      ).toBeDisabled();
    });
  });

  it("shows when every connector account needs attention", async () => {
    const [connector] = mockConnectors([
      { connectorSlug: "github", externalUsername: "work" },
    ]);
    if (!connector) {
      throw new Error("Expected GitHub fixture connector");
    }
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: { kind: "builtin", connectorSlug: "github" },
            accountCount: 2,
            attentionCount: 2,
            defaultConnection: null,
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await waitFor(() => {
      expect(
        within(connectorCardByLabel("GitHub")).getByText("2/2 need attention"),
      ).toBeInTheDocument();
    });
  });

  it("shows the connector description after the last account is removed", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000001";
    mockConnectors([]);
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, { summaries: [] });
    });
    context.mocks.data.agents([listAgent(researchAgentId, "Research")]);
    context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: params.id === researchAgentId ? ["github"] : [],
      });
    });
    context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await waitFor(() => {
      const githubCard = connectorCardByLabel("GitHub");
      expect(
        within(githubCard).getByTestId("connector-help-text"),
      ).toHaveTextContent(
        "Connect your GitHub account to access repositories and GitHub features.",
      );
      expect(within(githubCard).queryByText("No accounts")).toBeNull();
      expect(
        within(githubCard).queryByTestId("connector-card-agent-access"),
      ).toBeNull();
    });
  });

  it("names the exact account after a feature-on manual account addition", async () => {
    mockConnectors([]);
    const connectionId = crypto.randomUUID();
    let submittedAccount: unknown;
    let submittedAuthorizeAgent: true | undefined;
    let renamedConnectionId: string | undefined;
    let renamedDisplayName: string | null | undefined;
    context.mocks.api(
      connectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        submittedAccount = body.account;
        submittedAuthorizeAgent = body.authorizeAgent;
        const connector: ConnectorResponse = {
          id: connectionId,
          slug: params.connectorSlug,
          authMethod: body.authMethod,
          externalId: "provider-account-id",
          externalUsername: "provider-user",
          externalEmail: "owner@example.com",
          oauthScopes: null,
          connectionStatus: "connected" as const,
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        };
        context.mocks.data.connectors([connector]);
        return respond(200, connector);
      },
    );
    context.mocks.api(
      connectorAccountsContract.rename,
      ({ body, params, respond }) => {
        renamedConnectionId = params.connectionId;
        renamedDisplayName = body.displayName;
        return respond(200, {
          id: connectionId,
          target: { kind: "builtin", connectorSlug: "ahrefs" },
          authMethod: "api-token",
          displayName: body.displayName,
          isDefault: true,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: [],
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:02.000Z",
        });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await screen.findByLabelText("Connect Ahrefs"));

    const dialog = await screen.findByRole("dialog", { name: "Ahrefs" });
    await fill(
      within(dialog).getByPlaceholderText("your-ahrefs-api-token"),
      "secret-token",
    );
    expect(buttonByText("Save", dialog)).toBeEnabled();
    click(buttonByText("Save", dialog));

    const nameDialog = await screen.findByRole("dialog", {
      name: "Name your Ahrefs account",
    });
    const nameInput = within(nameDialog).getByLabelText("Account name");
    expect(nameInput).toHaveValue("");
    expect(nameInput).toHaveAttribute("placeholder", "owner@example.com");
    await fill(nameInput, "Work");
    click(buttonByText("Save", nameDialog));
    await waitFor(() => {
      expect(renamedConnectionId).toBe(connectionId);
      expect(renamedDisplayName).toBe("Work");
    });
    expect(submittedAccount).toStrictEqual({ intent: "add" });
    expect(submittedAuthorizeAgent).toBeUndefined();
  });

  it("opens feature-on account and access managers independently", async () => {
    const accounts = mockGitHubConnectorAccounts(7);
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, { connections: accounts, nextCursor: null });
    });
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await waitFor(() => {
      expect(connectorCardByLabel("GitHub")).toHaveTextContent(
        "1/7 need attention",
      );
    });
    const manageAccounts = await waitForButtonByAriaLabel(
      "Manage GitHub accounts",
    );
    const manageAccess = within(connectorCardByLabel("GitHub")).getByLabelText(
      "Manage GitHub access",
    );
    expect(manageAccounts.tagName).toBe("BUTTON");
    expect(manageAccounts.querySelector("button")).toBeNull();
    expect(manageAccounts).not.toContainElement(manageAccess);
    click(manageAccess);
    const accessDialog = await screen.findByRole("dialog", {
      name: "Manage GitHub access",
    });
    expect(screen.queryByRole("dialog", { name: "GitHub" })).toBeNull();
    click(within(accessDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Manage GitHub access" }),
      ).toBeNull();
    });
    click(manageAccounts);

    const dialog = await screen.findByRole("dialog", { name: "GitHub" });
    const defaultGroup = within(dialog).getByRole("group", {
      name: "Default",
    });
    expect(
      within(defaultGroup).getByText("Account #00000000"),
    ).toBeInTheDocument();
    expect(
      within(defaultGroup).getByText("Reconnect required"),
    ).toBeInTheDocument();
    expect(
      within(defaultGroup).getByLabelText("Account actions"),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText("Account #00000000")).toHaveLength(1);
  });

  it("paginates a feature-on account manager", async () => {
    const accounts = mockGitHubConnectorAccounts(101);
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        const start = query.cursor ? Number(query.cursor) : 0;
        const page = accounts.slice(start, start + query.limit);
        const next = start + page.length;
        return respond(200, {
          connections: page,
          nextCursor: next < accounts.length ? String(next) : null,
        });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    const dialog = await screen.findByRole("dialog", { name: "GitHub" });
    expect(within(dialog).queryByText("Work 50")).toBeNull();
    click(buttonByText("Load more", dialog));
    await waitFor(() => {
      expect(within(dialog).getByText("Work 50")).toBeInTheDocument();
    });
    click(buttonByText("Load more", dialog));
    await waitFor(() => {
      expect(queryButtonByText("Load more", dialog)).toBeNull();
      expect(within(dialog).getByText("Work 1")).toBeInTheDocument();
      expect(within(dialog).getAllByText("Account #00000000")).toHaveLength(1);
    });
  });

  it("debounces feature-on account manager searches", async () => {
    const accounts = mockGitHubConnectorAccounts(7);
    const accountQueries: {
      readonly search: string | null;
      readonly cursor: string | null;
    }[] = [];
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        accountQueries.push({
          search: query.search ?? null,
          cursor: query.cursor ?? null,
        });
        const search = query.search;
        const filtered = search
          ? accounts.filter((account) => {
              return account.displayName
                ?.toLowerCase()
                .includes(search.toLowerCase());
            })
          : accounts;
        return respond(200, { connections: filtered, nextCursor: null });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    const dialog = await screen.findByRole("dialog", { name: "GitHub" });
    const searchInput = within(dialog).getByPlaceholderText("Find accounts");
    const queryCountBeforeSearch = accountQueries.length;
    fireEvent.input(searchInput, { target: { value: "W" } });
    fireEvent.input(searchInput, { target: { value: "Work" } });
    fireEvent.input(searchInput, { target: { value: "Work 2" } });
    expect(searchInput).toHaveValue("Work 2");
    expect(accountQueries).toHaveLength(queryCountBeforeSearch);
    await waitFor(() => {
      expect(accountQueries.slice(queryCountBeforeSearch)).toStrictEqual([
        { search: "Work 2", cursor: null },
      ]);
      expect(within(dialog).getByText("Work 2")).toBeInTheDocument();
      expect(within(dialog).getAllByText("Account #00000000")).toHaveLength(1);
    });

    fireEvent.input(searchInput, {
      target: { value: "No matching account" },
    });
    await waitFor(() => {
      expect(accountQueries.at(-1)).toStrictEqual({
        search: "No matching account",
        cursor: null,
      });
      expect(within(dialog).getByText("No accounts found")).toBeInTheDocument();
      expect(within(dialog).getAllByText("Account #00000000")).toHaveLength(1);
    });
  });

  it("cancels stale feature-on account manager searches", async () => {
    const accounts = mockGitHubConnectorAccounts(7);
    const defaultAccount = accounts.find((account) => {
      return account.isDefault;
    });
    if (!defaultAccount) {
      throw new Error("Expected a default account fixture");
    }
    const staleAccount: ConnectorAccountConnection = {
      ...defaultAccount,
      id: crypto.randomUUID(),
      displayName: "Stale result",
      isDefault: false,
    };
    const accountQueries: {
      readonly search: string | null;
      readonly cursor: string | null;
    }[] = [];
    const heldSearchRequest: {
      signal: AbortSignal | null;
      release: (() => void) | null;
      completed: boolean;
    } = { signal: null, release: null, completed: false };
    context.mocks.api(
      connectorAccountsContract.connections,
      async ({ query, request, respond }) => {
        accountQueries.push({
          search: query.search ?? null,
          cursor: query.cursor ?? null,
        });
        if (query.search === "Stale") {
          const heldSearch = createDeferredPromise<void>(context.signal);
          heldSearchRequest.signal = request.signal;
          heldSearchRequest.release = () => {
            heldSearch.resolve();
          };
          await heldSearch.promise;
          heldSearchRequest.completed = true;
          return respond(200, {
            connections: [staleAccount],
            nextCursor: null,
          });
        }
        return respond(200, { connections: accounts, nextCursor: null });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    const dialog = await screen.findByRole("dialog", { name: "GitHub" });
    const searchInput = within(dialog).getByPlaceholderText("Find accounts");
    fireEvent.input(searchInput, { target: { value: "Stale" } });
    await waitFor(() => {
      expect(heldSearchRequest.signal).not.toBeNull();
    });
    fireEvent.input(searchInput, { target: { value: "" } });
    expect(searchInput).toHaveValue("");
    expect(heldSearchRequest.signal?.aborted).toBeTruthy();
    await waitFor(() => {
      expect(accountQueries.at(-1)).toStrictEqual({
        search: null,
        cursor: null,
      });
    });
    const releaseHeldSearch = heldSearchRequest.release;
    if (!releaseHeldSearch) {
      throw new Error("Expected held account search request");
    }
    releaseHeldSearch();
    await waitFor(() => {
      expect(heldSearchRequest.completed).toBeTruthy();
      expect(within(dialog).getByText("Work 1")).toBeInTheDocument();
      expect(within(dialog).queryByText("Stale result")).toBeNull();
    });
  });

  it("sets an exact non-default account as the target default", async () => {
    const [connector] = mockConnectors([
      { connectorSlug: "github", externalUsername: "work" },
    ]);
    if (!connector) {
      throw new Error("Expected GitHub fixture connector");
    }
    const baseAccount = {
      id: connector.id,
      target: { kind: "builtin" as const, connectorSlug: "github" },
      authMethod: connector.authMethod,
      displayName: "Work",
      isDefault: true,
      externalId: null,
      externalUsername: "work",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
    } satisfies ConnectorAccountConnection;
    const personalAccount: ConnectorAccountConnection = {
      ...baseAccount,
      id: crypto.randomUUID(),
      displayName: "Personal",
      isDefault: false,
      externalUsername: "personal",
    };
    let defaultConnectionId = baseAccount.id;
    const accounts = () => {
      return [baseAccount, personalAccount].map((account) => {
        return { ...account, isDefault: account.id === defaultConnectionId };
      });
    };
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      const defaultConnection = accounts().find((account) => {
        return account.isDefault;
      });
      if (!defaultConnection) {
        throw new Error("Expected one default account");
      }
      return respond(200, {
        summaries: [
          {
            target: baseAccount.target,
            accountCount: 2,
            attentionCount: 0,
            defaultConnection,
          },
        ],
      });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, { connections: accounts(), nextCursor: null });
    });
    context.mocks.api(
      connectorAccountsContract.setDefault,
      ({ params, respond }) => {
        defaultConnectionId = params.connectionId;
        const updated = accounts().find((account) => {
          return account.id === params.connectionId;
        });
        if (!updated) {
          return respond(404, {
            error: { message: "Account not found", code: "NOT_FOUND" },
          });
        }
        return respond(200, updated);
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    const manager = await screen.findByRole("dialog", {
      name: "GitHub",
    });
    expect(
      within(within(manager).getByRole("group", { name: "Default" })).getByText(
        "Work",
      ),
    ).toBeInTheDocument();
    expect(within(manager).queryByPlaceholderText("Find accounts")).toBeNull();
    const actions = within(manager).getAllByLabelText("Account actions");
    const personalActions = actions.at(1);
    if (!personalActions) {
      throw new Error("Expected Personal account actions");
    }
    click(personalActions);
    click(menuItemByText("Make default"));

    await waitFor(() => {
      expect(defaultConnectionId).toBe(personalAccount.id);
      expect(connectorCardByLabel("GitHub")).toHaveTextContent("2 accounts");
      const defaultGroup = within(manager).getByRole("group", {
        name: "Default",
      });
      expect(within(defaultGroup).getByText("Personal")).toBeInTheDocument();
      expect(within(manager).getAllByText("Personal")).toHaveLength(1);
      expect(within(manager).getAllByText("Work")).toHaveLength(1);
    });
  });

  it("disables account additions when the active target becomes unavailable", async () => {
    const [connector] = mockConnectors([
      { connectorSlug: "github", externalUsername: "work" },
    ]);
    if (!connector) {
      throw new Error("Expected GitHub fixture connector");
    }
    const account = {
      id: connector.id,
      target: { kind: "builtin" as const, connectorSlug: "github" },
      authMethod: connector.authMethod,
      displayName: "Work",
      isDefault: true,
      externalId: null,
      externalUsername: "work",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
    } satisfies ConnectorAccountConnection;
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: account.target,
            accountCount: 1,
            attentionCount: 0,
            defaultConnection: account,
          },
        ],
      });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(404, {
        error: { message: "Target unavailable", code: "NOT_FOUND" },
      });
    });
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    const manager = await screen.findByRole("dialog", {
      name: "GitHub",
    });
    await expect(
      within(manager).findByText(
        "Accounts are unavailable for this connector.",
      ),
    ).resolves.toBeInTheDocument();
    expect(buttonByText("Add account", manager)).toBeDisabled();
    expect(
      within(manager).queryByRole("group", { name: "Default" }),
    ).toBeNull();
  });

  it("does not restore a pending deletion draft after the manager closes", async () => {
    const [connector] = mockConnectors([
      { connectorSlug: "github", externalUsername: "octocat" },
    ]);
    if (!connector) {
      throw new Error("Expected GitHub fixture connector");
    }
    const account = {
      id: connector.id,
      target: { kind: "builtin" as const, connectorSlug: "github" },
      authMethod: connector.authMethod,
      displayName: "Work",
      isDefault: true,
      externalId: null,
      externalUsername: "octocat",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
    } satisfies ConnectorAccountConnection;
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: account.target,
            accountCount: 1,
            attentionCount: 0,
            defaultConnection: account,
          },
        ],
      });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, { connections: [account], nextCursor: null });
    });
    let impactStarted = false;
    let resolveImpact = (): void => {
      throw new Error("Deletion impact request did not start");
    };
    context.mocks.api(
      connectorAccountsContract.deletionImpact,
      async ({ deferred, params, respond }) => {
        const pending = deferred<void>();
        resolveImpact = () => {
          pending.resolve();
        };
        impactStarted = true;
        await pending.promise;
        return respond(200, {
          connectionId: params.connectionId,
          explicitSelectionCount: 1,
          hasSibling: false,
        });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    const firstManager = await screen.findByRole("dialog", {
      name: "GitHub",
    });
    click(within(firstManager).getByLabelText("Account actions"));
    click(menuItemByText("Delete"));
    await waitFor(() => {
      expect(impactStarted).toBeTruthy();
    });
    click(within(firstManager).getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "GitHub" })).toBeNull();
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    await screen.findByRole("dialog", {
      name: "GitHub",
    });
    resolveImpact();
    await waitFor(() => {
      expect(screen.queryByText("Delete Work?")).toBeNull();
    });
  });

  it("renames and deletes an exact account after bounded impact", async () => {
    const [connector] = mockConnectors([
      { connectorSlug: "github", externalUsername: "octocat" },
    ]);
    if (!connector) {
      throw new Error("Expected GitHub fixture connector");
    }
    let account: ConnectorAccountConnection | null = {
      id: connector.id,
      target: { kind: "builtin", connectorSlug: "github" },
      authMethod: connector.authMethod,
      displayName: "Work",
      isDefault: true,
      externalId: null,
      externalUsername: "octocat",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: connector.createdAt,
      updatedAt: connector.updatedAt,
    };
    const renamedDisplayNames: (string | null)[] = [];
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: account
          ? [
              {
                target: account.target,
                accountCount: 1,
                attentionCount: 0,
                defaultConnection: account,
              },
            ]
          : [],
      });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, {
        connections: account ? [account] : [],
        nextCursor: null,
      });
    });
    context.mocks.api(
      connectorAccountsContract.rename,
      ({ params, body, respond }) => {
        if (!account || params.connectionId !== account.id) {
          return respond(404, {
            error: { message: "Account not found", code: "NOT_FOUND" },
          });
        }
        renamedDisplayNames.push(body.displayName);
        account = { ...account, displayName: body.displayName };
        return respond(200, account);
      },
    );
    context.mocks.api(
      connectorAccountsContract.deletionImpact,
      ({ params, respond }) => {
        return respond(200, {
          connectionId: params.connectionId,
          explicitSelectionCount: 2,
          hasSibling: false,
        });
      },
    );
    context.mocks.api(
      connectorAccountsContract.delete,
      ({ params, respond }) => {
        account = null;
        context.mocks.data.connectors([]);
        return respond(200, {
          deletedConnectionId: params.connectionId,
          resolvedSelectionCount: 2,
          promotedDefaultConnectionId: null,
        });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage GitHub accounts"));
    const dialog = await screen.findByRole("dialog", {
      name: "GitHub",
    });
    click(within(dialog).getByLabelText("Account actions"));
    click(menuItemByText("Rename"));
    await fill(within(dialog).getByLabelText("Account name"), "Personal");
    click(buttonByText("Save", dialog));
    await waitFor(() => {
      expect(within(dialog).getByText("Personal")).toBeInTheDocument();
    });
    click(within(dialog).getByLabelText("Account actions"));
    click(menuItemByText("Rename"));
    await fill(within(dialog).getByLabelText("Account name"), " ");
    expect(buttonByText("Save", dialog)).toBeEnabled();
    click(buttonByText("Save", dialog));
    await waitFor(() => {
      expect(renamedDisplayNames).toStrictEqual(["Personal", null]);
      expect(within(dialog).getAllByText("octocat")).toHaveLength(1);
    });
    click(within(dialog).getByLabelText("Account actions"));
    click(menuItemByText("Delete"));
    const deleteDialog = await screen.findByRole("dialog", {
      name: "Delete octocat?",
    });
    expect(
      within(deleteDialog).getByText(
        "2 threads will return to default inheritance.",
      ),
    ).toBeInTheDocument();
    click(buttonByText("Delete account", deleteDialog));
    await waitFor(() => {
      expect(screen.getByLabelText("Connect GitHub")).toBeInTheDocument();
    });
  });

  it("confirms a non-default OAuth reconnect independently of the default projection", async () => {
    const [defaultConnector] = mockConnectors([
      {
        connectorSlug: "stripe",
        authMethod: "api-token",
        externalUsername: "work",
      },
    ]);
    if (!defaultConnector) {
      throw new Error("Expected Stripe fixture connector");
    }
    const defaultAccount = {
      id: defaultConnector.id,
      target: { kind: "builtin" as const, connectorSlug: "stripe" },
      authMethod: "api-token",
      displayName: "Work",
      isDefault: true,
      externalId: null,
      externalUsername: "work",
      externalEmail: null,
      oauthScopes: [],
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ConnectorAccountConnection;
    let personalAccount: ConnectorAccountConnection = {
      ...defaultAccount,
      id: crypto.randomUUID(),
      authMethod: "oauth",
      displayName: "Personal",
      isDefault: false,
      externalUsername: "personal",
      connectionStatus: "reconnect-required" as const,
      reconnectReason: "authorization_expired_or_revoked" as const,
    };
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: defaultAccount.target,
            accountCount: 2,
            attentionCount:
              personalAccount.connectionStatus === "reconnect-required" ? 1 : 0,
            defaultConnection: defaultAccount,
          },
        ],
      });
    });
    let exactReadCount = 0;
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, respond }) => {
        exactReadCount += 1;
        if (params.connectionId !== personalAccount.id) {
          return respond(404, {
            error: { message: "Account not found", code: "NOT_FOUND" },
          });
        }
        return respond(200, personalAccount);
      },
    );
    let accountListRequestCount = 0;
    context.mocks.api(
      connectorAccountsContract.connections,
      ({ query, respond }) => {
        accountListRequestCount += 1;
        expect(query).toMatchObject({
          kind: "builtin",
          connectorSlug: "stripe",
        });
        return respond(200, {
          connections: [defaultAccount, personalAccount],
          nextCursor: null,
        });
      },
    );
    let submittedAccount: unknown;
    context.mocks.api(
      connectorOauthStartContract.start,
      ({ body, respond }) => {
        submittedAccount = body.account;
        return respond(200, {
          authorizationUrl: "https://oauth.test/stripe/authorize",
        });
      },
    );
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await waitForButtonByAriaLabel("Manage Stripe accounts"));
    const manager = await screen.findByRole("dialog", {
      name: "Stripe",
    });
    const actions = await waitFor(() => {
      expect(accountListRequestCount).toBeGreaterThan(0);
      return within(manager).getAllByLabelText("Account actions");
    });
    const personalActions = actions.at(1);
    if (!personalActions) {
      throw new Error("Expected Personal account actions");
    }
    click(personalActions);
    click(menuItemByText("Reconnect"));

    const connectDialog = await screen.findByRole("dialog", {
      name: "Stripe",
    });
    click(buttonByText("Reconnect", connectDialog));
    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/stripe/authorize",
      );
      expect(
        context.mocks.ably.hasSubscription("connector:changed"),
      ).toBeTruthy();
    });
    personalAccount = {
      ...personalAccount,
      connectionStatus: "connected",
      reconnectReason: null,
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    context.mocks.ably.trigger("connector:changed", {
      connectorSlug: "stripe",
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Stripe" })).toBeNull();
    });
    expect(
      screen.queryByRole("dialog", {
        name: "Name your Stripe account",
      }),
    ).toBeNull();
    expect(submittedAccount).toStrictEqual({
      intent: "reconnect",
      connectionId: personalAccount.id,
    });
    expect(exactReadCount).toBeGreaterThanOrEqual(2);
  });

  it("keeps a connector connected when compact disconnect is ambiguous", async () => {
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    let disconnectCount = 0;
    context.mocks.api(
      connectorAccountsContract.disconnectSingleAccount,
      ({ body, respond }) => {
        disconnectCount += 1;
        expect(body.target).toStrictEqual({
          kind: "builtin",
          connectorSlug: "github",
        });
        return respond(409, {
          error: {
            code: "CONFLICT",
            message: "Choose an account before disconnecting",
          },
        });
      },
    );
    detachedSetupPage({ context, path: "/connectors" });

    const card = await waitFor(() => {
      return connectorCardByLabel("GitHub");
    });
    click(within(card).getByLabelText("More options"));
    click(menuItemByText("Disconnect"));

    await expect(
      screen.findByText("Choose an account before disconnecting"),
    ).resolves.toBeInTheDocument();
    expect(within(card).getByText("@octocat")).toBeInTheDocument();
    expect(disconnectCount).toBe(1);

    click(within(card).getByLabelText("More options"));
    expect(menuItemByText("Disconnect")).toBeInTheDocument();
  });

  it("moves scope review into the connector options menu", async () => {
    const storedScopes = ["https://www.googleapis.com/auth/adwords"];
    const addedScopes = [
      "https://www.googleapis.com/auth/datamanager",
      "https://www.googleapis.com/auth/userinfo.email",
    ];
    mockConnectors([
      {
        connectorSlug: "google-ads",
        oauthScopes: storedScopes,
      },
    ]);
    context.mocks.api(
      connectorScopeDiffContract.getScopeDiff,
      ({ params, respond }) => {
        expect(params.connectorSlug).toBe("google-ads");
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

  it("filters connectors by slug", async () => {
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "github");

    await waitFor(() => {
      expect(screen.getByText("GitHub")).toBeInTheDocument();
    });
    expect(screen.queryByText("Slack")).not.toBeInTheDocument();
    expect(search()).toBe("?keywords=github");
  });

  it("filters connectors by label", async () => {
    mockConnectors([
      { connectorSlug: "github", externalUsername: "octocat" },
      { connectorSlug: "axiom", authMethod: "api-token" },
    ]);

    detachedSetupPage({ context, path: "/connectors" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "axiom");

    await waitFor(() => {
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  });

  it("filters connectors by connected status", async () => {
    setupConnectorStatusFilterPage();
    await expectConnectorCardsVisible({ github: true, asana: true });

    const filterTrigger = screen.getByLabelText("Filter connectors");
    expect(filterTrigger).toHaveClass("hidden", "sm:inline-flex");
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
      "/connectors?keywords=git&connection=not-connected",
    );
    await expectConnectorCardsVisible({ github: false, asana: false });

    const filterTrigger = screen.getByLabelText("Filter connectors");
    click(filterTrigger);
    click(menuItemByText("All"));

    await expectConnectorCardsVisible({ github: true, asana: false });
    const params = new URLSearchParams(search());
    expect(params.get("keywords")).toBe("git");
    expect(params.has("connection")).toBeFalsy();
  });

  it("filters connectors by agent", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000010";
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    context.mocks.data.agents([
      listAgent(agentId, "Research Agent", "preset:0"),
    ]);
    context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: params.id === agentId ? ["github"] : [],
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

  it("does not subscribe untouched connector cards to connector changes", async () => {
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await screen.findByText("GitHub");
    expect(context.mocks.ably.hasSubscription("connector:changed")).toBeFalsy();
  });

  it("hydrates connector search and clears it on clean navigation", async () => {
    mockConnectors([
      { connectorSlug: "github", externalUsername: "octocat" },
      { connectorSlug: "axiom", authMethod: "api-token" },
    ]);

    detachedSetupPage({ context, path: "/connectors?keywords=axiom" });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await waitFor(() => {
      expect(searchInput).toHaveValue("axiom");
      expect(screen.getByText("Axiom")).toBeInTheDocument();
    });
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();

    context.store.set(detachedNavigateTo$, ROUTES.connectors);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Find connectors")).toHaveValue("");
      expect(search()).toBe("");
    });
    expect(screen.getByText("GitHub")).toBeInTheDocument();
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
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: false },
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "meta");

    await expect(
      screen.findByText(/No connectors matching/),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Connect Meta Ads")).not.toBeInTheDocument();
  });

  it("refreshes connector catalog status when connector feature switches change", async () => {
    mockConnectors([]);

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: false },
    });

    const searchInput = await screen.findByPlaceholderText("Find connectors");
    await fill(searchInput, "meta");

    await expect(
      screen.findByText(/No connectors matching/),
    ).resolves.toBeInTheDocument();

    context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: { [FeatureSwitchKey.MetaAdsConnector]: true },
        effectiveSwitches: { [FeatureSwitchKey.MetaAdsConnector]: true },
      });
    });
    await context.store.set(
      setFeatureSwitch$,
      { [FeatureSwitchKey.MetaAdsConnector]: true },
      context.signal,
    );

    await expect(
      screen.findByLabelText("Connect Meta Ads"),
    ).resolves.toBeInTheDocument();
  });

  it("manages connector access for agents", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000001";
    const supportAgentId = "c0000000-0000-4000-a000-000000000002";
    const enabledByAgent = new Map<string, string[]>([
      [researchAgentId, ["github"]],
      [supportAgentId, []],
    ]);
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    context.mocks.data.agents([
      listAgent(researchAgentId, "Research Agent"),
      listAgent(supportAgentId, "Support Agent"),
    ]);
    context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: enabledByAgent.get(params.id) ?? [],
      });
    });
    context.mocks.api(
      userConnectorsContract.update,
      ({ params, body, respond }) => {
        const nextEnabledConnectorSlugs = applyUserConnectorUpdate(
          enabledByAgent.get(params.id) ?? [],
          body,
        );
        enabledByAgent.set(params.id, nextEnabledConnectorSlugs);
        return respond(200, {
          enabledConnectorSlugs: nextEnabledConnectorSlugs,
        });
      },
    );
    context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
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
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    context.mocks.data.agents([
      listAgent(activeAgentId, "Research Agent"),
      listAgent(staleAgentId, "Deleted Agent"),
    ]);
    context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
      if (params.id === staleAgentId) {
        return respond(404, {
          error: { message: "Agent not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, { enabledConnectorSlugs: ["github"] });
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
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    context.mocks.data.agents([
      listAgent(activeAgentId, "Research Agent"),
      listAgent(staleAgentId, "Deleted Agent"),
    ]);
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: ["github"] });
    });
    context.mocks.api(
      userPermissionGrantsContract.list,
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

  it("shows an exact authorized-agent count on connector cards", async () => {
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

    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    context.mocks.data.agents([
      listAgent(agentIds[0], "Research", "preset:0"),
      listAgent(agentIds[1], "Support", "preset:1"),
      listAgent(agentIds[2], "Growth"),
      listAgent(agentIds[3], "Ops", "preset:3"),
    ]);
    context.mocks.api(userConnectorsContract.get, ({ params, respond }) => {
      return respond(200, {
        enabledConnectorSlugs: enabledByAgent.get(params.id) ?? [],
      });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await waitFor(() => {
      const card = connectorCardByLabel("GitHub");
      const access = within(card).getByLabelText("Manage GitHub access");
      expect(access.textContent).toContain("Used by\u00a04 agents");
      expect(access).not.toHaveTextContent("Growth");
      expect(access).not.toHaveAttribute("title");
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

  it("keeps a single long authorized-agent name available on the card", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";
    const agentName = "Research Operations for International Partnerships";
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    context.mocks.data.agents([listAgent(agentId, agentName)]);
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: ["github"] });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      const access = within(connectorCardByLabel("GitHub")).getByLabelText(
        "Manage GitHub access",
      );
      expect(access).toHaveTextContent(`Used by ${agentName}`);
      expect(access).toHaveAttribute("title", agentName);
    });
  });

  it("shows an add-access affordance when no agents are authorized", async () => {
    const agentId = "c0000000-0000-4000-a000-000000000001";
    mockConnectors([{ connectorSlug: "github", externalUsername: "octocat" }]);
    context.mocks.data.agents([
      listAgent(agentId, "Research Agent", "preset:0"),
    ]);
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: [] });
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
        connectorSlug: "cloudinary",
        authMethod: "api-token",
        externalUsername: "demo-cloud",
      },
    ]);
    context.mocks.data.agents([listAgent(mediaAgentId, "Media Agent")]);
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        enabledConnectorSlugs: ["cloudinary"],
      });
    });
    context.mocks.api(userPermissionGrantsContract.list, ({ respond }) => {
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

  it("starts Google Maps OAuth without review guidance", async () => {
    mockConnectors([]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      connectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("google-maps");
        expect(body.callbackTarget).toBe("app");
        return respond(200, {
          authorizationUrl: "https://oauth.test/google-maps/authorize",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
    });

    await fill(await screen.findByPlaceholderText("Find connectors"), "maps");
    click(await screen.findByLabelText("Connect Google Maps"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/google-maps/authorize",
      );
    });
    const callbackMetadata = context.store.get(
      connectorAppOauthCallbackMetadata$,
    );
    expect(callbackMetadata).toContain('"connectorSlug":"google-maps"');
    expect(
      screen.queryByRole("dialog", { name: "Google Maps" }),
    ).not.toBeInTheDocument();
  });

  it("starts Meta Ads OAuth without review guidance", async () => {
    mockConnectors([]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      connectorOauthStartContract.start,
      ({ params, respond }) => {
        return respond(200, {
          authorizationUrl: `https://oauth.test/${params.connectorSlug}/authorize`,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.MetaAdsConnector]: true },
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

  it.each([
    ["airtable", "Airtable"],
    ["asana", "Asana"],
    ["cloudflare", "Cloudflare"],
    ["gumroad", "Gumroad"],
    ["hubspot", "HubSpot"],
    ["intervals-icu", "Intervals.icu"],
    ["linear", "Linear"],
    ["mercury", "Mercury"],
    ["microsoft-365", "Microsoft 365"],
    ["monday", "monday.com"],
    ["notion", "Notion"],
    ["outlook-calendar", "Outlook Calendar"],
    ["outlook-mail", "Outlook Mail"],
    ["sentry", "Sentry"],
    ["server-authored-oauth", "Server-authored OAuth"],
    ["strava", "Strava"],
    ["todoist", "Todoist"],
    ["vercel", "Vercel"],
    ["xero", "Xero"],
  ] as const)(
    "starts %s OAuth with the app callback",
    async (connectorSlug, label) => {
      mockConnectors([]);
      mockPublicConnectorStatus([
        publicStatusItem({
          connectorSlug,
          label,
          authMethods: [
            {
              id: "oauth",
              label: "OAuth",
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
      context.mocks.browser.open(authWindow);
      context.mocks.api(
        connectorOauthStartContract.start,
        ({ body, params, respond }) => {
          expect(params.connectorSlug).toBe(connectorSlug);
          expect(body.callbackTarget).toBe("app");
          return respond(200, {
            authorizationUrl: `https://oauth.test/${connectorSlug}/authorize`,
          });
        },
      );

      detachedSetupPage({ context, path: "/connectors" });

      click(await screen.findByLabelText(`Connect ${label}`));

      await waitFor(() => {
        expect(authWindow.location.href).toBe(
          `https://oauth.test/${connectorSlug}/authorize`,
        );
      });
    },
  );

  it("keeps denylisted OAuth connectors on their legacy callback", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "slack",
        label: "Slack",
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
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
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      connectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("slack");
        expect(body.callbackTarget).toBeUndefined();
        return respond(200, {
          authorizationUrl: "https://oauth.test/slack/authorize",
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    click(await screen.findByLabelText("Connect Slack"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/slack/authorize",
      );
    });
  });

  it("routes a feature-on OpenID account addition from catalog metadata", async () => {
    const connectorSlug = "server-authored-steam";
    const authMethod = "partner-openid";
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug,
        label: "Partner Steam",
        description: "Server-authored Steam player data",
        icon: {
          url: "https://icons.example.test/partner-steam.svg",
          invertInDarkMode: false,
        },
        authMethods: [
          {
            id: authMethod,
            label: "Partner OpenID",
            description: null,
            grantKind: "openid-auth",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(
      connectorOpenIdStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe(connectorSlug);
        expect(body.account).toStrictEqual({ intent: "add" });
        expect(body.authMethod).toBe(authMethod);
        expect(body.authorizeAgent).toBeUndefined();
        return respond(200, {
          authorizationUrl: "https://openid.test/partner-steam/authorize",
        });
      },
    );
    context.mocks.api(connectorOauthStartContract.start, ({ never }) => {
      return never();
    });

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await fill(
      await screen.findByPlaceholderText("Find connectors"),
      "partner steam",
    );
    expect(connectorIconByLabel("Partner Steam")).toHaveAttribute(
      "src",
      "https://icons.example.test/partner-steam.svg",
    );
    click(await screen.findByLabelText("Connect Partner Steam"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://openid.test/partner-steam/authorize",
      );
    });
  });

  it("ignores duplicate direct OAuth starts while a connector is polling", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Public Stripe",
        description: "Public Stripe description",
        icon: {
          url: "https://icons.example.test/stripe-catalog.svg",
          invertInDarkMode: true,
          scale: 1.5,
        },
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
      connectorOauthStartContract.start,
      ({ params, respond }) => {
        startCount += 1;
        return respond(200, {
          authorizationUrl: `https://oauth.test/${params.connectorSlug}/authorize`,
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
      expect(openMock.calls[0]).toStrictEqual({
        url: "/connectors/stripe/redirecting?label=Public+Stripe&iconUrl=https%3A%2F%2Ficons.example.test%2Fstripe-catalog.svg&iconInvertInDarkMode=true&iconScale=1.5",
        target: "_blank",
        features: "width=600,height=700",
      });
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
        connectorSlug: "stripe",
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
    context.mocks.api(connectorOauthStartContract.start, ({ never }) => {
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

  it("shows an error in the OAuth popup when the start request fails", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Public Stripe",
        description: "Public Stripe description",
        icon: {
          url: "https://icons.example.test/stripe-error.svg",
          invertInDarkMode: false,
        },
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
    context.mocks.browser.open(authWindow);
    context.mocks.api(connectorOauthStartContract.start, ({ respond }) => {
      return respond(500, {
        error: {
          message: "OAuth authorization is unavailable",
          code: "UNAVAILABLE",
        },
      });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "stripe");
    click(await screen.findByLabelText("Connect Public Stripe"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "/connectors/stripe/redirecting?label=Public+Stripe&iconUrl=https%3A%2F%2Ficons.example.test%2Fstripe-error.svg&iconInvertInDarkMode=false&status=error",
      );
      expect(authWindow.closed).toBeFalsy();
    });
  });

  it("ignores a null change before completing Stripe OAuth from a scoped event", async () => {
    const defaultAgentId = "c0000000-0000-4000-a000-000000000001";
    const researchAgentId = "c0000000-0000-4000-a000-000000000002";
    let listedConnectors = mockConnectors([]);
    context.mocks.data.agents([
      listAgent(defaultAgentId, "Zero"),
      listAgent(researchAgentId, "Research Agent"),
    ]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
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
      connectorOauthStartContract.start,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("stripe");
        expect(body?.authMethod).toBe("oauth");
        return respond(200, {
          authorizationUrl: "https://oauth.test/stripe/authorize",
        });
      },
    );
    const authorizedAgentIds: string[] = [];
    context.mocks.api(userConnectorsContract.update, ({ params, respond }) => {
      authorizedAgentIds.push(params.id);
      return respond(200, { enabledConnectorSlugs: ["stripe"] });
    });
    let connectorListRequests = 0;
    const catchUpObserved = context.mocks.deferred<void>();
    context.mocks.api(connectorsMainContract.list, ({ respond }) => {
      connectorListRequests += 1;
      if (
        context.mocks.ably.hasSubscription("connector:changed") &&
        !catchUpObserved.settled()
      ) {
        catchUpObserved.resolve();
      }
      return respond(200, {
        connectors: listedConnectors,
        connectorProvidedBindings: [],
      });
    });

    detachedSetupPage({
      context,
      path: "/connectors",
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
      expect(
        context.mocks.ably.hasSubscription("connector:changed"),
      ).toBeTruthy();
      expect(within(dialog).getByText("Connecting...")).toBeInTheDocument();
    });
    await catchUpObserved.promise;
    const requestsBeforeNull = connectorListRequests;

    context.mocks.ably.trigger("connector:changed", null);
    authWindow.close();

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("connector:changed"),
      ).toBeFalsy();
      expect(
        within(dialog).queryByText("Connecting..."),
      ).not.toBeInTheDocument();
    });
    expect(authorizedAgentIds).toStrictEqual([]);
    expect(connectorListRequests - requestsBeforeNull).toBe(1);

    const completionWindow = createMockAuthWindow();
    context.mocks.browser.open(completionWindow);
    click(buttonByText("Connect", dialog));

    await waitFor(() => {
      expect(completionWindow.location.href).toBe(
        "https://oauth.test/stripe/authorize",
      );
      expect(
        context.mocks.ably.hasSubscription("connector:changed"),
      ).toBeTruthy();
    });

    listedConnectors = mockConnectors([
      { connectorSlug: "stripe", authMethod: "oauth" },
    ]);
    context.mocks.ably.trigger("connector:changed", {
      connectorSlug: "stripe",
    });

    await waitFor(() => {
      expect(authorizedAgentIds).toStrictEqual([researchAgentId]);
      expect(
        within(connectorCardByLabel("Public Stripe")).getByText("Connected"),
      ).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("connector:changed"),
      ).toBeFalsy();
    });
    expect(
      screen.queryByRole("dialog", { name: "Public Stripe" }),
    ).not.toBeInTheDocument();
  });

  it("enables a no-auth connector for all visible agents without dialogs", async () => {
    const defaultAgentId = "c0000000-0000-4000-a000-000000000001";
    const researchAgentId = "c0000000-0000-4000-a000-000000000002";
    mockConnectors([]);
    context.mocks.data.agents([
      listAgent(defaultAgentId, "Zero"),
      listAgent(researchAgentId, "Research Agent"),
    ]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Public Stripe",
        description: "Public Stripe public catalog",
        authMethods: [
          {
            id: "api",
            label: "Public catalog",
            description: "Enable public catalog data.",
            grantKind: "none",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    const authWindow = createMockAuthWindow();
    const openMock = context.mocks.browser.open(authWindow);
    let connectCount = 0;
    context.mocks.api(
      connectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCount += 1;
        expect(params.connectorSlug).toBe("stripe");
        expect(body.account).toStrictEqual({ intent: "single-account" });
        expect(body.authMethod).toBe("api");
        expect(body.authorizeAgent).toBeTruthy();
        expect(body.agentId).toBeUndefined();
        return respond(200, {
          id: crypto.randomUUID(),
          slug: params.connectorSlug,
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
    const authorizedAgentIds: string[] = [];
    context.mocks.api(userConnectorsContract.update, ({ params, respond }) => {
      authorizedAgentIds.push(params.id);
      return respond(200, { enabledConnectorSlugs: ["stripe"] });
    });

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "stripe");
    click(await screen.findByLabelText("Connect Public Stripe"));

    await waitFor(() => {
      expect(connectCount).toBe(1);
      expect(authorizedAgentIds).toStrictEqual([researchAgentId]);
    });
    expect(openMock.calls).toHaveLength(0);
    expect(
      screen.getByText("Public Stripe enabled successfully"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/You've successfully connected with/u),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(connectorCardByLabel("Public Stripe")).getByText("Connected"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText("Public catalog")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Enable public catalog data."),
    ).not.toBeInTheDocument();
  });

  it("prompts for an optional label after a feature-on no-auth account addition", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Public Stripe",
        authMethods: [
          {
            id: "api",
            label: "Public catalog",
            description: "Enable public catalog data.",
            grantKind: "none",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    let submittedAccount: unknown;
    let submittedAuthorizeAgent: true | undefined;
    const connectionId = crypto.randomUUID();
    context.mocks.api(
      connectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        submittedAccount = body.account;
        submittedAuthorizeAgent = body.authorizeAgent;
        const connector: ConnectorResponse = {
          id: connectionId,
          slug: params.connectorSlug,
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
        };
        context.mocks.data.connectors([connector]);
        return respond(200, connector);
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await screen.findByLabelText("Connect Public Stripe"));

    const nameDialog = await screen.findByRole("dialog", {
      name: "Name your Public Stripe account",
    });
    expect(within(nameDialog).getByLabelText("Account name")).toHaveAttribute(
      "placeholder",
      `Account #${connectionId.slice(0, 8)}`,
    );
    click(buttonByText("Skip", nameDialog));
    expect(submittedAccount).toStrictEqual({ intent: "add" });
    expect(submittedAuthorizeAgent).toBeUndefined();
  });

  it("shows a no-auth method in the multi-method connect dialog", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
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
            id: "api",
            label: "Public catalog",
            description: "Enable public catalog data.",
            grantKind: "none",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    let connectCount = 0;
    context.mocks.api(
      connectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCount += 1;
        expect(params.connectorSlug).toBe("stripe");
        expect(body.authMethod).toBe("api");
        return respond(200, {
          id: crypto.randomUUID(),
          slug: params.connectorSlug,
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

    await fill(await screen.findByPlaceholderText("Find connectors"), "stripe");
    click(await screen.findByLabelText("Connect Public Stripe"));

    const dialog = await screen.findByRole("dialog", {
      name: "Public Stripe",
    });
    expect(within(dialog).getByText("Public OAuth")).toBeInTheDocument();
    expect(within(dialog).getByText("Public catalog")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Enable public catalog data."),
    ).toBeInTheDocument();
    click(buttonByText("Enable Public Stripe", dialog));

    await waitFor(() => {
      expect(connectCount).toBe(1);
    });
  });

  it("hides Stripe when public catalog status omits it", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([]);

    detachedSetupPage({
      context,
      path: "/connectors",
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
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "base44",
        label: "Base44",
        authMethods: [
          {
            id: "oauth",
            label: "OAuth",
            description: "Sign in with Base44 to grant access.",
            grantKind: "device-auth",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);

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

  it("submits feature-on device-auth add intent and start option ids", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
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
      connectorOauthDeviceAuthSessionContract.create,
      ({ body, params, respond }) => {
        startCount += 1;
        expect(params.connectorSlug).toBe("stripe");
        expect(body.account).toStrictEqual({ intent: "add" });
        expect(body.authorizeAgent).toBeUndefined();
        capturedOptions = body.options ?? null;
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000010",
          sessionToken: "stripe-device-session-token",
          connectorSlug: "stripe",
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

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

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

  it("returns device auth to a retryable state after an unexpected poll error", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "stripe",
        label: "Stripe",
        authMethods: [
          {
            id: "cli",
            label: "Stripe CLI",
            description: "Approve access with Stripe CLI.",
            grantKind: "device-auth",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    context.mocks.browser.open(createMockAuthWindow());
    let pollCount = 0;
    context.mocks.http.post(
      "*/api/connectors/stripe/oauth/device/sessions/:sessionId/poll",
      () => {
        pollCount += 1;
        if (pollCount === 1) {
          return HttpResponse.json(
            {
              error: {
                message: "Stripe device authorization is unavailable",
                code: "UNAVAILABLE",
              },
            },
            { status: 500 },
          );
        }
        return HttpResponse.error();
      },
    );

    detachedSetupPage({ context, path: "/connectors" });

    await fill(await screen.findByPlaceholderText("Find connectors"), "stripe");
    click(await screen.findByLabelText("Connect Stripe"));
    const dialog = await screen.findByRole("dialog", { name: "Stripe" });
    click(buttonByText("Connect Stripe", dialog));
    click(await within(dialog).findByTestId("connector-oauth-device-open"));

    await expect(
      screen.findByText("Stripe device authorization is unavailable"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(buttonByText("Connect Stripe", dialog)).toBeEnabled();
    });

    click(buttonByText("Connect Stripe", dialog));
    click(await within(dialog).findByTestId("connector-oauth-device-open"));
    await waitFor(() => {
      expect(buttonByText("Connect Stripe", dialog)).toBeEnabled();
    });
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("connects a manual token connector", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "axiom",
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
      connectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        submitCount += 1;
        expect(params.connectorSlug).toBe("axiom");
        expect(body.account).toStrictEqual({ intent: "single-account" });
        submittedValues = body.values;
        return respond(200, {
          id: crypto.randomUUID(),
          slug: "axiom",
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

  it("reloads manual connector status after success if post-success signal aborts", async () => {
    mockConnectors([]);
    const disconnectedAxiom = publicStatusItem({
      connectorSlug: "axiom",
      label: "Public Axiom",
      description: "Public Axiom description",
      icon: {
        url: "https://icons.example.test/axiom-v1.svg",
        invertInDarkMode: false,
      },
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
    });
    let catalogStatusItems: readonly PublicConnectorCatalogStatusItem[] = [
      disconnectedAxiom,
    ];
    let catalogStatusRequestCount = 0;
    let manualGrantConnectResponded = false;
    context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
      catalogStatusRequestCount += 1;
      return respond(200, { connectors: [...catalogStatusItems] });
    });
    context.mocks.api(
      connectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("axiom");
        expect(body.values).toStrictEqual({ apiToken: "xaat-test" });
        catalogStatusItems = [
          {
            ...disconnectedAxiom,
            icon: {
              url: "https://icons.example.test/axiom-v2.svg",
              invertInDarkMode: true,
            },
            connection: {
              authMethod: body.authMethod,
              externalUsername: null,
              externalEmail: null,
              reconnectReason: null,
            },
            connected: true,
            connectionStatus: "connected",
          },
        ];
        manualGrantConnectResponded = true;
        return respond(200, {
          id: crypto.randomUUID(),
          slug: "axiom",
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
    expect(
      within(connectorCardByLabel("Public Axiom")).queryByText("Connected"),
    ).not.toBeInTheDocument();
    const initialIcon = connectorIconByLabel("Public Axiom");
    expect(initialIcon).toHaveAttribute(
      "src",
      "https://icons.example.test/axiom-v1.svg",
    );
    fireEvent.error(initialIcon);
    expect(
      within(connectorCardByLabel("Public Axiom")).getByRole("img"),
    ).toHaveAccessibleName("Connector icon unavailable");

    const abortSignal = context.store.set(
      resetAfterManualGrantConnectSignal$,
      context.signal,
    );
    const originalThrowIfAborted = abortSignal.throwIfAborted.bind(abortSignal);
    Object.defineProperty(abortSignal, "throwIfAborted", {
      value: () => {
        if (manualGrantConnectResponded) {
          context.store.set(
            resetAfterManualGrantConnectSignal$,
            context.signal,
          );
        }
        originalThrowIfAborted();
      },
    });

    await expect(
      context.store.set(
        submitManualGrant$,
        {
          connectorSlug: "axiom",
          authMethod: "api-token",
          inputValues: { apiToken: "xaat-test" },
          options: { connectorLabel: "Public Axiom" },
        },
        abortSignal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    await waitFor(() => {
      expect(catalogStatusRequestCount).toBeGreaterThan(1);
      expect(
        within(connectorCardByLabel("Public Axiom")).getByText("Connected"),
      ).toBeInTheDocument();
      expect(connectorIconByLabel("Public Axiom")).toHaveAttribute(
        "src",
        "https://icons.example.test/axiom-v2.svg",
      );
      expect(connectorIconByLabel("Public Axiom")).toHaveClass(
        "zero-icon-mono",
      );
    });
  });

  it("submits only current public manual grant fields", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "axiom",
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
      connectorManualGrantContract.connect,
      ({ body, respond }) => {
        submittedAuthMethod = body.authMethod;
        submittedValues = body.values;
        return respond(200, {
          id: crypto.randomUUID(),
          slug: "axiom",
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

  it("connects manual-grant connectors without permission dialogs", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "axiom",
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
        connectorSlug: "stripe",
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
      connectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(body.authorizeAgent).toBeTruthy();
        expect(body.agentId).toBeUndefined();
        return respond(200, {
          id: crypto.randomUUID(),
          slug: params.connectorSlug,
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
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: [] });
    });
    context.mocks.api(userConnectorsContract.update, ({ respond }) => {
      authorizationUpdateCount += 1;
      return respond(200, { enabledConnectorSlugs: [] });
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

    await waitFor(() => {
      expect(
        screen.getByText("Public Axiom connected successfully"),
      ).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Public Axiom")).getByText("Connected"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("You've successfully connected with Public Axiom!"),
    ).not.toBeInTheDocument();

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

    await waitFor(() => {
      expect(
        screen.getByText("Public Stripe connected successfully"),
      ).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Public Stripe")).getByText("Connected"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("You've successfully connected with Public Stripe!"),
    ).not.toBeInTheDocument();
    expect(authorizationUpdateCount).toBe(0);
    expect(
      screen.queryByText("Public Stripe enabled for 1 agent"),
    ).not.toBeInTheDocument();
  });

  it("authorizes every visible non-default agent after connecting", async () => {
    const defaultAgentId = "c0000000-0000-4000-a000-000000000001";
    const researchAgentId = "c0000000-0000-4000-a000-000000000002";
    mockConnectors([]);
    context.mocks.data.agents([
      listAgent(defaultAgentId, "Zero"),
      listAgent(researchAgentId, "Research Agent"),
    ]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "axiom",
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
      connectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        return respond(200, {
          id: crypto.randomUUID(),
          slug: params.connectorSlug,
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
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: [] });
    });
    const authorizedAgentIds: string[] = [];
    context.mocks.api(
      userConnectorsContract.update,
      ({ body, params, respond }) => {
        authorizedAgentIds.push(params.id);
        expect(body).toStrictEqual({
          enabledConnectorSlugs: ["axiom"],
          operation: "add",
        });
        return respond(200, {
          enabledConnectorSlugs: ["axiom"],
        });
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

    await waitFor(() => {
      expect(
        screen.getByText("Public Axiom connected successfully"),
      ).toBeInTheDocument();
      expect(authorizedAgentIds).toStrictEqual([researchAgentId]);
    });
    expect(
      within(connectorCardByLabel("Public Axiom")).getByText("Connected"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("You've successfully connected with Public Axiom!"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Public Axiom enabled for 1 agent"),
    ).not.toBeInTheDocument();
  });

  it("connects a feature-on AWS account without changing permissions", async () => {
    mockConnectors([]);
    context.mocks.browser.open(createMockAuthWindow());
    context.mocks.api(
      connectorExternalCodeSessionContract.create,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("aws");
        expect(body.account).toStrictEqual({ intent: "add" });
        expect(body.authorizeAgent).toBeUndefined();
        return respond(200, {
          sessionId: "00000000-0000-4000-8000-000000000002",
          sessionToken: "mock-aws-external-code-session-token",
          connectorSlug: "aws",
          status: "pending",
          authorizationUrl: "https://oauth.test/aws/external-code",
          expiresIn: 600,
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
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
      expect(screen.getByText("AWS connected")).toBeInTheDocument();
    });
    click(
      buttonByText(
        "Skip",
        await screen.findByRole("dialog", {
          name: "Name your AWS account",
        }),
      ),
    );
    expect(
      screen.queryByText("You've successfully connected with AWS!"),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(
        within(connectorCardByLabel("AWS")).getByText(
          "arn:aws:iam::000000000000:user/mock-aws",
        ),
      ).toBeInTheDocument();
    });
  });

  it("keeps external-code validation inline and toasts unexpected HTTP errors", async () => {
    let completeCount = 0;
    context.mocks.api(
      connectorExternalCodeSessionContract.complete,
      ({ respond }) => {
        completeCount += 1;
        if (completeCount === 1) {
          return respond(400, {
            error: { message: "Invalid AWS code", code: "BAD_REQUEST" },
          });
        }
        return respond(500, {
          error: {
            message: "AWS authorization is unavailable",
            code: "UNAVAILABLE",
          },
        });
      },
    );

    const { dialog, complete } = await setupAwsExternalCodeConnection();
    click(complete);

    await expect(
      within(dialog).findByText("Invalid AWS code"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(complete).toBeEnabled();
    });

    click(complete);
    await expect(
      screen.findByText("AWS authorization is unavailable"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(complete).toBeEnabled();
    });
  });

  it("suppresses external-code transport error toasts and restores a retryable state", async () => {
    context.mocks.http.post(
      "*/api/connectors/aws/external-code/sessions/:sessionId/complete",
      () => {
        return HttpResponse.error();
      },
    );

    const { complete } = await setupAwsExternalCodeConnection();
    click(complete);
    await waitFor(() => {
      expect(complete).toBeEnabled();
    });
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("uses auth method help text for PlayStation external-code connection", async () => {
    mockConnectors([]);
    mockPublicConnectorStatus([
      publicStatusItem({
        connectorSlug: "playstation",
        label: "PlayStation",
        authMethods: [
          {
            id: "api",
            label: "PlayStation sign-in",
            description:
              "First make sure you are signed in to PlayStation at [https://www.playstation.com/](https://www.playstation.com/).\nClick the button below, then copy the `npsso` value.",
            grantKind: "external-code",
            manualFields: [],
            startOptions: [],
          },
        ],
      }),
    ]);
    context.mocks.browser.open(createMockAuthWindow());

    detachedSetupPage({ context, path: "/connectors" });

    await waitFor(() => {
      expect(
        screen.getByPlaceholderText("Find connectors"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByPlaceholderText("Find connectors"), "playstation");
    click(await screen.findByLabelText("Connect PlayStation"));

    const connectDialog = await screen.findByRole("dialog", {
      name: "PlayStation",
    });
    click(buttonByText("Start PlayStation sign-in", connectDialog));

    await waitFor(() => {
      expect(
        queryAllByRoleFast("link", connectDialog).find((link) => {
          return link.textContent === "https://www.playstation.com/";
        }),
      ).toBeInTheDocument();
    });
    expect(
      queryAllByRoleFast("link", connectDialog).find((link) => {
        return (
          link.textContent === "https://ca.account.sony.com/api/v1/ssocookie"
        );
      }),
    ).toBeUndefined();
    expect(
      buttonByText("Open PlayStation sign-in", connectDialog),
    ).toBeInTheDocument();
    expect(
      within(connectDialog).getByPlaceholderText("Code"),
    ).toBeInTheDocument();
  });

  it("initializes query-only custom connector edits from canonical fields", async () => {
    const connector = customConnector({
      headerInjections: [],
      queryInjections: [
        {
          name: "api_key",
          valueTemplate: "{{secrets.secret}}",
        },
      ],
    });
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    const updatedBodies: UpdateCustomConnectorBody[] = [];
    context.mocks.api(
      customConnectorByIdContract.update,
      ({ body, respond }) => {
        if (body.kind === "mcp") {
          throw new Error("Expected an HTTP custom connector update");
        }
        updatedBodies.push(body);
        return respond(200, {
          ...connector,
          displayName: body.displayName,
          prefixTemplates: body.prefixTemplates,
          fields: body.fields,
          headerInjections: body.headerInjections,
          queryInjections: body.queryInjections,
          storageVersion: body.storageVersion ?? connector.storageVersion,
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors?tab=custom" });

    await screen.findByText(connector.displayName);
    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Edit"));
    const editDialog = await screen.findByRole("dialog", {
      name: "Edit custom connector",
    });

    expect(within(editDialog).getByLabelText("Display name")).toHaveValue(
      connector.displayName,
    );
    expect(within(editDialog).getByLabelText(/Prefixes/u)).toHaveValue(
      "https://api.acme.test/v1/",
    );
    expect(
      within(editDialog).getByText(
        "Advanced API fields and injections are preserved when you save.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Save", editDialog));
    await waitFor(() => {
      expect(updatedBodies).toHaveLength(1);
    });
    expect(updatedBodies).toStrictEqual([
      expect.objectContaining({
        prefixTemplates: connector.prefixTemplates,
        fields: connector.fields,
        headerInjections: [],
        queryInjections: connector.queryInjections,
      }),
    ]);
  });

  it("keeps a disconnected custom connector manageable without loading agent access", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000031";
    const supportAgentId = "c0000000-0000-4000-a000-000000000032";
    const connector = customConnector({});
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([
      listAgent(researchAgentId, "Research"),
      listAgent(supportAgentId, "Support"),
    ]);
    let agentAccessReads = 0;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        agentAccessReads += 1;
        const grants: AgentCustomConnectorGrant[] =
          params.id === researchAgentId
            ? [{ customConnectorId: connector.id, permissionNames: [] }]
            : [];
        return respond(200, { grants });
      },
    );

    detachedSetupPage({ context, path: "/connectors?tab=custom" });

    await waitFor(() => {
      const card = connectorCardByLabel("Acme Search");
      expect(within(card).getByText("HTTP API")).toBeInTheDocument();
      expect(within(card).getByText("Not connected")).toBeInTheDocument();
      expect(
        within(card).getByText("https://api.acme.test/v1/"),
      ).toBeInTheDocument();
      expect(
        within(card).queryByTestId("connector-card-agent-access"),
      ).not.toBeInTheDocument();
      expect(card).toHaveAccessibleName("Connect Acme Search");
    });

    click(screen.getByLabelText("More options"));
    expect(menuItemByText("Connect")).toBeInTheDocument();
    expect(menuItemByText("Edit")).toBeInTheDocument();
    expect(menuItemByText("Delete")).toBeInTheDocument();
    expect(agentAccessReads).toBe(0);
  });

  it("selects and edits permissions for a custom connector from settings", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000035";
    const supportAgentId = "c0000000-0000-4000-a000-000000000036";
    const connector = customConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
      permissionBundleRef: "builtin:feishu@1",
    });
    const accessByAgentId = new Map<string, AgentCustomConnectorGrants>([
      [researchAgentId, { grants: [] }],
      [supportAgentId, { grants: [] }],
    ]);
    const updates: {
      readonly agentId: string;
      readonly body: AgentCustomConnectorUpdate;
    }[] = [];
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([
      listAgent(researchAgentId, "Research"),
      listAgent(supportAgentId, "Support"),
    ]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(
      customConnectorByIdContract.permissions,
      ({ params, respond }) => {
        expect(params.id).toBe(connector.id);
        return respond(200, {
          ref: "builtin:feishu@1",
          permissions: [
            {
              name: "standard:use",
              description: "Use standard Feishu APIs with approval.",
            },
            {
              name: "messages:send-as-user",
              description: "Send messages as the connected user.",
            },
          ],
          defaultPolicies: {
            "standard:use": "allow",
            "messages:send-as-user": "deny",
          },
        });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        return respond(200, accessByAgentId.get(params.id) ?? { grants: [] });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ params, body, respond }) => {
        updates.push({ agentId: params.id, body });
        const current = accessByAgentId.get(params.id) ?? {
          grants: [],
        };
        const requestedIds = new Set(
          body.grants.map((grant) => {
            return grant.customConnectorId;
          }),
        );
        const next: AgentCustomConnectorGrants = {
          grants:
            body.operation === "remove"
              ? current.grants.filter((grant) => {
                  return !requestedIds.has(grant.customConnectorId);
                })
              : body.grants,
        };
        accessByAgentId.set(params.id, next);
        return respond(200, next);
      },
    );

    detachedSetupPage({ context, path: "/connectors?tab=custom" });

    click(await screen.findByLabelText("Manage Acme Search access"));
    const accessDialog = await screen.findByRole("dialog", {
      name: "Manage Acme Search access",
    });
    click(
      within(accessDialog).getByLabelText(
        "Authorize Acme Search access for Support",
      ),
    );

    const permission = await screen.findByText("messages:send-as-user");
    const permissionRow = permission.parentElement?.parentElement;
    const permissionDrawer = permission.closest('[role="dialog"]');
    if (
      !(permissionRow instanceof HTMLElement) ||
      !(permissionDrawer instanceof HTMLElement)
    ) {
      throw new Error("Custom connector permission drawer not found");
    }
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass(
      "bg-overlay/45",
    );
    expect(
      within(permissionDrawer).queryByText("standard:use"),
    ).not.toBeInTheDocument();
    click(buttonByText("Allow", permissionRow));
    click(buttonByText("Apply", permissionDrawer));

    await waitFor(() => {
      expect(updates).toStrictEqual([
        {
          agentId: supportAgentId,
          body: {
            grants: [
              {
                customConnectorId: connector.id,
                permissionNames: ["messages:send-as-user"],
              },
            ],
            operation: "add",
          },
        },
      ]);
      expect(
        within(accessDialog).getByLabelText(
          "Revoke Acme Search access for Support",
        ),
      ).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Acme Search")).getByTestId(
          "connector-card-agent-access",
        ),
      ).toHaveTextContent("Used by Support");
      expect(accessDialog).toBeVisible();
    });

    click(
      within(accessDialog).getByLabelText(
        "Manage Acme Search permissions for Support",
      ),
    );
    const editedPermission = await screen.findByText("messages:send-as-user");
    const editedPermissionRow = editedPermission.parentElement?.parentElement;
    const editedPermissionDrawer = editedPermission.closest('[role="dialog"]');
    if (
      !(editedPermissionRow instanceof HTMLElement) ||
      !(editedPermissionDrawer instanceof HTMLElement)
    ) {
      throw new Error("Custom connector permission drawer not found");
    }
    expect(buttonByText("Allow", editedPermissionRow)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    click(buttonByText("Deny", editedPermissionRow));
    click(buttonByText("Apply", editedPermissionDrawer));

    await waitFor(() => {
      expect(updates[1]).toStrictEqual({
        agentId: supportAgentId,
        body: {
          grants: [
            {
              customConnectorId: connector.id,
              permissionNames: [],
            },
          ],
          operation: "add",
        },
      });
      expect(
        within(accessDialog).getByLabelText(
          "Revoke Acme Search access for Support",
        ),
      ).toBeInTheDocument();
    });

    click(
      within(accessDialog).getByLabelText(
        "Revoke Acme Search access for Support",
      ),
    );
    await waitFor(() => {
      expect(updates[2]).toStrictEqual({
        agentId: supportAgentId,
        body: {
          grants: [{ customConnectorId: connector.id, permissionNames: [] }],
          operation: "remove",
        },
      });
      expect(
        within(accessDialog).getByLabelText(
          "Authorize Acme Search access for Support",
        ),
      ).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Acme Search")).getByTestId(
          "connector-card-access-empty",
        ),
      ).toHaveTextContent("Add access");
    });
  });

  it("connects a permissioned custom connector without replacing its grants", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000037";
    const connector = customConnector({
      permissionBundleRef: "builtin:feishu@1",
    });
    let connected = false;
    let submittedValues: readonly {
      readonly key: string;
      readonly kind: "secret" | "variable";
      readonly value: string;
    }[] = [];
    let authorizationUpdates = 0;
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([listAgent(researchAgentId, "Research")]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [
          {
            ...connector,
            connected,
            configuredFieldKeys: connected ? ["secret"] : [],
            missingRequiredFields: connected ? [] : ["secret"],
          },
        ],
      });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        grants: [
          {
            customConnectorId: connector.id,
            permissionNames: ["messages:send-as-user"],
          },
        ],
      });
    });
    context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
      authorizationUpdates += 1;
      return respond(200, {
        grants: [
          {
            customConnectorId: connector.id,
            permissionNames: ["messages:send-as-user"],
          },
        ],
      });
    });
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ body, respond }) => {
        expect(body.account).toStrictEqual({ intent: "single-account" });
        submittedValues = body.values;
        connected = true;
        return respond(200, {
          ...connector,
          connected: true,
          configuredFieldKeys: ["secret"],
          missingRequiredFields: [],
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors?tab=custom" });

    click(await screen.findByLabelText("Connect Acme Search"));
    const connectDialog = await screen.findByRole("dialog", {
      name: "Connect Acme Search",
    });
    await fill(within(connectDialog).getByLabelText("Secret"), "acme-secret");
    click(buttonByText("Save", connectDialog));

    await waitFor(() => {
      expect(submittedValues).toStrictEqual([
        { key: "secret", kind: "secret", value: "acme-secret" },
      ]);
      expect(
        within(connectorCardByLabel("Acme Search")).getByText("Connected"),
      ).toBeInTheDocument();
    });
    expect(authorizationUpdates).toBe(0);
    expect(
      within(connectorCardByLabel("Acme Search")).getByTestId(
        "connector-card-agent-access",
      ),
    ).toHaveTextContent("Used by Research");
  });

  it("submits declared custom connector fields without prefilling stored values", async () => {
    const connector = customConnector({
      displayName: "Acme Multi Field",
      fields: [
        {
          key: "api_token",
          label: "API token",
          kind: "secret",
          required: true,
          description: "Issued by the provider",
        },
        {
          key: "account_id",
          label: "Account ID",
          kind: "variable",
          required: true,
          description: "Workspace account",
        },
        {
          key: "region",
          label: "Region",
          kind: "variable",
          required: false,
        },
        {
          key: "backup_token",
          label: "Backup token",
          kind: "secret",
          required: false,
        },
        {
          key: "constructor",
          label: "Constructor ID",
          kind: "variable",
          required: false,
        },
      ],
      missingRequiredFields: ["api_token", "account_id"],
      configuredFieldKeys: ["backup_token"],
    });
    let submittedValues: readonly {
      readonly key: string;
      readonly kind: "secret" | "variable";
      readonly value: string;
    }[] = [];
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ body, respond }) => {
        submittedValues = body.values;
        return respond(200, {
          ...connector,
          connected: true,
          missingRequiredFields: [],
          configuredFieldKeys: ["api_token", "account_id", "backup_token"],
        });
      },
    );

    detachedSetupPage({ context, path: "/connectors?tab=custom" });

    click(await screen.findByLabelText("Connect Acme Multi Field"));
    const dialog = await screen.findByRole("dialog", {
      name: "Connect Acme Multi Field",
    });
    expect(
      [...dialog.querySelectorAll("label")].map((label) => {
        return label.textContent;
      }),
    ).toStrictEqual([
      "API token",
      "Account ID",
      "Region",
      "Backup token",
      "Constructor ID",
    ]);
    expect(within(dialog).getByText("Issued by the provider")).toBeVisible();
    expect(within(dialog).getByText("Workspace account")).toBeVisible();
    expect(
      within(dialog).queryByText(/Your secret is encrypted/u),
    ).not.toBeInTheDocument();

    const apiToken = within(dialog).getByLabelText("API token");
    const accountId = within(dialog).getByLabelText("Account ID");
    const region = within(dialog).getByLabelText("Region");
    const backupToken = within(dialog).getByLabelText("Backup token");
    const constructorId = within(dialog).getByLabelText("Constructor ID");
    expect(apiToken).toHaveAttribute("type", "password");
    expect(apiToken).toHaveAttribute("autocomplete", "new-password");
    expect(accountId).toHaveAttribute("type", "text");
    expect(backupToken).toHaveValue("");
    expect(constructorId).toHaveValue("");
    expect(backupToken).toHaveAccessibleDescription("Optional · Configured");
    expect(apiToken).toHaveAccessibleDescription(
      "Issued by the provider Required",
    );

    const save = buttonByText("Save", dialog);
    expect(save).toBeDisabled();
    await fill(apiToken, "  xa at\n");
    expect(save).toBeDisabled();
    await fill(accountId, "  Acme West  ");
    await fill(region, "   ");
    expect(save).toBeEnabled();
    click(save);

    await waitFor(() => {
      expect(submittedValues).toStrictEqual([
        { key: "api_token", kind: "secret", value: "xaat" },
        { key: "account_id", kind: "variable", value: "Acme West" },
      ]);
    });
  });

  it.each(["request failure", "incomplete response"] as const)(
    "does not authorize a custom connector after a %s",
    async (outcome) => {
      const agentId = "c0000000-0000-4000-a000-000000000038";
      const connector = customConnector({ displayName: "Acme Incomplete" });
      let valueWrites = 0;
      let authorizationUpdates = 0;
      context.mocks.data.org({
        id: "org_1",
        name: "Test Org",
        role: "admin",
      });
      context.mocks.data.agents([listAgent(agentId, "Research")]);
      context.mocks.api(customConnectorsContract.list, ({ respond }) => {
        return respond(200, { connectors: [connector] });
      });
      context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
        return respond(200, { grants: [] });
      });
      context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
        authorizationUpdates += 1;
        return respond(200, {
          grants: [
            {
              customConnectorId: connector.id,
              permissionNames: [],
            },
          ],
        });
      });
      context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
        valueWrites += 1;
        return outcome === "request failure"
          ? respond(500, {
              error: { code: "UNAVAILABLE", message: "Write unavailable" },
            })
          : respond(200, {
              ...connector,
              connected: false,
              missingRequiredFields: [],
              configuredFieldKeys: ["secret"],
            });
      });

      detachedSetupPage({ context, path: "/connectors?tab=custom" });

      click(await screen.findByLabelText("Connect Acme Incomplete"));
      const dialog = await screen.findByRole("dialog", {
        name: "Connect Acme Incomplete",
      });
      await fill(within(dialog).getByLabelText("Secret"), "acme-secret");
      click(buttonByText("Save", dialog));

      await waitFor(() => {
        expect(valueWrites).toBe(1);
      });
      expect(authorizationUpdates).toBe(0);
      expect(dialog).toBeInTheDocument();
    },
  );

  it("manages a manual MCP custom connector through the settings lifecycle", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000061";
    const supportAgentId = "c0000000-0000-4000-a000-000000000062";
    const createBodies: CreateCustomConnectorBody[] = [];
    const updateBodies: UpdateCustomConnectorBody[] = [];
    const authorizationUpdates: {
      readonly agentId: string;
      readonly body: AgentCustomConnectorUpdate;
    }[] = [];
    const grantsByAgentId = new Map<string, AgentCustomConnectorGrant[]>([
      [researchAgentId, []],
      [supportAgentId, []],
    ]);
    let connector: CustomConnectorMcpResponse | null = null;
    let savedValues: readonly {
      readonly key: string;
      readonly kind: "secret" | "variable";
      readonly value: string;
    }[] = [];
    let disconnectCount = 0;
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([
      listAgent(researchAgentId, "Research"),
      listAgent(supportAgentId, "Support"),
    ]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: connector ? [connector] : [] });
    });
    context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
      if (body.kind !== "mcp") {
        throw new Error("Expected an MCP custom connector create");
      }
      createBodies.push(body);
      connector = mcpCustomConnector({
        displayName: body.displayName,
        endpoint: body.endpoint,
        fields: body.fields,
        headerInjections: body.headerInjections,
        queryInjections: body.queryInjections,
        authMode: body.authMode ?? "manual",
        storageVersion: body.storageVersion ?? 1,
        connected: false,
        missingRequiredFields: ["secret"],
        configuredFieldKeys: [],
      });
      return respond(201, connector);
    });
    context.mocks.api(
      customConnectorByIdContract.update,
      ({ body, respond }) => {
        if (body.kind !== "mcp" || !connector) {
          throw new Error("Expected an existing MCP custom connector update");
        }
        updateBodies.push(body);
        connector = {
          ...connector,
          displayName: body.displayName,
          endpoint: body.endpoint,
          fields: body.fields,
          headerInjections: body.headerInjections,
          queryInjections: body.queryInjections,
          authMode: body.authMode ?? connector.authMode,
          storageVersion: body.storageVersion ?? connector.storageVersion,
        };
        return respond(200, connector);
      },
    );
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ body, respond }) => {
        if (!connector) {
          throw new Error("Expected an MCP custom connector");
        }
        expect(body.account).toStrictEqual({ intent: "single-account" });
        savedValues = body.values;
        connector = {
          ...connector,
          connected: true,
          missingRequiredFields: [],
          configuredFieldKeys: ["secret"],
        };
        return respond(200, connector);
      },
    );
    context.mocks.api(
      connectorAccountsContract.disconnectSingleAccount,
      ({ body, respond }) => {
        if (!connector) {
          throw new Error("Expected an MCP custom connector");
        }
        expect(body.target).toStrictEqual({
          kind: "custom",
          customConnectorId: connector.id,
        });
        disconnectCount += 1;
        connector = {
          ...connector,
          connected: false,
          missingRequiredFields: ["secret"],
          configuredFieldKeys: [],
        };
        return respond(204);
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        const grants = grantsByAgentId.get(params.id) ?? [];
        return respond(200, { grants });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ params, body, respond }) => {
        authorizationUpdates.push({ agentId: params.id, body });
        const current = grantsByAgentId.get(params.id) ?? [];
        const requestedIds = new Set(
          body.grants.map((grant) => {
            return grant.customConnectorId;
          }),
        );
        const grants =
          body.operation === "remove"
            ? current.filter((grant) => {
                return !requestedIds.has(grant.customConnectorId);
              })
            : body.grants;
        grantsByAgentId.set(params.id, grants);
        return respond(200, { grants });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
    });

    click(await screen.findByText("New connector"));
    const createDialog = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    expect(
      within(createDialog).getByLabelText("Connector type"),
    ).toHaveTextContent("HTTP API");
    click(within(createDialog).getByLabelText("Connector type"));
    click(await screen.findByRole("option", { name: "MCP · Streamable HTTP" }));
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(
      within(createDialog).queryByLabelText(/Prefixes/u),
    ).not.toBeInTheDocument();
    fireEvent.change(within(createDialog).getByLabelText("Display name"), {
      target: { value: "Acme MCP" },
    });
    click(buttonByText("Add authentication", createDialog));
    click(menuItemByText("API authentication"));
    expect(buttonByText("Create", createDialog)).toBeDisabled();
    fireEvent.change(within(createDialog).getByLabelText(/MCP endpoint/u), {
      target: { value: "https://mcp.acme.test/server" },
    });
    await waitFor(() => {
      expect(buttonByText("Create", createDialog)).toBeEnabled();
    });
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      const card = connectorCardByLabel("Acme MCP");
      expect(within(card).getByText("MCP")).toBeInTheDocument();
      expect(
        within(card).getByText("https://mcp.acme.test/server"),
      ).toBeInTheDocument();
      expect(within(card).getByText("Not connected")).toBeInTheDocument();
    });
    expect(createBodies).toStrictEqual([
      {
        kind: "mcp",
        displayName: "Acme MCP",
        endpoint: "https://mcp.acme.test/server",
        transport: "streamable-http",
        fields: [
          {
            key: "secret",
            label: "Secret",
            kind: "secret",
            required: true,
            description: "API credential",
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [],
        authMode: "manual",
        storageVersion: 1,
      },
    ]);

    click(buttonByAriaLabel("Connect Acme MCP"));
    const connectDialog = await screen.findByRole("dialog", {
      name: "Connect Acme MCP",
    });
    await fill(within(connectDialog).getByLabelText("Secret"), "mcp-secret");
    click(buttonByText("Save", connectDialog));
    await waitFor(() => {
      expect(savedValues).toStrictEqual([
        { key: "secret", kind: "secret", value: "mcp-secret" },
      ]);
      expect(
        within(connectorCardByLabel("Acme MCP")).getByTestId(
          "connector-card-agent-access",
        ),
      ).toHaveTextContent("Used by 2 agents");
      expect(
        within(connectorCardByLabel("Acme MCP")).getByText("Connected"),
      ).toBeInTheDocument();
    });

    click(
      within(connectorCardByLabel("Acme MCP")).getByLabelText(
        "Manage Acme MCP access",
      ),
    );
    const accessDialog = await screen.findByRole("dialog", {
      name: "Manage Acme MCP access",
    });
    click(
      within(accessDialog).getByLabelText("Revoke Acme MCP access for Support"),
    );
    await waitFor(() => {
      expect(
        within(accessDialog).getByLabelText(
          "Authorize Acme MCP access for Support",
        ),
      ).toBeEnabled();
    });
    click(
      within(accessDialog).getByLabelText(
        "Authorize Acme MCP access for Support",
      ),
    );
    await waitFor(() => {
      expect(
        within(accessDialog).getByLabelText(
          "Revoke Acme MCP access for Support",
        ),
      ).toBeInTheDocument();
    });
    expect(
      authorizationUpdates.some(({ agentId, body }) => {
        return agentId === supportAgentId && body.operation === "remove";
      }),
    ).toBeTruthy();
    click(within(accessDialog).getByLabelText("Close"));

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Edit"));
    const editDialog = await screen.findByRole("dialog", {
      name: "Edit custom connector",
    });
    expect(
      within(editDialog).queryByLabelText("Connector type"),
    ).not.toBeInTheDocument();
    await fill(
      within(editDialog).getByLabelText("Display name"),
      "Acme MCP v2",
    );
    fireEvent.change(within(editDialog).getByLabelText(/MCP endpoint/u), {
      target: { value: "https://mcp.acme.test/v2" },
    });
    click(buttonByText("Save", editDialog));
    await waitFor(() => {
      expect(connectorCardByLabel("Acme MCP v2")).toBeInTheDocument();
    });
    expect(updateBodies).toStrictEqual([
      {
        kind: "mcp",
        displayName: "Acme MCP v2",
        endpoint: "https://mcp.acme.test/v2",
        transport: "streamable-http",
        fields: [
          {
            key: "secret",
            label: "Secret",
            kind: "secret",
            required: true,
            description: "API credential",
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [],
        authMode: "manual",
        storageVersion: 1,
      },
    ]);

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));
    await waitFor(() => {
      expect(disconnectCount).toBe(1);
      expect(buttonByAriaLabel("Connect Acme MCP v2")).toBeInTheDocument();
    });
  });

  it("preserves confidential OAuth configuration for MCP edits and connects", async () => {
    const createdBodies: CreateCustomConnectorBody[] = [];
    const updatedBodies: UpdateCustomConnectorBody[] = [];
    let connector: CustomConnectorMcpResponse | null = null;
    let oauthStartCount = 0;
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: connector ? [connector] : [] });
    });
    context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
      if (body.kind !== "mcp" || !body.oauthConfig) {
        throw new Error("Expected an OAuth MCP custom connector create");
      }
      createdBodies.push(body);
      connector = mcpCustomConnector({
        displayName: body.displayName,
        endpoint: body.endpoint,
        fields: body.fields,
        headerInjections: body.headerInjections,
        queryInjections: body.queryInjections,
        authMode: "oauth",
        oauthConfig: publicCustomConnectorOAuthConfig(body.oauthConfig),
        storageVersion: body.storageVersion ?? 1,
        connected: false,
        missingRequiredFields: ["oauth"],
        configuredFieldKeys: [],
      });
      return respond(201, connector);
    });
    context.mocks.api(
      customConnectorByIdContract.update,
      ({ body, respond }) => {
        if (body.kind !== "mcp" || !body.oauthConfig || !connector) {
          throw new Error("Expected an OAuth MCP custom connector update");
        }
        updatedBodies.push(body);
        connector = {
          ...connector,
          displayName: body.displayName,
          endpoint: body.endpoint,
          fields: body.fields,
          headerInjections: body.headerInjections,
          queryInjections: body.queryInjections,
          authMode: "oauth",
          oauthConfig: publicCustomConnectorOAuthConfig(body.oauthConfig),
          storageVersion: body.storageVersion ?? connector.storageVersion,
        };
        return respond(200, connector);
      },
    );
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      ({ body, respond }) => {
        if (!connector) {
          throw new Error("Expected an OAuth MCP custom connector");
        }
        expect(body.account).toStrictEqual({ intent: "single-account" });
        oauthStartCount += 1;
        connector = {
          ...connector,
          connected: true,
          missingRequiredFields: [],
        };
        authWindow.close();
        return respond(200, {
          authorizationUrl: "https://oauth.acme.test/authorize?state=mcp-ui",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
    });

    click(await screen.findByText("New connector"));
    const createDialog = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    click(within(createDialog).getByLabelText("Connector type"));
    click(await screen.findByRole("option", { name: "MCP · Streamable HTTP" }));
    fireEvent.change(within(createDialog).getByLabelText("Display name"), {
      target: { value: "OAuth MCP" },
    });
    fireEvent.change(within(createDialog).getByLabelText(/MCP endpoint/u), {
      target: { value: "https://mcp.acme.test/oauth" },
    });
    click(buttonByText("Add authentication", createDialog));
    click(menuItemByText("OAuth 2.0"));
    fireEvent.change(within(createDialog).getByLabelText("Authorization URL"), {
      target: { value: "https://oauth.acme.test/authorize" },
    });
    fireEvent.change(within(createDialog).getByLabelText("Token URL"), {
      target: { value: "https://oauth.acme.test/token" },
    });
    fireEvent.change(within(createDialog).getByLabelText("Client ID"), {
      target: { value: "mcp-client" },
    });
    fireEvent.change(within(createDialog).getByLabelText("Client secret"), {
      target: { value: "mcp-client-secret" },
    });
    await waitFor(() => {
      expect(buttonByText("Create", createDialog)).toBeEnabled();
    });
    click(buttonByText("Create", createDialog));
    await waitFor(() => {
      expect(connectorCardByLabel("OAuth MCP")).toBeInTheDocument();
    });
    expect(createdBodies[0]).toMatchObject({
      kind: "mcp",
      displayName: "OAuth MCP",
      endpoint: "https://mcp.acme.test/oauth",
      transport: "streamable-http",
      authMode: "oauth",
      oauthConfig: {
        clientId: "mcp-client",
        clientSecret: "mcp-client-secret",
        authorizationUrl: "https://oauth.acme.test/authorize",
        tokenUrl: "https://oauth.acme.test/token",
      },
    });
    expect(createdBodies[0]).not.toHaveProperty("prefixTemplates");

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Edit"));
    const editDialog = await screen.findByRole("dialog", {
      name: "Edit custom connector",
    });
    expect(within(editDialog).getByLabelText("New client secret")).toHaveValue(
      "",
    );
    fireEvent.change(within(editDialog).getByLabelText(/MCP endpoint/u), {
      target: { value: "https://mcp.acme.test/oauth-v2" },
    });
    click(buttonByText("Save", editDialog));
    await waitFor(() => {
      expect(updatedBodies).toHaveLength(1);
    });
    expect(updatedBodies[0]).toMatchObject({
      kind: "mcp",
      endpoint: "https://mcp.acme.test/oauth-v2",
      transport: "streamable-http",
      storageVersion: 1,
    });
    expect(updatedBodies[0]?.oauthConfig).not.toHaveProperty("clientSecret");
    expect(updatedBodies[0]).not.toHaveProperty("prefixTemplates");

    click(buttonByAriaLabel("Connect OAuth MCP"));
    await waitFor(() => {
      expect(oauthStartCount).toBe(1);
      expect(authWindow.location.href).toBe(
        "https://oauth.acme.test/authorize?state=mcp-ui",
      );
    });
  });

  it("keeps MCP access reductions available while the feature is disabled", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000063";
    const supportAgentId = "c0000000-0000-4000-a000-000000000064";
    let connector = mcpCustomConnector({
      connected: true,
    });
    const grantsByAgentId = new Map<string, AgentCustomConnectorGrant[]>([
      [
        researchAgentId,
        [
          {
            customConnectorId: connector.id,
            permissionNames: [],
          },
        ],
      ],
      [supportAgentId, []],
    ]);
    const authorizationUpdates: AgentCustomConnectorUpdate[] = [];
    let disconnectCount = 0;
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([
      listAgent(researchAgentId, "Research"),
      listAgent(supportAgentId, "Support"),
    ]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        const grants = grantsByAgentId.get(params.id) ?? [];
        return respond(200, { grants });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ params, body, respond }) => {
        if (body.operation !== "remove") {
          throw new Error("Expected only MCP authorization removal");
        }
        authorizationUpdates.push(body);
        const requestedIds = new Set(
          body.grants.map((grant) => {
            return grant.customConnectorId;
          }),
        );
        const current = grantsByAgentId.get(params.id) ?? [];
        const grants = current.filter((grant) => {
          return !requestedIds.has(grant.customConnectorId);
        });
        grantsByAgentId.set(params.id, grants);
        return respond(200, { grants });
      },
    );
    context.mocks.api(
      connectorAccountsContract.disconnectSingleAccount,
      ({ body, respond }) => {
        expect(body.target).toStrictEqual({
          kind: "custom",
          customConnectorId: connector.id,
        });
        disconnectCount += 1;
        connector = {
          ...connector,
          connected: false,
        };
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: false },
    });

    click(await screen.findByText("New connector"));
    const createDialog = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    expect(
      within(createDialog).queryByLabelText("Connector type"),
    ).not.toBeInTheDocument();
    expect(
      within(createDialog).getByLabelText(/Prefixes/u),
    ).toBeInTheDocument();
    click(buttonByText("Cancel", createDialog));

    const card = await waitFor(() => {
      return connectorCardByLabel("Acme MCP");
    });
    expect(within(card).getByText("MCP")).toBeInTheDocument();
    expect(
      within(card).getByText("https://mcp.acme.test/server"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByLabelText("Connect Acme MCP")).not.toBeInTheDocument();
    expect(
      within(card).getByTestId("connector-card-agent-access"),
    ).toHaveTextContent("Used by Research");

    click(within(card).getByLabelText("Manage Acme MCP access"));
    const accessDialog = await screen.findByRole("dialog", {
      name: "Manage Acme MCP access",
    });
    const supportAccessSwitch = within(accessDialog).getByLabelText(
      "Authorize Acme MCP access for Support",
    );
    expect(supportAccessSwitch).toHaveAttribute("aria-disabled", "true");
    click(supportAccessSwitch);
    expect(authorizationUpdates).toHaveLength(0);
    click(
      within(accessDialog).getByLabelText(
        "Revoke Acme MCP access for Research",
      ),
    );
    await waitFor(() => {
      expect(authorizationUpdates).toStrictEqual([
        {
          grants: [
            {
              customConnectorId: connector.id,
              permissionNames: [],
            },
          ],
          operation: "remove",
        },
      ]);
      expect(
        within(accessDialog).getByLabelText(
          "Authorize Acme MCP access for Research",
        ),
      ).toHaveAttribute("aria-disabled", "true");
    });
    click(
      within(accessDialog).getByLabelText(
        "Authorize Acme MCP access for Research",
      ),
    );
    expect(authorizationUpdates).toHaveLength(1);
    click(within(accessDialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(
        within(connectorCardByLabel("Acme MCP")).queryByTestId(
          "connector-card-agent-access",
        ),
      ).not.toBeInTheDocument();
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));
    await waitFor(() => {
      expect(disconnectCount).toBe(1);
    });
    expect(screen.queryByLabelText("Connect Acme MCP")).not.toBeInTheDocument();

    click(screen.getByLabelText("More options"));
    await expect(screen.findByText("Delete")).resolves.toBeInTheDocument();
    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    expect(screen.queryByText("Edit")).not.toBeInTheDocument();
  });

  it("refreshes the cached custom connector list after a realtime create event", async () => {
    let connectors: CustomConnectorHttpResponse[] = [];
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors });
    });

    detachedSetupPage({ context, path: "/connectors?tab=custom" });

    const emptyState = await screen.findByText(
      "No custom connectors yet. Create one to register an API for every member to use.",
    );
    expect(emptyState).toBeInTheDocument();
    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("customConnectorListChanged"),
      ).toBeTruthy();
    });
    click(tabByText("Built-in"));

    connectors = [customConnector({ slug: "_acme-search" })];
    context.mocks.ably.trigger("customConnectorListChanged");
    click(tabByText("Custom"));

    await waitFor(() => {
      expect(connectorCardByLabel("Acme Search")).toBeInTheDocument();
    });
  });

  it("localizes the custom connector OAuth entry flow in Portuguese", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000033";
    const connector = customConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    });
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.userPreferences({ locale: "pt-BR" });
    context.mocks.data.agents([listAgent(researchAgentId, "Research")]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        grants: [{ customConnectorId: connector.id, permissionNames: [] }],
      });
    });

    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
    });

    await waitFor(() => {
      const card = connectorCardByLabel("Acme Search");
      expect(within(card).getByText("Conectado")).toBeInTheDocument();
      expect(
        within(card).getByTestId("connector-card-agent-access"),
      ).toHaveTextContent("Usado por Research");
    });

    click(await screen.findByText("Novo conector"));
    const createDialog = await screen.findByRole("dialog", {
      name: "Novo conector personalizado",
    });
    expect(
      within(createDialog).getByLabelText("Nome de exibição"),
    ).toBeInTheDocument();
    expect(within(createDialog).getByLabelText("Fechar")).toBeInTheDocument();

    click(buttonByText("Adicionar autenticação", createDialog));
    click(menuItemByText("OAuth 2.0"));

    expect(
      within(createDialog).getByText(
        "Configure um app OAuth para os membros autorizarem.",
      ),
    ).toBeInTheDocument();
    expect(
      within(createDialog).getByLabelText("URL do token"),
    ).toBeInTheDocument();
    expect(
      within(createDialog).getByLabelText("ID do cliente"),
    ).toBeInTheDocument();
    expect(
      within(createDialog).getByText("Configurações avançadas"),
    ).toBeInTheDocument();
    expect(within(createDialog).getByLabelText("PKCE")).toHaveTextContent(
      "Nenhum",
    );
  });

  it("hides an integration-managed Feishu connector from custom settings", async () => {
    let authorizationReads = 0;
    const connector = customConnector({
      slug: "_feishu-00000000-0000-4000-8000-000000000044",
      displayName: "Feishu",
      prefixTemplates: ["https://open.feishu.cn/open-apis/"],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      authMode: "oauth",
      permissionBundleRef: "builtin:feishu@1",
      oauthConfig: {
        providerAdapter: "feishu",
        clientId: "cli_feishu",
        authorizationUrl:
          "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
        tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: ["offline_access", "im:message"],
        authorizationParams: {},
      },
      missingRequiredFields: ["oauth"],
    });
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      authorizationReads += 1;
      return respond(200, { grants: [] });
    });

    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
    });

    await expect(
      screen.findByText(
        "No custom connectors yet. Create one to register an API for every member to use.",
      ),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Feishu")).not.toBeInTheDocument();
    expect(authorizationReads).toBe(0);
  });

  it("configures OAuth app credentials at creation and authorizes on connect", async () => {
    const defaultAgentId = "c0000000-0000-4000-a000-000000000001";
    const researchAgentId = "c0000000-0000-4000-a000-000000000041";
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.data.agents([
      listAgent(defaultAgentId, "Zero"),
      listAgent(researchAgentId, "Research"),
    ]);
    const createdBodies: CreateCustomConnectorBody[] = [];
    const updatedBodies: UpdateCustomConnectorBody[] = [];
    let oauthStartCount = 0;
    let connector: CustomConnectorHttpResponse | null = null;
    const authWindow = createMockAuthWindow();
    const browserOpen = context.mocks.browser.open(authWindow);
    const clipboard = context.mocks.browser.clipboardWriteText();

    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: connector ? [connector] : [] });
    });
    context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
      createdBodies.push(body);
      connector = customConnector({
        displayName: body.displayName,
        prefixTemplates: body.prefixTemplates ?? [],
        fields: body.fields ?? [],
        headerInjections: body.headerInjections ?? [],
        queryInjections: body.queryInjections ?? [],
        authMode: body.authMode,
        storageVersion: body.storageVersion,
        ...(body.oauthConfig
          ? {
              oauthConfig: publicCustomConnectorOAuthConfig(body.oauthConfig),
            }
          : {}),
      });
      return respond(201, connector);
    });
    context.mocks.api(
      customConnectorByIdContract.update,
      ({ params, body, respond }) => {
        expect(params.id).toBe(connector?.id);
        updatedBodies.push(body);
        if (body.kind === "mcp") {
          throw new Error("Expected an HTTP custom connector update");
        }
        if (!connector) {
          throw new Error("Expected custom connector to exist");
        }
        connector = {
          ...connector,
          displayName: body.displayName,
          prefixTemplates: body.prefixTemplates,
          fields: body.fields,
          headerInjections: body.headerInjections,
          queryInjections: body.queryInjections,
          authMode: body.authMode ?? connector.authMode,
          storageVersion: body.storageVersion ?? connector.storageVersion,
          ...(body.oauthConfig
            ? {
                oauthConfig: publicCustomConnectorOAuthConfig(body.oauthConfig),
              }
            : {}),
        };
        return respond(200, connector);
      },
    );
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      ({ params, body, respond }) => {
        expect(params.id).toBe(connector?.id);
        expect(body).toStrictEqual({
          account: { intent: "single-account" },
        });
        oauthStartCount += 1;
        if (!connector) {
          throw new Error("Expected custom connector to exist");
        }
        connector = {
          ...connector,
          connected: true,
          missingRequiredFields: [],
        };
        authWindow.close();
        return respond(200, {
          authorizationUrl: "https://oauth.acme.test/authorize?state=ui-test",
        });
      },
    );

    detachedSetupPage({
      context,
      path: "/connectors",
      featureSwitches: {},
    });

    click(await screen.findByText("Custom"));
    click(await screen.findByText("New connector"));

    const createDialog = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    await fill(within(createDialog).getByLabelText("Display name"), "Acme API");
    await fill(
      within(createDialog).getByLabelText(/Prefixes/u),
      "https://api.acme.test/v1/",
    );

    expect(
      context.store.get(customConnectorCreateForm$).authMethodTypes,
    ).toStrictEqual([]);
    expect(
      within(createDialog).queryByText("API authentication"),
    ).not.toBeInTheDocument();
    expect(buttonByText("Create", createDialog)).toBeDisabled();

    click(buttonByText("Add authentication", createDialog));
    click(menuItemByText("OAuth 2.0"));
    await waitFor(() => {
      expect(
        context.store.get(customConnectorCreateForm$).authMethodTypes,
      ).toStrictEqual(["oauth2"]);
    });
    await fill(
      within(createDialog).getByLabelText("Token URL"),
      "https://oauth.acme.test/token",
    );
    await fill(
      within(createDialog).getByLabelText("Client ID"),
      "connector-oauth-client-id",
    );
    await fill(
      within(createDialog).getByLabelText("Client secret"),
      "connector-oauth-client-secret",
    );
    await fill(
      within(createDialog).getByLabelText(/Scopes/u),
      "search.read\nsearch.write",
    );
    const advancedSettingsLabel =
      within(createDialog).getByText("Advanced settings");
    const advancedSettings = advancedSettingsLabel.closest("details");
    if (!(advancedSettings instanceof HTMLDetailsElement)) {
      throw new Error("Expected OAuth advanced settings disclosure");
    }
    expect(advancedSettings.open).toBeFalsy();
    click(advancedSettingsLabel);
    expect(advancedSettings.open).toBeTruthy();
    click(within(createDialog).getByLabelText("PKCE"));
    click(await screen.findByRole("option", { name: "S256" }));
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    await fill(
      within(createDialog).getByLabelText(/Resource/u),
      "https://api.acme.test",
    );
    await fill(within(createDialog).getByLabelText(/Audience/u), "acme-api");
    await fill(within(createDialog).getByLabelText(/Access type/u), "offline");
    await fill(within(createDialog).getByLabelText(/Prompt/u), "consent");
    await fill(
      within(createDialog).getByLabelText("Authorization URL"),
      "https://oauth.acme.test/authorize",
    );
    const redirectUrlInput = within(createDialog).getByLabelText(
      /^Redirect URL/u,
      {
        selector: "input",
      },
    );
    if (!(redirectUrlInput instanceof HTMLInputElement)) {
      throw new Error("Expected custom connector redirect URL input");
    }
    const redirectUrl = new URL(redirectUrlInput.value);
    expect(redirectUrl.origin).toBe(window.location.origin);
    expect(redirectUrl.pathname).toBe("/connectors/custom/callback");
    click(within(createDialog).getByLabelText("Copy Redirect URL"));
    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([redirectUrlInput.value]);
    });

    const createButton = buttonByText("Create", createDialog);
    expect(context.store.get(customConnectorCreateForm$)).toMatchObject({
      displayName: "Acme API",
      prefixesRaw: "https://api.acme.test/v1/",
      authMethodTypes: ["oauth2"],
      oauthAuthorizationUrl: "https://oauth.acme.test/authorize",
      oauthTokenUrl: "https://oauth.acme.test/token",
      oauthClientId: "connector-oauth-client-id",
      oauthClientSecret: "connector-oauth-client-secret",
      oauthPkceMethod: "S256",
      oauthResource: "https://api.acme.test",
      oauthAudience: "acme-api",
      oauthAccessType: "offline",
      oauthPrompt: "consent",
    });
    expect(createButton).toBeEnabled();
    click(createButton);
    await waitFor(() => {
      expect(createdBodies).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.getByText("Acme API")).toBeInTheDocument();
    });
    expect(createdBodies).toHaveLength(1);
    expect(createdBodies[0]).toMatchObject({
      displayName: "Acme API",
      storageVersion: 1,
      prefixTemplates: ["https://api.acme.test/v1/"],
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "connector-oauth-client-id",
        clientSecret: "connector-oauth-client-secret",
        authorizationUrl: "https://oauth.acme.test/authorize",
        tokenUrl: "https://oauth.acme.test/token",
        scopes: ["search.read", "search.write"],
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        authorizationParams: {
          resource: "https://api.acme.test",
          audience: "acme-api",
          access_type: "offline",
          prompt: "consent",
        },
      },
    });

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Edit"));
    const editDialog = await screen.findByRole("dialog", {
      name: "Edit custom connector",
    });
    expect(within(editDialog).getByLabelText("Authorization URL")).toHaveValue(
      "https://oauth.acme.test/authorize",
    );
    expect(within(editDialog).getByLabelText("Client ID")).toHaveValue(
      "connector-oauth-client-id",
    );
    expect(within(editDialog).getByLabelText("New client secret")).toHaveValue(
      "",
    );
    expect(within(editDialog).getByLabelText(/Scopes/u)).toHaveValue(
      "search.read\nsearch.write",
    );
    expect(within(editDialog).getByLabelText("PKCE")).toHaveTextContent("S256");
    expect(within(editDialog).getByLabelText(/Resource/u)).toHaveValue(
      "https://api.acme.test",
    );
    expect(within(editDialog).getByLabelText(/Audience/u)).toHaveValue(
      "acme-api",
    );
    expect(within(editDialog).getByLabelText(/Access type/u)).toHaveValue(
      "offline",
    );
    expect(within(editDialog).getByLabelText(/Prompt/u)).toHaveValue("consent");
    await fill(
      within(editDialog).getByLabelText(/Prefixes/u),
      "https://api.acme.test/v2/",
    );
    await fill(
      within(editDialog).getByLabelText(/Scopes/u),
      "search.read\ncalendar.write",
    );
    click(buttonByText("Save", editDialog));
    const confirmationDialog = await screen.findByRole("dialog", {
      name: "Disconnect existing OAuth connections?",
    });
    expect(updatedBodies).toHaveLength(0);
    expect(
      within(confirmationDialog).getByText(
        /disconnect every member currently connected with OAuth/u,
      ),
    ).toBeInTheDocument();
    expect(editDialog).toBeInTheDocument();
    click(buttonByText("Save and disconnect", confirmationDialog));
    await waitFor(() => {
      expect(updatedBodies).toHaveLength(1);
    });
    expect(screen.getByText("https://api.acme.test/v2/")).toBeInTheDocument();
    expect(updatedBodies[0]).toMatchObject({
      displayName: "Acme API",
      storageVersion: 2,
      prefixTemplates: ["https://api.acme.test/v2/"],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "connector-oauth-client-id",
        authorizationUrl: "https://oauth.acme.test/authorize",
        tokenUrl: "https://oauth.acme.test/token",
        scopes: ["search.read", "calendar.write"],
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        authorizationParams: {
          resource: "https://api.acme.test",
          audience: "acme-api",
          access_type: "offline",
          prompt: "consent",
        },
      },
    });
    expect(updatedBodies[0]?.oauthConfig).not.toHaveProperty("clientSecret");

    const connectorCardButton = buttonByAriaLabel("Connect Acme API");
    expect(
      within(connectorCardButton).queryByText("Connect"),
    ).not.toBeInTheDocument();
    click(connectorCardButton);
    expect(document.querySelector('[role="dialog"]')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.acme.test/authorize?state=ui-test",
      );
      const card = connectorCardByLabel("Acme API");
      expect(within(card).getByText("Connected")).toBeInTheDocument();
      expect(
        within(card).getByTestId("connector-card-agent-access"),
      ).toHaveTextContent("Used by 2 agents");
    });
    expect(browserOpen.calls).toStrictEqual([
      {
        url: "about:blank",
        target: "_blank",
        features: "width=600,height=700",
      },
    ]);
    expect(oauthStartCount).toBe(1);
  });

  it("updates custom connector access eligibility while the dialog is open", async () => {
    const researchAgentId = "c0000000-0000-4000-a000-000000000051";
    const supportAgentId = "c0000000-0000-4000-a000-000000000052";
    const connector = customConnector({
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    });
    context.mocks.data.agents([
      listAgent(researchAgentId, "Research"),
      listAgent(supportAgentId, "Support"),
    ]);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        const grants: AgentCustomConnectorGrant[] =
          params.id === researchAgentId
            ? [{ customConnectorId: connector.id, permissionNames: [] }]
            : [];
        return respond(200, { grants });
      },
    );
    let summariesRequestStarted = false;
    let resolveSummaries = (): void => {
      throw new Error("Account summaries request did not start");
    };
    context.mocks.api(
      connectorAccountsContract.summaries,
      async ({ deferred, respond }) => {
        const summariesDeferred = deferred<void>();
        resolveSummaries = () => {
          summariesDeferred.resolve();
        };
        summariesRequestStarted = true;
        await summariesDeferred.promise;
        return respond(200, {
          summaries: [
            {
              target: {
                kind: "custom",
                customConnectorId: connector.id,
              },
              accountCount: 1,
              attentionCount: 0,
              defaultConnection: null,
            },
          ],
        });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    await waitFor(() => {
      expect(summariesRequestStarted).toBeTruthy();
      expect(
        screen.getByLabelText("Manage Acme Search access"),
      ).toBeInTheDocument();
    });
    click(screen.getByLabelText("Manage Acme Search access"));
    const accessDialog = await screen.findByRole("dialog", {
      name: "Manage Acme Search access",
    });
    const supportAccessSwitch = within(accessDialog).getByLabelText(
      "Authorize Acme Search access for Support",
    );
    expect(supportAccessSwitch).toHaveAttribute("aria-disabled", "true");

    resolveSummaries();

    await waitFor(() => {
      expect(supportAccessSwitch).not.toHaveAttribute("aria-disabled", "true");
    });
  });

  it.each([
    { label: "HTTP", connector: customConnector({}) },
    { label: "MCP", connector: mcpCustomConnector({ connected: false }) },
  ])(
    "adds a custom $label account and offers optional post-connect naming",
    async ({ connector: initialConnector }) => {
      let connector: CustomConnectorResponse = initialConnector;
      let account: ConnectorAccountConnection | null = null;
      const connectionId = crypto.randomUUID();
      let submittedAccount: unknown;
      let grantMutationCount = 0;
      context.mocks.api(customConnectorsContract.list, ({ respond }) => {
        return respond(200, { connectors: [connector] });
      });
      context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
        return respond(200, {
          summaries: account
            ? [
                {
                  target: account.target,
                  accountCount: 1,
                  attentionCount: 0,
                  defaultConnection: account,
                },
              ]
            : [],
        });
      });
      context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
        return account
          ? respond(200, account)
          : respond(404, {
              error: {
                message: "Connector account not found",
                code: "NOT_FOUND",
              },
            });
      });
      context.mocks.api(
        customConnectorValuesContract.set,
        ({ body, respond }) => {
          submittedAccount = body.account;
          connector = {
            ...connector,
            connected: true,
            missingRequiredFields: [],
            configuredFieldKeys: ["secret"],
          };
          account = {
            id: connectionId,
            target: {
              kind: "custom",
              customConnectorId: connector.id,
            },
            authMethod: "manual",
            displayName:
              body.account.intent === "add"
                ? (body.account.displayName ?? null)
                : null,
            isDefault: true,
            externalId: null,
            externalUsername: null,
            externalEmail: null,
            oauthScopes: null,
            connectionStatus: "connected",
            reconnectReason: null,
            tokenExpiresAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          };
          return respond(200, {
            ...connector,
            connectedAccountId: account.id,
          });
        },
      );
      context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
        grantMutationCount += 1;
        return respond(200, { grants: [] });
      });
      detachedSetupPage({
        context,
        path: "/connectors?tab=custom",
        featureSwitches: {
          [FeatureSwitchKey.ConnectorAccounts]: true,
          [FeatureSwitchKey.CustomConnectorMcp]: true,
        },
      });

      click(await screen.findByLabelText(`Connect ${connector.displayName}`));
      const dialog = await screen.findByRole("dialog", {
        name: `Connect ${connector.displayName}`,
      });
      await fill(within(dialog).getByLabelText("Secret"), "custom-secret");
      expect(buttonByText("Save", dialog)).toBeEnabled();
      click(buttonByText("Save", dialog));

      const nameDialog = await screen.findByRole("dialog", {
        name: `Name your ${connector.displayName} account`,
      });
      expect(within(nameDialog).getByLabelText("Account name")).toHaveAttribute(
        "placeholder",
        `Account #${connectionId.slice(0, 8)}`,
      );
      click(buttonByText("Skip", nameDialog));
      await waitFor(() => {
        expect(
          within(connectorCardByLabel(connector.displayName)).getByText(
            `Account #${connectionId.slice(0, 8)}`,
          ),
        ).toBeInTheDocument();
      });
      expect(submittedAccount).toStrictEqual({ intent: "add" });
      expect(grantMutationCount).toBe(0);
    },
  );

  it("requires every field for a new custom account independently of the default account", async () => {
    const connector = customConnector({
      connected: true,
      fields: [
        {
          key: "secret",
          label: "Secret",
          kind: "secret",
          required: true,
        },
        {
          key: "subdomain",
          label: "Subdomain",
          kind: "variable",
          required: true,
        },
      ],
      configuredFieldKeys: ["secret", "subdomain"],
      missingRequiredFields: [],
    });
    const existingAccount = {
      id: crypto.randomUUID(),
      target: { kind: "custom" as const, customConnectorId: connector.id },
      authMethod: "manual",
      displayName: "Existing",
      isDefault: true,
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ConnectorAccountConnection;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: existingAccount.target,
            accountCount: 1,
            attentionCount: 0,
            defaultConnection: existingAccount,
          },
        ],
      });
    });
    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(
      await waitForButtonByAriaLabel(
        `Manage ${connector.displayName} accounts`,
      ),
    );
    const manager = await screen.findByRole("dialog", {
      name: connector.displayName,
    });
    click(buttonByText("Add account", manager));
    const dialog = await screen.findByRole("dialog", {
      name: `Connect ${connector.displayName}`,
    });
    expect(dialog).not.toHaveTextContent("Configured");
    await fill(within(dialog).getByLabelText("Secret"), "account-secret");
    expect(buttonByText("Save", dialog)).toBeDisabled();
    await fill(within(dialog).getByLabelText("Subdomain"), "work");
    expect(buttonByText("Save", dialog)).toBeEnabled();
  });

  it("allows partial values when reconnecting a custom account", async () => {
    const connector = customConnector({
      connected: true,
      fields: [
        {
          key: "secret",
          label: "Secret",
          kind: "secret",
          required: true,
        },
        {
          key: "subdomain",
          label: "Subdomain",
          kind: "variable",
          required: true,
        },
      ],
      configuredFieldKeys: ["secret", "subdomain"],
      missingRequiredFields: [],
    });
    const existingAccount = {
      id: crypto.randomUUID(),
      target: { kind: "custom" as const, customConnectorId: connector.id },
      authMethod: "manual",
      displayName: "Existing",
      isDefault: true,
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ConnectorAccountConnection;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: existingAccount.target,
            accountCount: 1,
            attentionCount: 0,
            defaultConnection: existingAccount,
          },
        ],
      });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, {
        connections: [existingAccount],
        nextCursor: null,
      });
    });
    let submittedAccount: unknown;
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ body, respond }) => {
        submittedAccount = body.account;
        return respond(200, {
          ...connector,
          connectedAccountId: existingAccount.id,
        });
      },
    );
    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(
      await waitForButtonByAriaLabel(
        `Manage ${connector.displayName} accounts`,
      ),
    );
    const manager = await screen.findByRole("dialog", {
      name: connector.displayName,
    });
    const defaultGroup = within(manager).getByRole("group", {
      name: "Default",
    });
    expect(within(defaultGroup).getByText("Existing")).toBeInTheDocument();
    click(within(defaultGroup).getByLabelText("Account actions"));
    click(menuItemByText("Reconnect"));
    const dialog = await screen.findByRole("dialog", {
      name: `Connect ${connector.displayName}`,
    });
    expect(dialog).not.toHaveTextContent("Configured");
    await fill(within(dialog).getByLabelText("Secret"), "new-secret");
    expect(buttonByText("Save", dialog)).toBeEnabled();
    click(buttonByText("Save", dialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: `Connect ${connector.displayName}`,
        }),
      ).toBeNull();
    });
    expect(
      screen.queryByRole("dialog", {
        name: `Name your ${connector.displayName} account`,
      }),
    ).toBeNull();
    expect(submittedAccount).toStrictEqual({
      intent: "reconnect",
      connectionId: existingAccount.id,
    });
  });

  it("keeps MCP account connection actions disabled with the MCP feature off", async () => {
    const connector = mcpCustomConnector({ connected: true });
    const account = {
      id: crypto.randomUUID(),
      target: { kind: "custom" as const, customConnectorId: connector.id },
      authMethod: "manual",
      displayName: "Work",
      isDefault: true,
      externalId: null,
      externalUsername: null,
      externalEmail: null,
      oauthScopes: null,
      connectionStatus: "connected" as const,
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ConnectorAccountConnection;
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: account.target,
            accountCount: 1,
            attentionCount: 0,
            defaultConnection: account,
          },
        ],
      });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, { connections: [account], nextCursor: null });
    });
    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: {
        [FeatureSwitchKey.ConnectorAccounts]: true,
        [FeatureSwitchKey.CustomConnectorMcp]: false,
      },
    });

    click(await waitForButtonByAriaLabel("Manage Acme MCP accounts"));

    const manager = await screen.findByRole("dialog", {
      name: "Acme MCP",
    });
    expect(buttonByText("Add account", manager)).toBeDisabled();
    click(within(manager).getByLabelText("Account actions"));
    expect(queryMenuItemByText("Reconnect")).toBeNull();
    expect(menuItemByText("Rename")).toBeInTheDocument();
  });

  it("confirms an exact custom OAuth addition and offers optional naming", async () => {
    let connector: CustomConnectorHttpResponse = customConnector({
      fields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      authMode: "oauth",
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "acme-client",
        authorizationUrl: "https://oauth.acme.test/authorize",
        tokenUrl: "https://oauth.acme.test/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "none",
        scopes: ["search.read"],
        authorizationParams: {},
      },
      missingRequiredFields: ["oauth"],
    });
    let account: ConnectorAccountConnection | null = null;
    const connectionId = crypto.randomUUID();
    let submittedAccount: unknown;
    let grantMutationCount = 0;
    const authWindow = createMockAuthWindow();
    context.mocks.browser.open(authWindow);
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: account
          ? [
              {
                target: account.target,
                accountCount: 1,
                attentionCount: 0,
                defaultConnection: account,
              },
            ]
          : [],
      });
    });
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      ({ body, respond }) => {
        submittedAccount = body.account;
        connector = {
          ...connector,
          connected: true,
          missingRequiredFields: [],
        };
        account = {
          id: connectionId,
          target: { kind: "custom", customConnectorId: connector.id },
          authMethod: "oauth",
          displayName:
            body.account.intent === "add"
              ? (body.account.displayName ?? null)
              : null,
          isDefault: true,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: ["search.read"],
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        authWindow.close();
        return respond(200, {
          authorizationUrl: "https://oauth.acme.test/authorize?state=test",
          connectionId,
        });
      },
    );
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, respond }) => {
        return params.connectionId === account?.id && account
          ? respond(200, account)
          : respond(404, {
              error: { message: "Account not found", code: "NOT_FOUND" },
            });
      },
    );
    context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
      grantMutationCount += 1;
      return respond(200, { grants: [] });
    });
    detachedSetupPage({
      context,
      path: "/connectors?tab=custom",
      featureSwitches: { [FeatureSwitchKey.ConnectorAccounts]: true },
    });

    click(await screen.findByLabelText(`Connect ${connector.displayName}`));

    const nameDialog = await screen.findByRole("dialog", {
      name: `Name your ${connector.displayName} account`,
    });
    click(buttonByText("Skip", nameDialog));
    await waitFor(() => {
      expect(
        within(connectorCardByLabel(connector.displayName)).getByText(
          `Account #${connectionId.slice(0, 8)}`,
        ),
      ).toBeInTheDocument();
    });
    expect(submittedAccount).toStrictEqual({ intent: "add" });
    expect(grantMutationCount).toBe(0);
  });

  it("manages a custom connector from creation through deletion", async () => {
    const defaultAgentId = "c0000000-0000-4000-a000-000000000001";
    const researchAgentId = "c0000000-0000-4000-a000-000000000051";
    const supportAgentId = "c0000000-0000-4000-a000-000000000052";
    const story = mockCustomConnectorStory();
    context.mocks.data.agents([
      listAgent(defaultAgentId, "Zero"),
      listAgent(researchAgentId, "Research"),
      listAgent(supportAgentId, "Support"),
    ]);

    detachedSetupPage({
      context,
      path: "/connectors",
    });

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
    click(buttonByText("Add authentication", createDialog));
    click(menuItemByText("API authentication"));
    click(buttonByText("Create", createDialog));

    await waitFor(() => {
      const card = connectorCardByLabel("Acme API");
      expect(
        within(card).getByText("https://api.acme.test/v1/"),
      ).toBeInTheDocument();
      expect(within(card).getByText("Not connected")).toBeInTheDocument();
    });
    expect(story.createBodies[0]?.storageVersion).toBe(1);

    const connectorCardButton = buttonByAriaLabel("Connect Acme API");
    expect(
      within(connectorCardButton).queryByText("Connect"),
    ).not.toBeInTheDocument();
    click(connectorCardButton);

    const connectDialog = await screen.findByRole("dialog");
    expect(
      within(connectDialog).getByText("Connect Acme API"),
    ).toBeInTheDocument();
    await fill(within(connectDialog).getByLabelText("Secret"), "acme-secret");
    click(buttonByText("Save", connectDialog));

    await waitFor(() => {
      const card = connectorCardByLabel("Acme API");
      expect(within(card).getByText("Connected")).toBeInTheDocument();
      expect(
        within(card).getByTestId("connector-card-agent-access"),
      ).toHaveTextContent("Used by 3 agents");
    });
    expect(
      within(connectorCardByLabel("Acme API")).getByTestId(
        "connector-card-agent-access",
      ),
    ).not.toHaveAttribute("title");
    expect(
      within(connectorCardByLabel("Acme API")).getByText(
        "https://api.acme.test/v1/",
      ),
    ).toBeInTheDocument();

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Edit"));

    const editDialog = await screen.findByRole("dialog", {
      name: "Edit custom connector",
    });
    await fill(
      within(editDialog).getByLabelText("Display name"),
      "Acme Billing API",
    );
    click(buttonByText("Save", editDialog));

    await waitFor(() => {
      expect(screen.getByText("Acme Billing API")).toBeInTheDocument();
    });
    expect(story.updateBodies[0]?.storageVersion).toBe(1);

    click(screen.getByLabelText("More options"));
    click(await screen.findByText("Disconnect"));

    await waitFor(() => {
      expect(buttonByAriaLabel("Connect Acme Billing API")).toBeInTheDocument();
      expect(
        within(connectorCardByLabel("Acme Billing API")).queryByTestId(
          "connector-card-agent-access",
        ),
      ).not.toBeInTheDocument();
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
