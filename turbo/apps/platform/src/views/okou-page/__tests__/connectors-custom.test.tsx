import {
  type AgentCustomConnectorGrant,
  type AgentCustomConnectorGrants,
  type AgentCustomConnectorUpdate,
  agentCustomConnectorsContract,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  type ConnectorAccountConnection,
  connectorAccountsContract,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  type CreateCustomConnectorBody,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
  type CustomConnectorResponse,
  type UpdateCustomConnectorBody,
  customConnectorByIdContract,
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  getConnectorAction,
  getConnectorCard,
  getConnectorSwitch,
  listAgent,
  mcpCustomConnector,
  mockCustomConnectorStory,
  queryConnectorAction,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const RESEARCH_ID = "c0000000-0000-4000-a000-000000000051";
const SUPPORT_ID = "c0000000-0000-4000-a000-000000000052";

function setupCustomPage(
  options: {
    readonly accounts?: boolean;
    readonly mcp?: boolean;
  } = {},
): Promise<void> {
  context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
  return setupPage({
    context,
    path: "/connectors?tab=custom",
    featureSwitches: {
      [FeatureSwitchKey.ConnectorAccounts]: options.accounts ?? false,
      [FeatureSwitchKey.CustomConnectorMcp]: options.mcp ?? false,
    },
  });
}

function createAuthWindow(): Window {
  const authWindow = context.mocks.browser.authWindow();
  Object.defineProperty(authWindow, "location", {
    configurable: true,
    value: { href: "" },
  });
  return authWindow;
}

function publicOAuthConfig(
  config: NonNullable<CreateCustomConnectorBody["oauthConfig"]>,
) {
  const { clientSecret: _clientSecret, ...publicConfig } = config;
  return publicConfig;
}

function customAccount(
  connectorId: string,
  connectionId: string,
  overrides: Partial<ConnectorAccountConnection> = {},
): ConnectorAccountConnection {
  return {
    id: connectionId,
    target: { kind: "custom", customConnectorId: connectorId },
    authMethod: "manual",
    displayName: null,
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
    ...overrides,
  };
}

function accountAction(container: ParentNode): HTMLElement {
  const action = queryAllByRoleFast("button", container).find((button) => {
    return button.getAttribute("aria-label") === "Account actions";
  });
  if (!action) {
    throw new Error("Expected account actions");
  }
  return action;
}

test("Create a custom connector without authentication", async () => {
  mockCustomConnectorStory(context);

  await setupCustomPage();

  click(
    await waitFor(() => {
      return getConnectorAction("button", "New connector");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  click(getConnectorAction("button", "Add authentication", dialog));

  expect(
    getConnectorAction("menuitem", "No authentication"),
  ).toBeInTheDocument();
});

test("Add and optionally name a custom connector account", async () => {
  let connectors: CustomConnectorResponse[] = [
    customConnector(),
    mcpCustomConnector({
      id: "55555555-5555-4555-8555-555555555555",
      displayName: "Acme MCP",
      connected: false,
      missingRequiredFields: ["secret"],
      configuredFieldKeys: [],
    }),
  ];
  const accounts = new Map<string, ConnectorAccountConnection>();
  let grantMutations = 0;
  context.mocks.data.agents([listAgent(RESEARCH_ID, "Research")]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      grants: connectors.map((connector) => {
        return {
          customConnectorId: connector.id,
          permissionNames: [],
        };
      }),
    });
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [...accounts.values()].map((account) => {
        return {
          target: account.target,
          accountCount: 1,
          attentionCount: 0,
          defaultConnection: account,
        };
      }),
    });
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = accounts.get(params.connectionId);
      return account
        ? respond(200, account)
        : respond(404, {
            error: { message: "Account not found", code: "NOT_FOUND" },
          });
    },
  );
  context.mocks.api(
    customConnectorValuesContract.set,
    ({ params, body, respond }) => {
      const connector = connectors.find((candidate) => {
        return candidate.id === params.id;
      });
      if (!connector) {
        throw new Error("Expected custom connector");
      }
      const connectionId = crypto.randomUUID();
      const account = customAccount(connector.id, connectionId);
      accounts.set(connectionId, account);
      connectors = connectors.map((candidate) => {
        return candidate.id === connector.id
          ? {
              ...candidate,
              connected: true,
              connectedAccountId: connectionId,
              missingRequiredFields: [],
              configuredFieldKeys: body.values.map((value) => {
                return value.key;
              }),
            }
          : candidate;
      });
      return respond(
        200,
        connectors.find((candidate) => {
          return candidate.id === connector.id;
        })!,
      );
    },
  );
  context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
    grantMutations += 1;
    return respond(200, { grants: [] });
  });
  await setupCustomPage({ accounts: true, mcp: true });

  for (const name of ["Acme Search", "Acme MCP"]) {
    click(
      await waitFor(() => {
        return getConnectorAction("button", `Connect ${name}`);
      }),
    );
    const connect = await screen.findByRole("dialog", {
      name: `Connect ${name}`,
    });
    await fill(within(connect).getByLabelText("Secret"), "custom-secret");
    click(getConnectorAction("button", "Save", connect));
    const naming = await screen.findByRole("dialog", {
      name: `Name your ${name} account`,
    });
    const placeholder = within(naming)
      .getByLabelText("Account name")
      .getAttribute("placeholder");
    expect(placeholder).toMatch(/^Account #[\da-f]{8}$/u);
    click(getConnectorAction("button", "Skip", naming));
    await expect(
      within(getConnectorCard(name)).findByText(placeholder ?? ""),
    ).resolves.toBeInTheDocument();
    expect(
      getConnectorAction(
        "button",
        `Manage ${name} access`,
        getConnectorCard(name),
      ),
    ).toHaveTextContent("Used by Research");
  }
  expect(grantMutations).toBe(0);
});

