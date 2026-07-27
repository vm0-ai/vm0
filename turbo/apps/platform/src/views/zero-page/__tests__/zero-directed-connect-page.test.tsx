import {
  zeroConnectorManualGrantContract,
  zeroConnectorNoAuthGrantContract,
  zeroConnectorOpenIdStartContract,
  zeroConnectorOauthStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { chatEventsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import {
  zeroConnectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@vm0/api-contracts/contracts/zero-connector-catalog";
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

function connectorIcon(connectorRef: string) {
  return {
    url: `https://icons.example.test/${connectorRef}.svg`,
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
  context.mocks.api(zeroConnectorCatalogContract.status, ({ respond }) => {
    return respond(200, { connectors: [...connectors] });
  });
}

function publicManualTokenConnectorStatus(args: {
  readonly connectorRef: PublicConnectorCatalogStatusItem["connectorRef"];
  readonly label: string;
  readonly placeholder: string;
}): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: args.connectorRef,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.connectorRef),
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
  readonly connectorRef: PublicConnectorCatalogStatusItem["connectorRef"];
  readonly label: string;
  readonly singleAuthCodeAuthMethodId: string | null;
}): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: args.connectorRef,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.connectorRef),
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
  readonly connectorRef: PublicConnectorCatalogStatusItem["connectorRef"];
  readonly label: string;
}): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: args.connectorRef,
    label: args.label,
    description: `${args.label} description`,
    icon: connectorIcon(args.connectorRef),
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
  readonly type: ConnectorResponse["type"];
  readonly authMethod: string;
  readonly updatedAt: string;
}): ConnectorResponse {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    type: args.type,
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

function steamOpenIdConnectorStatus(): PublicConnectorCatalogStatusItem {
  return {
    connectorRef: "steam",
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
    zeroConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      args?.onStart?.(body.agentId, body.authorizeAgent);
      return respond(200, {
        authorizationUrl: `https://oauth.test/${params.type}/authorize`,
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
    zeroConnectorOpenIdStartContract.start,
    ({ params, respond }) => {
      args?.onStart?.();
      return respond(200, {
        authorizationUrl: `https://openid.test/${params.type}/authorize`,
      });
    },
  );
  context.mocks.api(zeroConnectorOauthStartContract.start, ({ never }) => {
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
      connectorRef: "github",
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
        connectorRef: "stripe",
        label: "Public Stripe",
      }),
    );
    let connectCalls = 0;
    const threadId = "00000000-0000-4000-a000-000000000101";
    const callbackPrompt = "Re-check Stripe, then continue";
    let continuationPrompt: string | null = null;
    context.mocks.api(
      zeroConnectorNoAuthGrantContract.connect,
      ({ body, params, respond }) => {
        connectCalls += 1;
        expect(params.type).toBe("stripe");
        expect(body).toStrictEqual({
          authMethod: "api",
          agentId: AGENT_ID,
          authorizeAgent: true,
        });
        return respond(200, {
          id: crypto.randomUUID(),
          type: "stripe",
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
            type: "steam",
            authMethod: "openid",
            updatedAt: "2026-01-01T00:00:01Z",
          }),
        ]);
      },
    });
    mockPublicConnectorStatus(steamOpenIdConnectorStatus());
    context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
      return respond(200, { enabledTypes: ["steam"] });
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
        connectorRef: "github",
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
      pathParams: { type: "github" },
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
        connectorRef: "axiom",
        label: "Public Axiom",
        placeholder: "public-xaat",
      }),
    );
    let submittedValues: Record<string, string> | null = null;
    const threadId = "00000000-0000-4000-a000-000000000103";
    const callbackPrompt = "Re-check Axiom, then continue";
    let continuationPrompt: string | null = null;
    context.mocks.api(
      zeroConnectorManualGrantContract.connect,
      ({ body, params, respond }) => {
        expect(params.type).toBe("axiom");
        expect(body.agentId).toBe(AGENT_ID);
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

  it("does not reuse an open manual grant dialog across routed connector types", async () => {
    mockPublicConnectorStatuses([
      publicManualTokenConnectorStatus({
        connectorRef: "axiom",
        label: "Public Axiom",
        placeholder: "public-xaat",
      }),
      publicManualTokenConnectorStatus({
        connectorRef: "stripe",
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
      pathParams: { type: "stripe" },
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
        connectorRef: "axiom",
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
      pathParams: { type: "axiom" },
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
