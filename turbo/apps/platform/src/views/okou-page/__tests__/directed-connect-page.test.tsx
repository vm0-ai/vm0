import {
  connectorManualGrantContract,
  connectorNoAuthGrantContract,
  connectorOpenIdStartContract,
  connectorOauthStartContract,
} from "@okouai/api-contracts/contracts/connectors";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { userConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import {
  agentCustomConnectorsContract,
  type AgentCustomConnectorGrant,
} from "@okouai/api-contracts/contracts/agent-custom-connectors";
import {
  customConnectorOAuth2Contract,
  customConnectorValuesContract,
  customConnectorsContract,
  type CustomConnectorHttpResponse,
  type CustomConnectorMcpResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { ConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { ROUTES } from "../../../signals/route-paths.ts";

const context = testContext();
const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const SECOND_AGENT_ID = "00000000-0000-0000-0000-000000000002";

function connectorIcon(connectorSlug: string) {
  return {
    url: `https://icons.example.test/${connectorSlug}.svg`,
    invertInDarkMode: false,
  };
}

function mockPublicConnectorStatus(
  connector: PublicConnectorCatalogStatusItem,
): void {
  mockPublicConnectorStatuses([connector]);
}

function mockPublicConnectorStatuses(
  connectors: readonly PublicConnectorCatalogStatusItem[],
): void {
  context.mocks.api(connectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

function publicManualTokenConnectorStatus(args: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly placeholder: string;
}): PublicConnectorCatalogStatusItem {
  return {
    slug: args.slug,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.slug),
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
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
            placeholder: args.placeholder,
            inputType: "password",
          },
        ],
        startOptions: [],
      },
    ],
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
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

function publicOAuthConnectorStatus(args: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly singleAuthCodeAuthMethodId: string | null;
}): PublicConnectorCatalogStatusItem {
  return {
    slug: args.slug,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.slug),
    category: "engineering-team-execution",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "Public OAuth",
        description: "Public OAuth description",
        grantKind: "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
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
    singleAuthCodeAuthMethodId: args.singleAuthCodeAuthMethodId,
    connectNotice: null,
  };
}

function publicNoAuthConnectorStatus(args: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
}): PublicConnectorCatalogStatusItem {
  return {
    slug: args.slug,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.slug),
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "api",
        label: "Public catalog",
        description: null,
        grantKind: "none",
        manualFields: [],
        startOptions: [],
      },
    ],
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
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

function connectedConnectorResponse(args: {
  readonly slug: ConnectorResponse["slug"];
  readonly authMethod: string;
  readonly updatedAt: string;
}): ConnectorResponse {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: args.slug,
    authMethod: args.authMethod,
    externalId: "mock-connected-account",
    externalUsername: "mock-connected-account",
    externalEmail: null,
    oauthScopes: [],
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: args.updatedAt,
  };
}

function customConnector(
  overrides: Partial<CustomConnectorHttpResponse> = {},
): CustomConnectorHttpResponse {
  return {
    kind: "http",
    id: "33333333-3333-4333-8333-333333333333",
    storageVersion: 1,
    slug: "_acme-api",
    displayName: "Acme API",
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
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mcpCustomConnector(): CustomConnectorMcpResponse {
  return {
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    storageVersion: 1,
    slug: "_deepwiki",
    displayName: "DeepWiki",
    endpoint: "https://mcp.deepwiki.com/mcp",
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
        name: "X-VM0-Test-Token",
        valueTemplate: "{{secrets.secret}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
    permissionBundleRef: null,
    connected: false,
    missingRequiredFields: ["secret"],
    configuredFieldKeys: [],
    createdAt: "2026-08-11T00:00:00Z",
    updatedAt: "2026-08-11T00:00:00Z",
  };
}

function steamOpenIdConnectorStatus(): PublicConnectorCatalogStatusItem {
  return {
    slug: "steam",
    label: "Public Steam",
    description: "Public Steam description",
    icon: connectorIcon("steam"),
    category: "data-automation-infrastructure",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "openid",
        label: "Public Steam sign-in",
        description: "Public Steam sign-in description",
        grantKind: "openid-auth",
        manualFields: [],
        startOptions: [],
      },
    ],
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
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  };
}