test("Enable custom connector access when an account becomes available", async () => {
  const connector = customConnector({
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
  });
  context.mocks.data.agents([
    listAgent(RESEARCH_ID, "Research"),
    listAgent(SUPPORT_ID, "Support"),
  ]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      const grants: AgentCustomConnectorGrant[] =
        params.id === RESEARCH_ID
          ? [{ customConnectorId: connector.id, permissionNames: [] }]
          : [];
      return respond(200, { grants });
    },
  );
  const summariesReady = context.mocks.deferred<void>();
  context.mocks.api(
    connectorAccountsContract.summaries,
    async ({ respond }) => {
      await summariesReady.promise;
      return respond(200, {
        summaries: [
          {
            target: { kind: "custom", customConnectorId: connector.id },
            accountCount: 1,
            attentionCount: 0,
            defaultConnection: null,
          },
        ],
      });
    },
  );
  await setupCustomPage({ accounts: true });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Acme Search access");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage Acme Search access",
  });
  const support = await waitFor(() => {
    return getConnectorSwitch(
      "Authorize Acme Search access for Support",
      dialog,
    );
  });
  expect(support).toHaveAttribute("aria-disabled", "true");

  summariesReady.resolve();

  await waitFor(() => {
    expect(
      getConnectorSwitch("Authorize Acme Search access for Support", dialog),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
  click(getConnectorAction("button", "Close", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(
    getConnectorAction("button", "Manage Acme Search accounts"),
  ).toBeInTheDocument();
  expect(
    getConnectorAction("button", "Manage Acme Search access"),
  ).toBeInTheDocument();
});

test("Manage agent access and permissions for a custom connector", async () => {
  const connector = customConnector({
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
    permissionBundleRef: "builtin:feishu@1",
  });
  const access = new Map<string, AgentCustomConnectorGrants>([
    [RESEARCH_ID, { grants: [] }],
    [SUPPORT_ID, { grants: [] }],
  ]);
  const updates: {
    readonly agentId: string;
    readonly body: AgentCustomConnectorUpdate;
  }[] = [];
  context.mocks.data.agents([
    listAgent(RESEARCH_ID, "Research"),
    listAgent(SUPPORT_ID, "Support"),
  ]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(customConnectorByIdContract.permissions, ({ respond }) => {
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
  });
  context.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, access.get(params.id) ?? { grants: [] });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ params, body, respond }) => {
      updates.push({ agentId: params.id, body });
      const next = body.operation === "remove" ? [] : body.grants;
      const grants = { grants: next };
      access.set(params.id, grants);
      return respond(200, grants);
    },
  );
  await setupCustomPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Acme Search access");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Manage Acme Search access",
  });

  click(
    await waitFor(() => {
      return getConnectorSwitch(
        "Authorize Acme Search access for Support",
        dialog,
      );
    }),
  );
  const drawer = await screen.findByRole("dialog", {
    name: "Acme Search permissions for Support",
  });
  expect(within(drawer).getByText("messages:send-as-user")).toBeInTheDocument();
  click(getConnectorAction("button", "Allow", drawer));
  click(getConnectorAction("button", "Apply", drawer));
  await waitFor(() => {
    expect(
      getConnectorSwitch("Revoke Acme Search access for Support", dialog),
    ).toBeInTheDocument();
    expect(
      within(getConnectorCard("Acme Search")).getByTestId(
        "connector-card-agent-access",
      ),
    ).toHaveTextContent("Used by Support");
  });

  click(
    await waitFor(() => {
      return getConnectorAction(
        "button",
        "Manage Acme Search permissions for Support",
        dialog,
      );
    }),
  );
  const editedDrawer = await screen.findByRole("dialog", {
    name: "Acme Search permissions for Support",
  });
  expect(
    within(editedDrawer).getByText("messages:send-as-user"),
  ).toBeInTheDocument();
  click(getConnectorAction("button", "Deny", editedDrawer));
  click(getConnectorAction("button", "Apply", editedDrawer));
  await waitFor(() => {
    expect(updates.at(-1)?.body).toStrictEqual({
      grants: [{ customConnectorId: connector.id, permissionNames: [] }],
      operation: "add",
    });
    expect(
      getConnectorSwitch("Revoke Acme Search access for Support", dialog),
    ).toBeInTheDocument();
  });

  click(
    await waitFor(() => {
      return getConnectorSwitch(
        "Revoke Acme Search access for Support",
        dialog,
      );
    }),
  );
  await waitFor(() => {
    expect(
      getConnectorSwitch("Authorize Acme Search access for Support", dialog),
    ).toBeInTheDocument();
    expect(
      within(getConnectorCard("Acme Search")).getByTestId(
        "connector-card-agent-access",
      ),
    ).toHaveTextContent("Add access");
  });
});

test("Complete a custom connector’s declared fields", async () => {
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
      { key: "region", label: "Region", kind: "variable", required: false },
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
  let saved: readonly {
    readonly key: string;
    readonly kind: "secret" | "variable";
    readonly value: string;
  }[] = [];
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    saved = body.values;
    return respond(200, {
      ...connector,
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: ["api_token", "account_id", "backup_token"],
    });
  });
  await setupCustomPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Acme Multi Field");
    }),
  );
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
  expect(within(dialog).getByLabelText("API token")).toHaveValue("");
  expect(within(dialog).getByLabelText("Backup token")).toHaveValue("");
  expect(
    within(dialog).getByLabelText("Backup token"),
  ).toHaveAccessibleDescription("Optional · Configured");
  const save = getConnectorAction("button", "Save", dialog);
  expect(save).toBeDisabled();

  await fill(within(dialog).getByLabelText("API token"), "  xa at\n");
  expect(save).toBeDisabled();
  await fill(within(dialog).getByLabelText("Account ID"), "  Acme West  ");
  await fill(within(dialog).getByLabelText("Region"), "   ");
  expect(save).toBeEnabled();
  click(save);

  await waitFor(() => {
    expect(saved).toStrictEqual([
      { key: "api_token", kind: "secret", value: "xaat" },
      { key: "account_id", kind: "variable", value: "Acme West" },
    ]);
  });
});

test("Manage a custom HTTP connector through its lifecycle", async () => {
  mockCustomConnectorStory(context);
  context.mocks.data.agents([
    listAgent(RESEARCH_ID, "Research"),
    listAgent(SUPPORT_ID, "Support"),
  ]);
  await setupPage({ context, path: "/connectors" });
  click(
    await waitFor(() => {
      return getConnectorAction("tab", "Custom");
    }),
  );
  await expect(
    screen.findByText(
      "No custom connectors yet. Create one to register an API for every member to use.",
    ),
  ).resolves.toBeInTheDocument();

  click(getConnectorAction("button", "New connector"));
  const create = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(create).getByLabelText("Display name"), "Acme API");
  await fill(
    within(create).getByLabelText(/Prefixes/u),
    "https://api.acme.test/v1/",
  );
  click(getConnectorAction("button", "Add authentication", create));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "API authentication");
    }),
  );
  await waitFor(() => {
    expect(getConnectorAction("button", "Create", create)).toBeEnabled();
  });
  click(getConnectorAction("button", "Create", create));
  const card = await waitFor(() => {
    return getConnectorCard("Acme API");
  });
  expect(card).toHaveTextContent("HTTP API");
  expect(card).toHaveTextContent("https://api.acme.test/v1/");
  expect(card).toHaveTextContent("Not connected");

  click(getConnectorAction("button", "Connect Acme API", card));
  const connect = await screen.findByRole("dialog", {
    name: "Connect Acme API",
  });
  await fill(within(connect).getByLabelText("Secret"), "acme-secret");
  click(getConnectorAction("button", "Save", connect));
  await waitFor(() => {
    expect(getConnectorCard("Acme API")).toHaveTextContent("Connected");
    expect(
      getConnectorAction(
        "button",
        "Manage Acme API access",
        getConnectorCard("Acme API"),
      ),
    ).toHaveTextContent("Used by 2 agents");
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Edit");
    }),
  );
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await fill(within(edit).getByLabelText("Display name"), "Acme Billing API");
  click(getConnectorAction("button", "Save", edit));
  await expect(
    screen.findByText("Acme Billing API"),
  ).resolves.toBeInTheDocument();
  expect(getConnectorCard("Acme Billing API")).toHaveTextContent("Connected");
  expect(getConnectorCard("Acme Billing API")).toHaveTextContent(
    "https://api.acme.test/v1/",
  );

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  await waitFor(() => {
    expect(
      getConnectorAction("button", "Connect Acme Billing API"),
    ).toBeInTheDocument();
  });
  expect(
    queryConnectorAction(
      "button",
      "Manage Acme Billing API access",
      getConnectorCard("Acme Billing API"),
    ),
  ).toBeNull();

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Delete");
    }),
  );
  const deletion = await screen.findByRole("dialog");
  expect(deletion).toHaveTextContent("Delete Acme Billing API?");
  click(getConnectorAction("button", "Delete", deletion));

  await expect(
    screen.findByText(
      "No custom connectors yet. Create one to register an API for every member to use.",
    ),
  ).resolves.toBeInTheDocument();
});