function mockConnectorOauthStart(args?: {
  readonly onStart?: (
    agentId: string | undefined,
    authorizeAgent: true | undefined,
  ) => void;
}): {
  readonly authWindow: Window;
} {
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });

  context.mocks.api(
    connectorOauthStartContract.start,
    ({ body, params, respond }) => {
      args?.onStart?.(body.agentId, body.authorizeAgent);
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.connectorSlug}/authorize`,
      });
    },
  );
  context.mocks.browser.open(authWindow);
  return { authWindow };
}

function mockConnectorOpenIdStart(args?: {
  readonly onStart?: () => void;
  readonly popupClosed?: boolean;
}): {
  readonly authWindow: Window;
} {
  const authWindow = context.mocks.browser.authWindow();
  authWindow.closed = args?.popupClosed ?? true;
  Object.defineProperty(authWindow, "location", {
    value: { href: "" },
    configurable: true,
  });

  context.mocks.api(
    connectorOpenIdStartContract.start,
    ({ params, respond }) => {
      args?.onStart?.();
      return respond(200, {
        authorizationUrl: `https://openid.test/${params.connectorSlug}/authorize`,
      });
    },
  );
  context.mocks.api(connectorOauthStartContract.start, ({ never }) => {
    return never();
  });
  context.mocks.browser.open(authWindow);
  return { authWindow };
}

function getButtonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((element) => {
    return element.textContent?.trim() === text;
  });
  if (!button) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