test("Configure and maintain OAuth for a custom HTTP connector", async () => {
  let connector: CustomConnectorHttpResponse | null = null;
  const created: CreateCustomConnectorBody[] = [];
  const updated: UpdateCustomConnectorBody[] = [];
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.data.agents([listAgent(RESEARCH_ID, "Research")]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: connector ? [connector] : [] });
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    if (!body.oauthConfig || body.kind === "mcp") {
      throw new Error("Expected OAuth HTTP connector");
    }
    created.push(body);
    connector = customConnector({
      displayName: body.displayName,
      prefixTemplates: body.prefixTemplates ?? [],
      fields: body.fields ?? [],
      headerInjections: body.headerInjections ?? [],
      queryInjections: body.queryInjections ?? [],
      authMode: "oauth",
      oauthConfig: publicOAuthConfig(body.oauthConfig),
      missingRequiredFields: ["oauth"],
    });
    return respond(201, connector);
  });
  context.mocks.api(customConnectorByIdContract.update, ({ body, respond }) => {
    if (!connector || body.kind === "mcp" || !body.oauthConfig) {
      throw new Error("Expected OAuth HTTP connector update");
    }
    updated.push(body);
    const updatedConnector = customConnectorHttpResponseSchema.parse({
      ...connector,
      displayName: body.displayName,
      prefixTemplates: body.prefixTemplates,
      fields: body.fields,
      headerInjections: body.headerInjections,
      queryInjections: body.queryInjections,
      storageVersion: body.storageVersion ?? connector.storageVersion,
      oauthConfig: publicOAuthConfig(body.oauthConfig),
      connected: false,
      missingRequiredFields: ["oauth"],
    });
    connector = updatedConnector;
    return respond(200, updatedConnector);
  });
  context.mocks.api(
    customConnectorOAuth2Contract.start,
    ({ body, respond }) => {
      expect(body.account).toStrictEqual({ intent: "single-account" });
      if (!connector) {
        throw new Error("Expected OAuth connector");
      }
      connector = { ...connector, connected: true, missingRequiredFields: [] };
      authWindow.close();
      return respond(200, {
        authorizationUrl: "https://oauth.acme.test/authorize?state=ui-test",
      });
    },
  );
  await setupCustomPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "New connector");
    }),
  );
  const create = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  await fill(within(create).getByLabelText("Display name"), "Acme API");
  await fill(
    within(create).getByLabelText(/Prefixes/u),
    "https://api.acme.test/v1/",
  );
  click(getConnectorAction("button", "Add authentication", create));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "OAuth 2.0");
    }),
  );
  await fill(
    within(create).getByLabelText("Authorization URL"),
    "https://oauth.acme.test/authorize",
  );
  await fill(
    within(create).getByLabelText("Token URL"),
    "https://oauth.acme.test/token",
  );
  await fill(
    within(create).getByLabelText("Client ID"),
    "connector-oauth-client-id",
  );
  await fill(
    within(create).getByLabelText("Client secret"),
    "connector-oauth-client-secret",
  );
  await fill(
    within(create).getByLabelText(/Scopes/u),
    "search.read\nsearch.write",
  );
  click(within(create).getByText("Advanced settings"));
  click(within(create).getByLabelText("PKCE"));
  click(await screen.findByRole("option", { name: "S256" }));
  await fill(
    within(create).getByLabelText(/Resource/u),
    "https://api.acme.test",
  );
  await fill(within(create).getByLabelText(/Audience/u), "acme-api");
  await fill(within(create).getByLabelText(/Access type/u), "offline");
  await fill(within(create).getByLabelText(/Prompt/u), "consent");
  const redirect = within(create).getByLabelText(/^Redirect URL/u, {
    selector: "input",
  });
  expect(redirect).toHaveValue(
    `${window.location.origin}/connectors/custom/callback`,
  );
  click(getConnectorAction("button", "Copy Redirect URL", create));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([
      redirect.getAttribute("value") ?? "",
    ]);
  });
  expect(getConnectorAction("button", "Create", create)).toBeEnabled();

  click(getConnectorAction("button", "Create", create));

  const card = await waitFor(() => {
    return getConnectorCard("Acme API");
  });
  expect(card).toHaveTextContent("Not connected");
  expect(created[0]).toMatchObject({
    authMode: "oauth",
    prefixTemplates: ["https://api.acme.test/v1/"],
    oauthConfig: {
      clientId: "connector-oauth-client-id",
      clientSecret: "connector-oauth-client-secret",
      scopes: ["search.read", "search.write"],
      pkceMethod: "S256",
      authorizationParams: {
        resource: "https://api.acme.test",
        audience: "acme-api",
        access_type: "offline",
        prompt: "consent",
      },
    },
  });
  expect(card).not.toHaveTextContent("connector-oauth-client-secret");

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Edit");
    }),
  );
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  expect(within(edit).getByLabelText("New client secret")).toHaveValue("");
  await fill(
    within(edit).getByLabelText(/Prefixes/u),
    "https://api.acme.test/v2/",
  );
  await fill(
    within(edit).getByLabelText(/Scopes/u),
    "search.read\ncalendar.write",
  );
  click(getConnectorAction("button", "Save", edit));
  const confirmation = await screen.findByRole("dialog", {
    name: "Disconnect existing OAuth connections?",
  });
  expect(updated).toHaveLength(0);
  expect(confirmation).toHaveTextContent(
    /disconnect every member currently connected with OAuth/u,
  );

  click(getConnectorAction("button", "Save and disconnect", confirmation));

  await waitFor(() => {
    return expect(updated).toHaveLength(1);
  });
  expect(updated[0]?.oauthConfig).not.toHaveProperty("clientSecret");
  expect(getConnectorCard("Acme API")).toHaveTextContent(
    "https://api.acme.test/v2/",
  );
  click(getConnectorAction("button", "Connect Acme API"));
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.acme.test/authorize?state=ui-test",
    );
    expect(getConnectorCard("Acme API")).toHaveTextContent("Connected");
    expect(
      getConnectorAction(
        "button",
        "Manage Acme API access",
        getConnectorCard("Acme API"),
      ),
    ).toHaveTextContent("Used by Research");
  });
});