describe("directed connector connect page", () => {
  it("connects and authorizes a manual MCP custom connector", async () => {
    let connected = false;
    let grants: AgentCustomConnectorGrant[] = [];
    let submittedValues: readonly {
      readonly key: string;
      readonly kind: "secret" | "variable";
      readonly value: string;
    }[] = [];
    const connector = mcpCustomConnector();
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [
          {
            ...connector,
            connected,
            missingRequiredFields: connected ? [] : ["secret"],
            configuredFieldKeys: connected ? ["secret"] : [],
          },
        ],
      });
    });
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ body, params, respond }) => {
        expect(params.id).toBe(connector.id);
        submittedValues = body.values;
        connected = true;
        return respond(200, {
          ...connector,
          connected: true,
          missingRequiredFields: [],
          configuredFieldKeys: ["secret"],
        });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        grants = body.grants;
        return respond(200, { grants });
      },
    );

    detachedSetupPage({
      context,
      path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
    });

    const heading = await screen.findByText("Zero needs DeepWiki to proceed");
    expect(heading).toBeInTheDocument();
    click(getButtonByText("Connect"));
    const dialog = await screen.findByRole("dialog", {
      name: "Connect DeepWiki",
    });
    await fill(within(dialog).getByLabelText("Secret"), "acme-secret");
    click(getButtonByText("Save"));

    await waitFor(() => {
      expect(submittedValues).toStrictEqual([
        { key: "secret", kind: "secret", value: "acme-secret" },
      ]);
      expect(grants).toStrictEqual([
        { customConnectorId: connector.id, permissionNames: [] },
      ]);
      expect(screen.getByText("DeepWiki connected")).toBeInTheDocument();
    });
  });

  it("starts OAuth and authorizes an OAuth custom connector", async () => {
    let connected = false;
    const connectionId = crypto.randomUUID();
    let grants: AgentCustomConnectorGrant[] = [];
    const connector = customConnector({
      slug: "_acme-oauth",
      displayName: "Acme OAuth",
      authMode: "oauth",
      fields: [],
      missingRequiredFields: ["oauth"],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "client-id",
        authorizationUrl: "https://acme.test/oauth/authorize",
        tokenUrl: "https://acme.test/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [
          {
            ...connector,
            connected,
            ...(connected
              ? {
                  connectedAccountId: connectionId,
                  connectedAccountUpdatedAt: "2026-01-01T00:00:01Z",
                }
              : {}),
          },
        ],
      });
    });
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      ({ body, params, respond }) => {
        expect(params.id).toBe(connector.id);
        expect(body.account).toStrictEqual({ intent: "add" });
        connected = true;
        return respond(200, {
          authorizationUrl: "https://acme.test/oauth/authorize",
          connectionId,
        });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        grants = body.grants;
        return respond(200, { grants });
      },
    );
    const authWindow = context.mocks.browser.authWindow();
    authWindow.closed = true;
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);

    detachedSetupPage({
      context,
      path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
    });

    const heading = await screen.findByText("Zero needs Acme OAuth to proceed");
    expect(heading).toBeInTheDocument();
    click(getButtonByText("Connect"));
    await screen.findByRole("dialog", { name: "Connect Acme OAuth" });
    click(getButtonByText("Continue"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://acme.test/oauth/authorize",
      );
      expect(grants).toStrictEqual([
        { customConnectorId: connector.id, permissionNames: [] },
      ]);
      expect(screen.getByText("Acme OAuth connected")).toBeInTheDocument();
    });
  });

  it("reconnects the exact default OAuth custom connector account", async () => {
    const connectionId = crypto.randomUUID();
    let connectedAccountUpdatedAt = "2026-01-01T00:00:00Z";
    let grants: AgentCustomConnectorGrant[] = [];
    const connector = customConnector({
      slug: "_acme-oauth-reconnect",
      displayName: "Acme OAuth Reconnect",
      authMode: "oauth",
      connected: true,
      connectedAccountId: connectionId,
      connectedAccountUpdatedAt,
      fields: [],
      missingRequiredFields: [],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "client-id",
        authorizationUrl: "https://acme.test/oauth/reconnect",
        tokenUrl: "https://acme.test/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [{ ...connector, connectedAccountUpdatedAt }],
      });
    });
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      ({ body, params, respond }) => {
        expect(params.id).toBe(connector.id);
        expect(body.account).toStrictEqual({
          intent: "reconnect",
          connectionId,
        });
        connectedAccountUpdatedAt = "2026-01-01T00:00:01Z";
        return respond(200, {
          authorizationUrl: "https://acme.test/oauth/reconnect",
        });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ body, params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        grants = body.grants;
        return respond(200, { grants });
      },
    );
    const authWindow = context.mocks.browser.authWindow();
    authWindow.closed = true;
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);

    detachedSetupPage({
      context,
      path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
    });

    await screen.findByText("Acme OAuth Reconnect connected");
    click(getButtonByText("Reconnect"));
    await screen.findByRole("dialog", {
      name: "Connect Acme OAuth Reconnect",
    });
    click(getButtonByText("Continue"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://acme.test/oauth/reconnect",
      );
      expect(grants).toStrictEqual([
        { customConnectorId: connector.id, permissionNames: [] },
      ]);
    });
  });

  it("starts permissioned OAuth before checking the target grant", async () => {
    let connected = false;
    const connectionId = crypto.randomUUID();
    let authorizationUpdates = 0;
    const authorizationRequested = context.mocks.deferred<void>();
    const releaseAuthorization = context.mocks.deferred<void>();
    const connector = customConnector({
      slug: "_acme-permissioned-oauth",
      displayName: "Acme Permissioned OAuth",
      authMode: "oauth",
      fields: [],
      missingRequiredFields: ["oauth"],
      permissionBundleRef: "builtin:feishu@1",
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{oauth.access_token}}",
        },
      ],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "client-id",
        authorizationUrl: "https://acme.test/oauth/authorize",
        tokenUrl: "https://acme.test/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read"],
        authorizationParams: {},
      },
    });
    context.mocks.api(customConnectorsContract.list, ({ respond }) => {
      return respond(200, {
        connectors: [
          {
            ...connector,
            connected,
            ...(connected
              ? {
                  connectedAccountId: connectionId,
                  connectedAccountUpdatedAt: "2026-01-01T00:00:01Z",
                }
              : {}),
          },
        ],
      });
    });
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      ({ body, params, respond }) => {
        expect(params.id).toBe(connector.id);
        expect(body.account).toStrictEqual({ intent: "add" });
        connected = true;
        return respond(200, {
          authorizationUrl: "https://acme.test/oauth/authorize",
          connectionId,
        });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.get,
      async ({ params, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        authorizationRequested.resolve();
        await releaseAuthorization.promise;
        const grants = [
          {
            customConnectorId: connector.id,
            permissionNames: ["messages:send-as-user"],
          },
        ];
        return respond(200, { grants });
      },
    );
    context.mocks.api(agentCustomConnectorsContract.update, ({ respond }) => {
      authorizationUpdates += 1;
      return respond(200, { grants: [] });
    });
    const authWindow = context.mocks.browser.authWindow();
    authWindow.closed = true;
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);

    detachedSetupPage({
      context,
      path: `/connectors/${connector.slug}/connect?agentId=${AGENT_ID}`,
    });

    await screen.findByText("Zero needs Acme Permissioned OAuth to proceed");
    click(getButtonByText("Connect"));
    await screen.findByRole("dialog", {
      name: "Connect Acme Permissioned OAuth",
    });
    click(getButtonByText("Continue"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://acme.test/oauth/authorize",
      );
    });
    await authorizationRequested.promise;
    releaseAuthorization.resolve();
    await waitFor(() => {
      expect(
        screen.getByText("Acme Permissioned OAuth connected"),
      ).toBeInTheDocument();
    });
    expect(authorizationUpdates).toBe(0);
  });

  it("starts an OAuth flow from a directed link", async () => {
    let startedAgentId: string | undefined;
    let authorizeAgent: true | undefined;
    const { authWindow } = mockConnectorOauthStart({
      onStart: (agentId, requestedAuthorization) => {
        startedAgentId = agentId;
        authorizeAgent = requestedAuthorization;
      },
    });
    mockPublicConnectorStatus({
      slug: "github",
      label: "Public GitHub",
      description: "Public GitHub description",
      icon: connectorIcon("github"),
      category: "engineering-team-execution",
      generation: [],
      tags: [],
      authMethods: [
        {
          id: "oauth",
          label: "Public OAuth",
          description: "Public OAuth description",
          grantKind: "auth-code",
          manualFields: [],
          startOptions: [],
        },
      ],
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
      singleAuthCodeAuthMethodId: "oauth",
      connectNotice: null,
    });

    detachedSetupPage({
      context,
      path: `/connectors/github/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public GitHub to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://oauth.test/github/authorize",
      );
      expect(startedAgentId).toBe(AGENT_ID);
      expect(authorizeAgent).toBeTruthy();
    });
  });

  it("starts an OpenID flow from a directed link", async () => {
    const { authWindow } = mockConnectorOpenIdStart();
    mockPublicConnectorStatus(steamOpenIdConnectorStatus());

    detachedSetupPage({ context, path: "/connectors/steam/connect" });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Steam to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://openid.test/steam/authorize",
      );
    });
  });

  it("connects and authorizes a no-auth connector before continuing the callback", async () => {
    mockPublicConnectorStatus(
      publicNoAuthConnectorStatus({
        slug: "stripe",
        label: "Public Stripe",
      }),
    );
    let connectCalls = 0;
    const threadId = "00000000-0000-4000-a000-000000000101";
    const callbackPrompt = "Re-check Stripe, then continue";
    let continuationPrompt: string | null = null;
    context.mocks.api(
      connectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCalls += 1;
        expect(params.connectorSlug).toBe("stripe");
        expect(body).toStrictEqual({
          account: { intent: "add" },
          authMethod: "api",
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        return respond(200, {
          id: crypto.randomUUID(),
          slug: "stripe",
          authMethod: body.authMethod,
          externalId: null,
          externalUsername: null,
          externalEmail: null,
          oauthScopes: null,
          connectionStatus: "connected",
          reconnectReason: null,
          tokenExpiresAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
    );
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      if ("prompt" in body) {
        continuationPrompt = body.prompt ?? null;
      }
      return respond(201, {
        runId: "00000000-0000-4000-a000-000000000201",
        threadId,
      });
    });
    detachedSetupPage({
      context,
      path: `/connectors/stripe/connect?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Stripe to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(connectCalls).toBe(1);
      expect(screen.getByText("Public Stripe connected")).toBeInTheDocument();
      expect(continuationPrompt).toBe(callbackPrompt);
    });
    expect(
      screen.queryByRole("dialog", { name: "Public Stripe" }),
    ).not.toBeInTheDocument();
  });

  it("finishes an OpenID flow when the callback wins before Ably polling starts", async () => {
    context.mocks.data.connectors([]);
    const threadId = "00000000-0000-4000-a000-000000000102";
    const callbackPrompt = "Re-check Steam, then continue";
    let continuationPrompt: string | null = null;
    const { authWindow } = mockConnectorOpenIdStart({
      popupClosed: false,
      onStart: () => {
        context.mocks.data.connectors([
          connectedConnectorResponse({
            slug: "steam",
            authMethod: "openid",
            updatedAt: "2026-01-01T00:00:01Z",
          }),
        ]);
      },
    });
    mockPublicConnectorStatus(steamOpenIdConnectorStatus());
    context.mocks.api(userConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledConnectorSlugs: ["steam"] });
    });
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      continuationPrompt = body.prompt ?? null;
      return respond(201, {
        runId: "00000000-0000-4000-a000-000000000202",
        threadId,
      });
    });

    detachedSetupPage({
      context,
      path: `/connectors/steam/connect?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Steam to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://openid.test/steam/authorize",
      );
      expect(screen.getByText("Public Steam connected")).toBeInTheDocument();
      expect(continuationPrompt).toBe(callbackPrompt);
    });
  });

  it("does not reuse an open provider connect dialog across routed agent ids", async () => {
    mockPublicConnectorStatus(
      publicOAuthConnectorStatus({
        slug: "github",
        label: "Public GitHub",
        singleAuthCodeAuthMethodId: null,
      }),
    );

    detachedSetupPage({
      context,
      path: `/connectors/github/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public GitHub to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await screen.findByRole("dialog", { name: "Public GitHub" });

    context.store.set(detachedNavigateTo$, ROUTES.directedConnect, {
      pathParams: { connectorSlug: "github" },
      searchParams: new URLSearchParams({ agentId: SECOND_AGENT_ID }),
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Public GitHub" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Zero needs Public GitHub to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("asks the server to connect and authorize a manual grant", async () => {
    mockPublicConnectorStatus(
      publicManualTokenConnectorStatus({
        slug: "axiom",
        label: "Public Axiom",
        placeholder: "public-xaat",
      }),
    );
    let submittedValues: Record<string, string> | null = null;
    const threadId = "00000000-0000-4000-a000-000000000103";
    const callbackPrompt = "Re-check Axiom, then continue";
    let continuationPrompt: string | null = null;
    context.mocks.api(
      connectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.connectorSlug).toBe("axiom");
        expect(body.agentId).toBe(AGENT_ID);
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
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      },
    );
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      continuationPrompt = body.prompt ?? null;
      return respond(201, {
        runId: "00000000-0000-4000-a000-000000000203",
        threadId,
      });
    });
    detachedSetupPage({
      context,
      path: `/connectors/axiom/connect?agentId=${AGENT_ID}&threadId=${threadId}&callbackPrompt=${encodeURIComponent(callbackPrompt)}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Axiom to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    const axiomDialog = await screen.findByRole("dialog", {
      name: "Public Axiom",
    });
    await fill(
      within(axiomDialog).getByPlaceholderText("public-xaat"),
      "xaat-directed-connect",
    );
    click(getButtonByText("Save"));

    await waitFor(() => {
      expect(submittedValues).toStrictEqual({
        apiToken: "xaat-directed-connect",
      });
      expect(continuationPrompt).toBe(callbackPrompt);
      expect(
        screen.queryByRole("dialog", { name: "Public Axiom" }),
      ).not.toBeInTheDocument();
    });
  });

  it("does not reuse an open manual grant dialog across routed connector slugs", async () => {
    mockPublicConnectorStatuses([
      publicManualTokenConnectorStatus({
        slug: "axiom",
        label: "Public Axiom",
        placeholder: "public-xaat",
      }),
      publicManualTokenConnectorStatus({
        slug: "stripe",
        label: "Public Stripe",
        placeholder: "public-stripe-key",
      }),
    ]);

    detachedSetupPage({
      context,
      path: `/connectors/axiom/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Axiom to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await screen.findByRole("dialog", {
      name: "Public Axiom",
    });

    context.store.set(detachedNavigateTo$, ROUTES.directedConnect, {
      pathParams: { connectorSlug: "stripe" },
      searchParams: new URLSearchParams({ agentId: AGENT_ID }),
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Public Axiom" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "Public Stripe" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Zero needs Public Stripe to proceed"),
      ).toBeInTheDocument();
    });
  });

  it("does not reuse an open manual grant dialog across routed agent ids", async () => {
    mockPublicConnectorStatus(
      publicManualTokenConnectorStatus({
        slug: "axiom",
        label: "Public Axiom",
        placeholder: "public-xaat",
      }),
    );

    detachedSetupPage({
      context,
      path: `/connectors/axiom/connect?agentId=${AGENT_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Zero needs Public Axiom to proceed"),
      ).toBeInTheDocument();
    });
    click(getButtonByText("Connect"));

    await screen.findByRole("dialog", {
      name: "Public Axiom",
    });

    context.store.set(detachedNavigateTo$, ROUTES.directedConnect, {
      pathParams: { connectorSlug: "axiom" },
      searchParams: new URLSearchParams({ agentId: SECOND_AGENT_ID }),
    });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Public Axiom" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Zero needs Public Axiom to proceed"),
      ).toBeInTheDocument();
    });
  });
});