test("Manage a manual MCP connector through its lifecycle", async () => {
  let connector: CustomConnectorMcpResponse | null = null;
  const grants = new Map<string, AgentCustomConnectorGrant[]>([
    [RESEARCH_ID, []],
    [SUPPORT_ID, []],
  ]);
  const updates: UpdateCustomConnectorBody[] = [];
  context.mocks.data.agents([
    listAgent(RESEARCH_ID, "Research"),
    listAgent(SUPPORT_ID, "Support"),
  ]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: connector ? [connector] : [] });
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    if (body.kind !== "mcp") {
      throw new Error("Expected MCP connector");
    }
    connector = mcpCustomConnector({
      displayName: body.displayName,
      endpoint: body.endpoint,
      fields: body.fields,
      headerInjections: body.headerInjections,
      queryInjections: body.queryInjections,
      connected: false,
      missingRequiredFields: ["secret"],
      configuredFieldKeys: [],
    });
    return respond(201, connector);
  });
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    if (!connector) {
      throw new Error("Expected MCP connector");
    }
    connector = {
      ...connector,
      connected: true,
      missingRequiredFields: [],
      configuredFieldKeys: body.values.map((value) => {
        return value.key;
      }),
    };
    for (const agentId of grants.keys()) {
      grants.set(agentId, [
        { customConnectorId: connector.id, permissionNames: [] },
      ]);
    }
    return respond(200, connector);
  });
  context.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, { grants: grants.get(params.id) ?? [] });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ params, body, respond }) => {
      const next = body.operation === "remove" ? [] : body.grants;
      grants.set(params.id, next);
      return respond(200, { grants: next });
    },
  );
  context.mocks.api(customConnectorByIdContract.update, ({ body, respond }) => {
    if (!connector || body.kind !== "mcp") {
      throw new Error("Expected MCP update");
    }
    updates.push(body);
    connector = {
      ...connector,
      displayName: body.displayName,
      endpoint: body.endpoint,
      fields: body.fields,
      headerInjections: body.headerInjections,
      queryInjections: body.queryInjections,
    };
    return respond(200, connector);
  });
  context.mocks.api(
    connectorAccountsContract.disconnectSingleAccount,
    ({ respond }) => {
      if (!connector) {
        throw new Error("Expected MCP connector");
      }
      connector = { ...connector, connected: false };
      return respond(204);
    },
  );
  await setupCustomPage({ mcp: true });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "New connector");
    }),
  );
  const create = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  click(within(create).getByLabelText("Connector type"));
  click(await screen.findByRole("option", { name: "MCP · Streamable HTTP" }));
  await fill(within(create).getByLabelText("Display name"), "Acme MCP");
  fireEvent.change(within(create).getByLabelText(/MCP endpoint/u), {
    target: { value: "https://mcp.acme.test/server" },
  });
  click(getConnectorAction("button", "Add authentication", create));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "API authentication");
    }),
  );
  await waitFor(() => {
    expect(getConnectorAction("button", "Create", create)).toBeEnabled();
  });
  click(getConnectorAction("button", "Create", create));
  const card = await waitFor(() => {
    return getConnectorCard("Acme MCP");
  });
  expect(card).toHaveTextContent("MCP");
  expect(card).toHaveTextContent("https://mcp.acme.test/server");
  expect(card).toHaveTextContent("Not connected");

  click(getConnectorAction("button", "Connect Acme MCP", card));
  const connect = await screen.findByRole("dialog", {
    name: "Connect Acme MCP",
  });
  await fill(within(connect).getByLabelText("Secret"), "mcp-secret");
  click(getConnectorAction("button", "Save", connect));
  await waitFor(() => {
    expect(getConnectorCard("Acme MCP")).toHaveTextContent("Connected");
    expect(
      getConnectorAction(
        "button",
        "Manage Acme MCP access",
        getConnectorCard("Acme MCP"),
      ),
    ).toHaveTextContent("Used by 2 agents");
  });

  click(getConnectorAction("button", "Manage Acme MCP access"));
  const access = await screen.findByRole("dialog", {
    name: "Manage Acme MCP access",
  });
  click(
    await waitFor(() => {
      return getConnectorSwitch("Revoke Acme MCP access for Support", access);
    }),
  );
  await waitFor(() => {
    return expect(
      getConnectorSwitch("Authorize Acme MCP access for Support", access),
    ).toBeEnabled();
  });
  click(getConnectorSwitch("Authorize Acme MCP access for Support", access));
  await waitFor(() => {
    return expect(
      getConnectorSwitch("Revoke Acme MCP access for Support", access),
    ).toBeInTheDocument();
  });
  expect(
    getConnectorSwitch("Revoke Acme MCP access for Research", access),
  ).toBeInTheDocument();
  click(getConnectorAction("button", "Close", access));

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Edit");
    }),
  );
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  await fill(within(edit).getByLabelText("Display name"), "Acme MCP v2");
  fireEvent.change(within(edit).getByLabelText(/MCP endpoint/u), {
    target: { value: "https://mcp.acme.test/v2" },
  });
  click(getConnectorAction("button", "Save", edit));
  const updatedCard = await waitFor(() => {
    return getConnectorCard("Acme MCP v2");
  });
  expect(updatedCard).toHaveTextContent("https://mcp.acme.test/v2");
  expect(updatedCard).toHaveTextContent("MCP");
  expect(updates[0]).toMatchObject({
    kind: "mcp",
    endpoint: "https://mcp.acme.test/v2",
    fields: [
      { key: "secret", label: "Secret", kind: "secret", required: true },
    ],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{secrets.secret}}" },
    ],
    queryInjections: [],
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  await waitFor(() => {
    return expect(
      getConnectorAction("button", "Connect Acme MCP v2"),
    ).toBeInTheDocument();
  });
});

test("Create, edit, and connect an OAuth MCP connector", async () => {
  let connector: CustomConnectorMcpResponse | null = null;
  const created: CreateCustomConnectorBody[] = [];
  const updated: UpdateCustomConnectorBody[] = [];
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  context.mocks.data.agents([]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: connector ? [connector] : [] });
  });
  context.mocks.api(customConnectorsContract.create, ({ body, respond }) => {
    if (body.kind !== "mcp" || !body.oauthConfig) {
      throw new Error("Expected OAuth MCP");
    }
    created.push(body);
    connector = mcpCustomConnector({
      displayName: body.displayName,
      endpoint: body.endpoint,
      fields: body.fields,
      headerInjections: body.headerInjections,
      queryInjections: body.queryInjections,
      authMode: "oauth",
      oauthConfig: publicOAuthConfig(body.oauthConfig),
      connected: false,
      missingRequiredFields: ["oauth"],
      configuredFieldKeys: [],
    });
    return respond(201, connector);
  });
  context.mocks.api(customConnectorByIdContract.update, ({ body, respond }) => {
    if (!connector || body.kind !== "mcp" || !body.oauthConfig) {
      throw new Error("Expected OAuth MCP update");
    }
    updated.push(body);
    const updatedConnector = customConnectorMcpResponseSchema.parse({
      ...connector,
      endpoint: body.endpoint,
      oauthConfig: publicOAuthConfig(body.oauthConfig),
    });
    connector = updatedConnector;
    return respond(200, updatedConnector);
  });
  context.mocks.api(customConnectorOAuth2Contract.start, ({ respond }) => {
    if (!connector) {
      throw new Error("Expected OAuth MCP");
    }
    return respond(200, {
      authorizationUrl: "https://oauth.acme.test/authorize?state=mcp-ui",
    });
  });
  await setupCustomPage({ mcp: true });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "New connector");
    }),
  );
  const create = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  click(within(create).getByLabelText("Connector type"));
  click(await screen.findByRole("option", { name: "MCP · Streamable HTTP" }));
  await fill(within(create).getByLabelText("Display name"), "OAuth MCP");
  fireEvent.change(within(create).getByLabelText(/MCP endpoint/u), {
    target: { value: "https://mcp.acme.test/oauth" },
  });
  click(getConnectorAction("button", "Add authentication", create));
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "OAuth 2.0");
    }),
  );
  await fill(
    within(create).getByLabelText("Authorization URL"),
    "https://oauth.acme.test/authorize",
  );
  await fill(
    within(create).getByLabelText("Token URL"),
    "https://oauth.acme.test/token",
  );
  await fill(within(create).getByLabelText("Client ID"), "mcp-client");
  await fill(
    within(create).getByLabelText("Client secret"),
    "mcp-client-secret",
  );
  await waitFor(() => {
    expect(getConnectorAction("button", "Create", create)).toBeEnabled();
  });
  click(getConnectorAction("button", "Create", create));
  const createdCard = await waitFor(() => {
    return getConnectorCard("OAuth MCP");
  });
  expect(createdCard).toHaveTextContent("MCP");
  expect(createdCard).toHaveTextContent("Not connected");
  expect(created[0]).toMatchObject({
    kind: "mcp",
    endpoint: "https://mcp.acme.test/oauth",
    oauthConfig: { clientSecret: "mcp-client-secret" },
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Edit");
    }),
  );
  const edit = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });
  expect(within(edit).getByLabelText("New client secret")).toHaveValue("");
  fireEvent.change(within(edit).getByLabelText(/MCP endpoint/u), {
    target: { value: "https://mcp.acme.test/oauth-v2" },
  });
  click(getConnectorAction("button", "Save", edit));
  await waitFor(() => {
    return expect(updated).toHaveLength(1);
  });
  expect(updated[0]?.oauthConfig).not.toHaveProperty("clientSecret");
  expect(getConnectorCard("OAuth MCP")).toHaveTextContent(
    "https://mcp.acme.test/oauth-v2",
  );

  click(getConnectorAction("button", "Connect OAuth MCP"));
  await waitFor(() => {
    expect(authWindow.location.href).toBe(
      "https://oauth.acme.test/authorize?state=mcp-ui",
    );
  });
});

test("Add and optionally name a custom OAuth account", async () => {
  let connector = customConnector({
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
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
  const connectionId = crypto.randomUUID();
  let account: ConnectorAccountConnection | null = null;
  let submitted: unknown;
  let grantMutations = 0;
  const authWindow = createAuthWindow();
  context.mocks.browser.open(authWindow);
  context.mocks.data.agents([listAgent(RESEARCH_ID, "Research")]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      grants: [{ customConnectorId: connector.id, permissionNames: [] }],
    });
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
      submitted = body.account;
      connector = { ...connector, connected: true, missingRequiredFields: [] };
      account = customAccount(connector.id, connectionId, {
        authMethod: "oauth",
        oauthScopes: ["search.read"],
      });
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
      return account && params.connectionId === account.id
        ? respond(200, account)
        : respond(404, {
            error: { message: "Account not found", code: "NOT_FOUND" },
          });
    },
  );
  context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
    grantMutations += 1;
    return respond(200, { grants: [] });
  });
  await setupCustomPage({ accounts: true });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Acme Search");
    }),
  );

  const naming = await screen.findByRole("dialog", {
    name: "Name your Acme Search account",
  });
  expect(within(naming).getByLabelText("Account name")).toHaveAttribute(
    "placeholder",
    `Account #${connectionId.slice(0, 8)}`,
  );
  click(getConnectorAction("button", "Skip", naming));
  await expect(
    within(getConnectorCard("Acme Search")).findByText(
      `Account #${connectionId.slice(0, 8)}`,
    ),
  ).resolves.toBeInTheDocument();
  expect(
    getConnectorAction(
      "button",
      "Manage Acme Search access",
      getConnectorCard("Acme Search"),
    ),
  ).toHaveTextContent("Used by Research");
  expect(submitted).toStrictEqual({ intent: "add" });
  expect(grantMutations).toBe(0);
});

test("Configure custom connectors in Portuguese", async () => {
  const connector = customConnector({
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
  });
  context.mocks.data.userPreferences({ locale: "pt-BR" });
  context.mocks.data.agents([listAgent(RESEARCH_ID, "Research")]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, {
      grants: [{ customConnectorId: connector.id, permissionNames: [] }],
    });
  });
  await setupCustomPage();
  const card = await waitFor(() => {
    return getConnectorCard("Acme Search");
  });
  expect(card).toHaveTextContent("Conectado");
  expect(
    getConnectorAction("button", "Gerenciar acesso ao Acme Search", card),
  ).toHaveTextContent("Usado por Research");

  click(getConnectorAction("button", "Novo conector"));
  const dialog = await screen.findByRole("dialog", {
    name: "Novo conector personalizado",
  });
  expect(within(dialog).getByLabelText("Nome de exibição")).toBeInTheDocument();
  expect(getConnectorAction("button", "Fechar", dialog)).toBeInTheDocument();
  click(getConnectorAction("button", "Adicionar autenticação", dialog));
  click(getConnectorAction("menuitem", "OAuth 2.0"));

  expect(
    within(dialog).getByText(
      "Configure um app OAuth para os membros autorizarem.",
    ),
  ).toBeInTheDocument();
  expect(within(dialog).getByLabelText("URL do token")).toBeInTheDocument();
  expect(within(dialog).getByLabelText("ID do cliente")).toBeInTheDocument();
  expect(
    within(dialog).getByText("Configurações avançadas"),
  ).toBeInTheDocument();
  expect(within(dialog).getByLabelText("PKCE")).toHaveTextContent("Nenhum");
});

test("Edit a custom HTTP connector without losing advanced configuration", async () => {
  let connector = customConnector({
    headerInjections: [],
    queryInjections: [{ name: "api_key", valueTemplate: "{{secrets.secret}}" }],
  });
  const updates: UpdateCustomConnectorBody[] = [];
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(customConnectorByIdContract.update, ({ body, respond }) => {
    if (body.kind === "mcp") {
      throw new Error("Expected HTTP update");
    }
    updates.push(body);
    connector = {
      ...connector,
      displayName: body.displayName,
      prefixTemplates: body.prefixTemplates,
      fields: body.fields,
      headerInjections: body.headerInjections,
      queryInjections: body.queryInjections,
    };
    return respond(200, connector);
  });
  await setupCustomPage();
  await waitFor(() => {
    return getConnectorCard("Acme Search");
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Edit");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Edit custom connector",
  });

  expect(within(dialog).getByLabelText("Display name")).toHaveValue(
    "Acme Search",
  );
  expect(within(dialog).getByLabelText(/Prefixes/u)).toHaveValue(
    "https://api.acme.test/v1/",
  );
  expect(
    within(dialog).getByText(
      "Advanced API fields and injections are preserved when you save.",
    ),
  ).toBeInTheDocument();
  click(getConnectorAction("button", "Save", dialog));

  await waitFor(() => {
    return expect(updates).toHaveLength(1);
  });
  expect(updates[0]).toMatchObject({
    prefixTemplates: ["https://api.acme.test/v1/"],
    headerInjections: [],
    queryInjections: [{ name: "api_key", valueTemplate: "{{secrets.secret}}" }],
  });
});

test("Do not grant access after an unsuccessful custom connection", async () => {
  const connector = customConnector({ displayName: "Acme Incomplete" });
  let writes = 0;
  let grantMutations = 0;
  context.mocks.data.agents([listAgent(RESEARCH_ID, "Research")]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { grants: [] });
  });
  context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
    grantMutations += 1;
    return respond(200, { grants: [] });
  });
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    writes += 1;
    if (writes === 1) {
      return respond(500, {
        error: { code: "UNAVAILABLE", message: "Write unavailable" },
      });
    }
    return respond(200, {
      ...connector,
      connected: false,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
    });
  });
  await setupCustomPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Acme Incomplete");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Acme Incomplete",
  });
  await fill(within(dialog).getByLabelText("Secret"), "acme-secret");

  click(getConnectorAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(writes).toBe(1);
  });
  expect(dialog).toBeInTheDocument();
  expect(grantMutations).toBe(0);

  click(getConnectorAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(writes).toBe(2);
  });
  expect(dialog).toBeInTheDocument();
  expect(grantMutations).toBe(0);
});

test("Hide integration-managed connectors from custom settings", async () => {
  const feishu = customConnector({
    slug: "_feishu-00000000-0000-4000-8000-000000000044",
    displayName: "Feishu",
    prefixTemplates: ["https://open.feishu.cn/open-apis/"],
    fields: [],
    headerInjections: [
      { name: "Authorization", valueTemplate: "Bearer {{oauth.access_token}}" },
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
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [feishu] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { grants: [] });
  });
  await setupCustomPage();

  await expect(
    screen.findByText(
      "No custom connectors yet. Create one to register an API for every member to use.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Feishu")).toBeNull();
});

test("Manage a custom connector before it is connected", async () => {
  const connector = customConnector();
  context.mocks.data.agents([
    listAgent(RESEARCH_ID, "Research"),
    listAgent(SUPPORT_ID, "Support"),
  ]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { grants: [] });
  });
  await setupCustomPage();
  const card = await waitFor(() => {
    return getConnectorCard("Acme Search");
  });
  expect(card).toHaveTextContent("HTTP API");
  expect(card).toHaveTextContent("Not connected");
  expect(card).toHaveTextContent("https://api.acme.test/v1/");
  expect(
    queryConnectorAction("button", "Manage Acme Search access", card),
  ).toBeNull();

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );

  await expect(
    waitFor(() => {
      return getConnectorAction("menuitem", "Connect");
    }),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("menuitem", "Edit")).toBeInTheDocument();
  expect(getConnectorAction("menuitem", "Delete")).toBeInTheDocument();
});

test("Restrict MCP account actions when MCP is unavailable", async () => {
  const connector = mcpCustomConnector();
  const account = customAccount(connector.id, crypto.randomUUID(), {
    displayName: "Work",
  });
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
  await setupCustomPage({ accounts: true, mcp: false });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Acme MCP accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", { name: "Acme MCP" });
  expect(
    within(within(manager).getByRole("group", { name: "Default" })).getByText(
      "Work",
    ),
  ).toBeInTheDocument();
  expect(getConnectorAction("button", "Add account", manager)).toBeDisabled();

  click(accountAction(manager));

  expect(queryConnectorAction("menuitem", "Reconnect")).toBeNull();
  expect(getConnectorAction("menuitem", "Rename")).toBeInTheDocument();
});

test("Allow safe MCP reductions when new MCP actions are unavailable", async () => {
  let connector = mcpCustomConnector();
  const grants = new Map<string, AgentCustomConnectorGrant[]>([
    [RESEARCH_ID, [{ customConnectorId: connector.id, permissionNames: [] }]],
    [SUPPORT_ID, []],
  ]);
  context.mocks.data.agents([
    listAgent(RESEARCH_ID, "Research"),
    listAgent(SUPPORT_ID, "Support"),
  ]);
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, { grants: grants.get(params.id) ?? [] });
    },
  );
  context.mocks.api(
    agentCustomConnectorsContract.update,
    ({ params, body, respond }) => {
      if (body.operation !== "remove") {
        throw new Error("Expected access reduction");
      }
      const requested = new Set(
        body.grants.map((grant) => {
          return grant.customConnectorId;
        }),
      );
      const next = (grants.get(params.id) ?? []).filter((grant) => {
        return !requested.has(grant.customConnectorId);
      });
      grants.set(params.id, next);
      return respond(200, { grants: next });
    },
  );
  context.mocks.api(
    connectorAccountsContract.disconnectSingleAccount,
    ({ body, respond }) => {
      expect(body.target).toStrictEqual({
        kind: "custom",
        customConnectorId: connector.id,
      });
      connector = { ...connector, connected: false };
      return respond(204);
    },
  );
  await setupCustomPage({ mcp: false });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "New connector");
    }),
  );
  const create = await screen.findByRole("dialog", {
    name: "New custom connector",
  });
  expect(within(create).queryByLabelText("Connector type")).toBeNull();
  expect(within(create).getByLabelText(/Prefixes/u)).toBeInTheDocument();
  click(getConnectorAction("button", "Cancel", create));

  const card = await waitFor(() => {
    return getConnectorCard("Acme MCP");
  });
  expect(card).toHaveTextContent("MCP");
  expect(card).toHaveTextContent("https://mcp.acme.test/server");
  expect(card).toHaveTextContent("Connected");
  expect(
    getConnectorAction("button", "Manage Acme MCP access", card),
  ).toHaveTextContent("Used by Research");

  click(getConnectorAction("button", "Manage Acme MCP access", card));
  const access = await screen.findByRole("dialog", {
    name: "Manage Acme MCP access",
  });
  const support = await waitFor(() => {
    return getConnectorSwitch("Authorize Acme MCP access for Support", access);
  });
  expect(support).toHaveAttribute("aria-disabled", "true");
  click(
    await waitFor(() => {
      return getConnectorSwitch("Revoke Acme MCP access for Research", access);
    }),
  );
  await waitFor(() => {
    expect(
      getConnectorSwitch("Authorize Acme MCP access for Research", access),
    ).toHaveAttribute("aria-disabled", "true");
  });
  click(getConnectorAction("button", "Close", access));
  await waitFor(() => {
    return expect(access).not.toBeInTheDocument();
  });

  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Disconnect");
    }),
  );
  await waitFor(() => {
    expect(getConnectorCard("Acme MCP")).toHaveTextContent("Not connected");
  });
  expect(queryConnectorAction("button", "Connect Acme MCP")).toBeNull();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "More options");
    }),
  );
  await expect(
    waitFor(() => {
      return getConnectorAction("menuitem", "Delete");
    }),
  ).resolves.toBeInTheDocument();
  expect(queryConnectorAction("menuitem", "Connect")).toBeNull();
  expect(queryConnectorAction("menuitem", "Edit")).toBeNull();
});

test("Validate new and reconnecting custom accounts appropriately", async () => {
  const connector = customConnector({
    connected: true,
    fields: [
      { key: "secret", label: "Secret", kind: "secret", required: true },
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
  const existing = customAccount(connector.id, crypto.randomUUID(), {
    displayName: "Existing",
  });
  let submitted: unknown;
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: existing.target,
          accountCount: 1,
          attentionCount: 0,
          defaultConnection: existing,
        },
      ],
    });
  });
  context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
    return respond(200, { connections: [existing], nextCursor: null });
  });
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    submitted = body.account;
    return respond(200, { ...connector, connectedAccountId: existing.id });
  });
  await setupCustomPage({ accounts: true });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Acme Search accounts");
    }),
  );
  const manager = await screen.findByRole("dialog", { name: "Acme Search" });

  click(getConnectorAction("button", "Add account", manager));
  const addition = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  expect(addition).not.toHaveTextContent("Configured");
  await fill(within(addition).getByLabelText("Secret"), "account-secret");
  expect(getConnectorAction("button", "Save", addition)).toBeDisabled();
  await fill(within(addition).getByLabelText("Subdomain"), "work");
  expect(getConnectorAction("button", "Save", addition)).toBeEnabled();
  click(getConnectorAction("button", "Close", addition));
  await waitFor(() => {
    expect(addition).not.toBeInTheDocument();
  });
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Manage Acme Search accounts");
    }),
  );

  const reopenedManager = await screen.findByRole("dialog", {
    name: "Acme Search",
  });
  const defaultGroup = await within(reopenedManager).findByRole("group", {
    name: "Default",
  });
  expect(within(defaultGroup).getByText("Existing")).toBeInTheDocument();
  click(
    await waitFor(() => {
      return accountAction(defaultGroup);
    }),
  );
  click(
    await waitFor(() => {
      return getConnectorAction("menuitem", "Reconnect");
    }),
  );
  const reconnect = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  await fill(within(reconnect).getByLabelText("Secret"), "new-secret");
  expect(getConnectorAction("button", "Save", reconnect)).toBeEnabled();

  click(getConnectorAction("button", "Save", reconnect));

  await waitFor(() => {
    return expect(reconnect).not.toBeInTheDocument();
  });
  expect(submitted).toStrictEqual({
    intent: "reconnect",
    connectionId: existing.id,
  });
  expect(
    screen.queryByRole("dialog", { name: "Name your Acme Search account" }),
  ).toBeNull();
});

test("Preserve custom connector grants when credentials are added", async () => {
  const connector = customConnector({
    permissionBundleRef: "builtin:feishu@1",
  });
  let connected = false;
  let grantMutations = 0;
  context.mocks.data.agents([listAgent(RESEARCH_ID, "Research")]);
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
    grantMutations += 1;
    return respond(200, { grants: [] });
  });
  context.mocks.api(customConnectorValuesContract.set, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "secret", kind: "secret", value: "acme-secret" },
    ]);
    connected = true;
    return respond(200, {
      ...connector,
      connected: true,
      configuredFieldKeys: ["secret"],
      missingRequiredFields: [],
    });
  });
  await setupCustomPage();
  click(
    await waitFor(() => {
      return getConnectorAction("button", "Connect Acme Search");
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Connect Acme Search",
  });
  await fill(within(dialog).getByLabelText("Secret"), "acme-secret");

  click(getConnectorAction("button", "Save", dialog));

  await waitFor(() => {
    expect(getConnectorCard("Acme Search")).toHaveTextContent("Connected");
    expect(
      getConnectorAction(
        "button",
        "Manage Acme Search access",
        getConnectorCard("Acme Search"),
      ),
    ).toHaveTextContent("Used by Research");
  });
  expect(grantMutations).toBe(0);
});

test("Show a custom connector created elsewhere", async () => {
  let connectors: CustomConnectorHttpResponse[] = [];
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors });
  });
  await setupCustomPage();
  await expect(
    screen.findByText(
      "No custom connectors yet. Create one to register an API for every member to use.",
    ),
  ).resolves.toBeInTheDocument();

  click(getConnectorAction("tab", "Built-in"));
  connectors = [customConnector({ slug: "_acme-search" })];
  context.mocks.ably.trigger("customConnectorListChanged");
  click(getConnectorAction("tab", "Custom"));

  await expect(screen.findByText("Acme Search")).resolves.toBeInTheDocument();
});
