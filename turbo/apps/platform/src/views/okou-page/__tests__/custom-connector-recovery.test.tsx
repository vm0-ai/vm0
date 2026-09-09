import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { agentCustomConnectorsContract } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import {
  customConnectorByIdContract,
  customConnectorOAuth2Contract,
  customConnectorsContract,
  customConnectorValuesContract,
  type CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  mcpCustomConnector,
  getConnectorAction,
  getConnectorCard,
  queryConnectorAction,
  listAgent,
  mockOAuthCompletions,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000051";
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000052";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "55555555-5555-4555-8555-555555555555";

function account(
  connector: CustomConnectorResponse,
): ConnectorAccountConnection {
  return {
    id: ACCOUNT_ID,
    target: { kind: "custom", customConnectorId: connector.id },
    authMethod: "manual",
    displayName: "Run-selected account",
    isDefault: false,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function connectedDefinition(kind: "http" | "mcp"): CustomConnectorResponse {
  const overrides = {
    slug: kind === "http" ? "_acme-search" : "_acme-mcp",
    connected: true,
    connectedAccountId: DEFAULT_ACCOUNT_ID,
    missingRequiredFields: [],
    configuredFieldKeys: ["secret"],
  };
  return kind === "http"
    ? customConnector(overrides)
    : mcpCustomConnector(overrides);
}

function mockDefinition(connector: CustomConnectorResponse): void {
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
  context.mocks.data.agents([
    listAgent(AGENT_ID, "Research"),
    listAgent(OTHER_AGENT_ID, "Support"),
  ]);
  context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
    return respond(200, { grants: [] });
  });
  context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
    return respond(200, {
      summaries: [
        {
          target: { kind: "custom", customConnectorId: connector.id },
          accountCount: 2,
          attentionCount: 1,
          defaultConnection: {
            ...account(connector),
            id: DEFAULT_ACCOUNT_ID,
            displayName: "Healthy default",
            isDefault: true,
            connectionStatus: "connected",
            reconnectReason: null,
          },
        },
      ],
    });
  });
}

test.each(["http", "mcp"] as const)(
  "Reconnect the selected custom %s account and continue only after confirmation",
  async (kind) => {
    const connector = connectedDefinition(kind);
    mockDefinition(connector);
    const selected = account(connector);
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, query, respond }) => {
        expect(params.connectionId).toBe(ACCOUNT_ID);
        expect(query).toStrictEqual({
          kind: "custom",
          customConnectorId: connector.id,
        });
        return respond(200, selected);
      },
    );
    context.mocks.api(
      customConnectorValuesContract.set,
      ({ params, body, respond }) => {
        expect(params.id).toBe(connector.id);
        expect(body.account).toStrictEqual({
          intent: "reconnect",
          connectionId: ACCOUNT_ID,
        });
        expect(body.values).toStrictEqual([
          { key: "secret", kind: "secret", value: "replacement-secret" },
        ]);
        return respond(200, { ...connector, connectedAccountId: ACCOUNT_ID });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ params, body, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        return respond(200, { grants: body.grants });
      },
    );
    const prompts: string[] = [];
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      if ("prompt" in body && body.prompt) {
        prompts.push(body.prompt);
      }
      return respond(201, {
        threadId: THREAD_ID,
        runId: "66666666-6666-4666-8666-666666666666",
      });
    });
    await setupPage({
      context,
      path: `/connectors/${connector.slug}/reconnect/${ACCOUNT_ID}?agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Continue+the+original+task`,
      featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: true },
    });
    await expect(
      screen.findByText("Run-selected account"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("Healthy default")).not.toBeInTheDocument();
    click(getConnectorAction("button", "Reconnect"));
    const dialog = await screen.findByRole("dialog", {
      name: `Connect ${connector.displayName}`,
    });
    expect(prompts).toStrictEqual([]);
    await fill(within(dialog).getByLabelText("Secret"), "replacement-secret");
    click(getConnectorAction("button", "Save", dialog));
    await waitFor(() => {
      return expect(prompts).toStrictEqual(["Continue the original task"]);
    });
    await waitFor(() => {
      return expect(dialog).not.toBeInTheDocument();
    });
  },
);

test.each([false, true])(
  "Continue a permission-bundled reconnect only with existing Agent access: %s",
  async (authorized) => {
    const connector = customConnector({
      slug: "_acme-search",
      connected: true,
      connectedAccountId: DEFAULT_ACCOUNT_ID,
      missingRequiredFields: [],
      configuredFieldKeys: ["secret"],
      permissionBundleRef: "builtin:feishu@1",
    });
    mockDefinition(connector);
    context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
      return respond(200, account(connector));
    });
    context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
      return respond(200, { ...connector, connectedAccountId: ACCOUNT_ID });
    });
    context.mocks.api(agentCustomConnectorsContract.get, ({ respond }) => {
      return respond(200, {
        grants: authorized
          ? [{ customConnectorId: connector.id, permissionNames: [] }]
          : [],
      });
    });
    context.mocks.api(agentCustomConnectorsContract.update, () => {
      throw new Error(
        "Connecting must not implicitly grant bundled permissions",
      );
    });
    const prompts: string[] = [];
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      if ("prompt" in body && body.prompt) {
        prompts.push(body.prompt);
      }
      return respond(201, {
        threadId: THREAD_ID,
        runId: "66666666-6666-4666-8666-666666666666",
      });
    });
    await setupPage({
      context,
      path: `/connectors/${connector.slug}/reconnect/${ACCOUNT_ID}?agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Continue+after+reconnect`,
    });
    await screen.findByText("Run-selected account");
    click(getConnectorAction("button", "Reconnect"));
    const dialog = await screen.findByRole("dialog", {
      name: `Connect ${connector.displayName}`,
    });
    await fill(within(dialog).getByLabelText("Secret"), "replacement-secret");
    click(getConnectorAction("button", "Save", dialog));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(prompts).toStrictEqual(
      authorized ? ["Continue after reconnect"] : [],
    );
  },
);

test.each(["missing", "invalid"] as const)(
  "Keep a %s exact custom account unavailable despite a healthy default",
  async (state) => {
    const connector = connectedDefinition("http");
    mockDefinition(connector);
    context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Account unavailable" },
      });
    });
    context.mocks.api(customConnectorValuesContract.set, () => {
      throw new Error("An unavailable target must not reconnect a sibling");
    });
    context.mocks.api(chatEventsContract.send, () => {
      throw new Error("An unavailable target cannot confirm a callback");
    });
    await setupPage({
      context,
      path: `/connectors/${connector.slug}/reconnect/${state === "missing" ? ACCOUNT_ID : "invalid"}?agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Continue`,
    });
    await expect(
      screen.findByText("Accounts are unavailable for this connector."),
    ).resolves.toBeInTheDocument();
    const settings = getConnectorAction("link", "Connectors");
    expect(settings).toHaveAttribute("href", "/connectors?tab=custom");
    click(settings);
    await expect(
      screen.findByText(connector.displayName),
    ).resolves.toBeInTheDocument();
  },
);

test.each([
  "completed",
  "completed-unhealthy-default",
  "cancelled",
  "account-updated",
  "other-account",
] as const)(
  "Confirm a custom OAuth reconnect using its exact completion receipt: %s",
  async (outcome) => {
    const completed =
      outcome === "completed" || outcome === "completed-unhealthy-default";
    const defaultConnected = outcome !== "completed-unhealthy-default";
    const connector = customConnector({
      slug: "_acme-oauth",
      authMode: "oauth",
      connected: defaultConnected,
      connectedAccountId: defaultConnected ? DEFAULT_ACCOUNT_ID : undefined,
      connectedAccountUpdatedAt: defaultConnected
        ? "2026-01-01T00:00:00Z"
        : undefined,
      fields: [],
      missingRequiredFields: defaultConnected ? [] : ["oauth"],
      configuredFieldKeys: [],
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
    mockDefinition(connector);
    if (!defaultConnected) {
      context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
        return respond(200, {
          summaries: [
            {
              target: { kind: "custom", customConnectorId: connector.id },
              accountCount: 2,
              attentionCount: 2,
              defaultConnection: {
                ...account(connector),
                id: DEFAULT_ACCOUNT_ID,
                displayName: "Expired default",
                authMethod: "oauth",
                isDefault: true,
              },
            },
          ],
        });
      });
    }
    const completedAttempts = mockOAuthCompletions(context);
    const oauthAttemptId = crypto.randomUUID();
    let reconnected = false;
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, query, respond }) => {
        expect(params.connectionId).toBe(ACCOUNT_ID);
        expect(query).toStrictEqual({
          kind: "custom",
          customConnectorId: connector.id,
        });
        return respond(200, {
          ...account(connector),
          authMethod: "oauth",
          connectionStatus: reconnected ? "connected" : "reconnect-required",
          reconnectReason: reconnected
            ? null
            : "authorization_expired_or_revoked",
          updatedAt: reconnected
            ? "2026-01-02T00:00:00Z"
            : "2026-01-01T00:00:00Z",
        });
      },
    );
    context.mocks.api(
      customConnectorOAuth2Contract.start,
      ({ body, respond }) => {
        expect(body.account).toStrictEqual({
          intent: "reconnect",
          connectionId: ACCOUNT_ID,
        });
        reconnected = completed || outcome === "account-updated";
        if (completed || outcome === "other-account") {
          completedAttempts.set(
            oauthAttemptId,
            completed ? ACCOUNT_ID : DEFAULT_ACCOUNT_ID,
          );
        }
        return respond(200, {
          result: "authorization",
          authorizationUrl: "https://acme.test/oauth/reconnect",
          connectionId: ACCOUNT_ID,
          oauthAttemptId,
        });
      },
    );
    context.mocks.api(
      agentCustomConnectorsContract.update,
      ({ params, body, respond }) => {
        expect(params.id).toBe(AGENT_ID);
        return respond(200, { grants: body.grants });
      },
    );
    const prompts: string[] = [];
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      if ("prompt" in body && body.prompt) {
        prompts.push(body.prompt);
      }
      return respond(201, {
        threadId: THREAD_ID,
        runId: "66666666-6666-4666-8666-666666666666",
      });
    });
    const authWindow = context.mocks.browser.authWindow();
    authWindow.closed = true;
    Object.defineProperty(authWindow, "location", {
      value: { href: "" },
      configurable: true,
    });
    context.mocks.browser.open(authWindow);
    await setupPage({
      context,
      path: `/connectors/${connector.slug}/reconnect/${ACCOUNT_ID}?agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Continue+after+OAuth`,
    });
    await screen.findByText("Run-selected account");
    click(getConnectorAction("button", "Reconnect"));
    const dialog = await screen.findByRole("dialog", {
      name: `Connect ${connector.displayName}`,
    });
    click(getConnectorAction("button", "Continue", dialog));
    await waitFor(() => {
      expect(authWindow.location.href).toBe(
        "https://acme.test/oauth/reconnect",
      );
    });
    const expected = completed
      ? { prompts: ["Continue after OAuth"], canContinue: false }
      : { prompts: [], canContinue: true };
    await waitFor(() => {
      const currentDialog = screen.queryByRole("dialog", {
        name: `Connect ${connector.displayName}`,
      });
      const continueAction = currentDialog
        ? queryConnectorAction("button", "Continue", currentDialog)
        : null;
      expect({
        prompts,
        canContinue:
          continueAction !== null && !continueAction.hasAttribute("disabled"),
      }).toStrictEqual(expected);
    });
  },
);

test("Do not continue a custom reconnect callback when the dialog is cancelled", async () => {
  const connector = connectedDefinition("http");
  mockDefinition(connector);
  context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
    return respond(200, account(connector));
  });
  context.mocks.api(chatEventsContract.send, () => {
    throw new Error("Cancelling a reconnect must not continue the chat");
  });
  await setupPage({
    context,
    path: `/connectors/${connector.slug}/reconnect/${ACCOUNT_ID}?agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Continue`,
  });
  await screen.findByText("Run-selected account");
  click(getConnectorAction("button", "Reconnect"));
  const dialog = await screen.findByRole("dialog", {
    name: `Connect ${connector.displayName}`,
  });
  click(getConnectorAction("button", "Cancel", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(getConnectorAction("button", "Reconnect")).toBeEnabled();
});

test("Open the targeted custom account manager for manual account selection", async () => {
  const connector = connectedDefinition("http");
  mockDefinition(connector);
  context.mocks.api(
    connectorAccountsContract.connections,
    ({ query, respond }) => {
      expect(query).toMatchObject({
        kind: "custom",
        customConnectorId: connector.id,
      });
      return respond(200, {
        connections: [account(connector)],
        nextCursor: null,
      });
    },
  );
  await setupPage({
    context,
    path: `/connectors?tab=custom&customConnectorId=${connector.id}&view=accounts&agentId=${AGENT_ID}`,
  });
  const dialog = await screen.findByRole("dialog", {
    name: `Manage ${connector.displayName} accounts`,
  });
  await expect(
    within(dialog).findByText("Run-selected account"),
  ).resolves.toBeInTheDocument();
});

test("Keep a failed reconnect open without confirming the chat callback", async () => {
  const connector = connectedDefinition("http");
  mockDefinition(connector);
  context.mocks.api(connectorAccountsContract.connection, ({ respond }) => {
    return respond(200, account(connector));
  });
  context.mocks.api(customConnectorValuesContract.set, ({ respond }) => {
    return respond(500, {
      error: { code: "INTERNAL_SERVER_ERROR", message: "Reconnect failed" },
    });
  });
  context.mocks.api(chatEventsContract.send, () => {
    throw new Error("A failed connection cannot continue the chat");
  });
  await setupPage({
    context,
    path: `/connectors/${connector.slug}/reconnect/${ACCOUNT_ID}?agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Continue`,
  });
  await screen.findByText("Run-selected account");
  click(getConnectorAction("button", "Reconnect"));
  const dialog = await screen.findByRole("dialog", {
    name: `Connect ${connector.displayName}`,
  });
  await fill(within(dialog).getByLabelText("Secret"), "replacement-secret");
  click(getConnectorAction("button", "Save", dialog));
  await expect(
    screen.findByText("Reconnect failed"),
  ).resolves.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
});

test("Keep directed custom MCP reconnect behind its existing feature switch", async () => {
  const connector = connectedDefinition("mcp");
  mockDefinition(connector);
  context.mocks.api(connectorAccountsContract.connection, () => {
    throw new Error("Hidden MCP accounts must not be selected");
  });
  await setupPage({
    context,
    path: `/connectors/${connector.slug}/reconnect/${ACCOUNT_ID}?agentId=${AGENT_ID}`,
    featureSwitches: { [FeatureSwitchKey.CustomConnectorMcp]: false },
  });
  await expect(
    screen.findByText("Accounts are unavailable for this connector."),
  ).resolves.toBeInTheDocument();
  expect(getConnectorAction("link", "Connectors")).toHaveAttribute(
    "href",
    "/connectors?tab=custom",
  );
});

test("Review the named custom permission for the exact Agent without granting it or continuing chat", async () => {
  const connector = customConnector({
    connected: true,
    permissionBundleRef: "builtin:feishu@1",
    missingRequiredFields: [],
  });
  mockDefinition(connector);
  context.mocks.api(
    agentCustomConnectorsContract.get,
    ({ params, respond }) => {
      return respond(200, {
        grants:
          params.id === AGENT_ID
            ? [
                {
                  customConnectorId: connector.id,
                  permissionNames: ["standard:use"],
                },
              ]
            : [],
      });
    },
  );
  context.mocks.api(customConnectorByIdContract.permissions, ({ respond }) => {
    return respond(200, {
      ref: "builtin:feishu@1",
      permissions: [
        { name: "standard:use", description: "Read data" },
        { name: "messages:send-as-user", description: "Send as user" },
      ],
      defaultPolicies: {
        "standard:use": "allow",
        "messages:send-as-user": "deny",
      },
    });
  });
  context.mocks.api(agentCustomConnectorsContract.update, () => {
    throw new Error("Opening a review must not grant permissions");
  });
  context.mocks.api(chatEventsContract.send, () => {
    throw new Error("Settings review does not confirm a callback");
  });
  await setupPage({
    context,
    path: `/connectors?tab=custom&customConnectorId=${connector.id}&view=access&permission=messages%3Asend-as-user&agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Continue`,
  });
  const drawer = await screen.findByRole("dialog", {
    name: `${connector.displayName} permissions for Research`,
  });
  expect(within(drawer).getByText("messages:send-as-user")).toBeInTheDocument();
  expect(getConnectorAction("button", "Allow", drawer)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(getConnectorAction("button", "Deny", drawer)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(getConnectorAction("button", "Apply", drawer)).toBeDisabled();
  expect(
    screen.queryByRole("dialog", {
      name: `${connector.displayName} permissions for Support`,
    }),
  ).not.toBeInTheDocument();
  expect(window.location.pathname).toBe("/connectors");
});

test.each(["deleted", "ambiguous"] as const)(
  "Keep %s custom settings navigation available for manual selection",
  async (state) => {
    const connector = connectedDefinition("http");
    mockDefinition(connector);
    await setupPage({
      context,
      path: `/connectors?tab=custom&customConnectorId=${state === "deleted" ? "77777777-7777-4777-8777-777777777777" : connector.id}&view=${state === "ambiguous" ? "unknown" : "access"}`,
    });
    await expect(
      screen.findByText(connector.displayName),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
);

test.each([
  { accountCount: 0, authorized: false },
  { accountCount: 1, authorized: false },
  { accountCount: 0, authorized: true },
])(
  "Respect account availability for a permission link with $accountCount accounts and authorized=$authorized",
  async ({ accountCount, authorized }) => {
    const connector = customConnector({
      connected: accountCount > 0,
      connectedAccountId: accountCount > 0 ? DEFAULT_ACCOUNT_ID : undefined,
      missingRequiredFields: accountCount > 0 ? [] : ["secret"],
      configuredFieldKeys: accountCount > 0 ? ["secret"] : [],
      permissionBundleRef: "builtin:feishu@1",
    });
    mockDefinition(connector);
    context.mocks.api(
      agentCustomConnectorsContract.get,
      ({ params, respond }) => {
        return respond(200, {
          grants:
            authorized && params.id === AGENT_ID
              ? [{ customConnectorId: connector.id, permissionNames: [] }]
              : [],
        });
      },
    );
    context.mocks.api(connectorAccountsContract.summaries, ({ respond }) => {
      return respond(200, {
        summaries: [
          {
            target: { kind: "custom", customConnectorId: connector.id },
            accountCount,
            attentionCount: 0,
            defaultConnection:
              accountCount > 0
                ? {
                    ...account(connector),
                    id: DEFAULT_ACCOUNT_ID,
                    isDefault: true,
                    connectionStatus: "connected",
                    reconnectReason: null,
                  }
                : null,
          },
        ],
      });
    });
    context.mocks.api(
      customConnectorByIdContract.permissions,
      ({ respond }) => {
        return respond(200, {
          ref: "builtin:feishu@1",
          permissions: [
            { name: "messages:send-as-user", description: "Send as user" },
          ],
          defaultPolicies: { "messages:send-as-user": "deny" },
        });
      },
    );
    await setupPage({
      context,
      path: `/connectors?tab=custom&customConnectorId=${connector.id}&view=access&permission=messages%3Asend-as-user&agentId=${AGENT_ID}`,
    });
    await screen.findByDisplayValue("Research");

    const shouldOpen = authorized || accountCount > 0;
    const expected = {
      permissionReviewOpen: shouldOpen,
      applyEnabled: shouldOpen ? !authorized : null,
      authorizationEnabled: shouldOpen ? null : false,
    };
    await waitFor(() => {
      const drawer = screen.queryByRole("dialog", {
        name: `${connector.displayName} permissions for Research`,
      });
      const apply = drawer
        ? queryConnectorAction("button", "Apply", drawer)
        : null;
      const authorizationSwitch = screen.queryByRole("switch", {
        name: /Research/,
      });
      expect({
        permissionReviewOpen: drawer !== null,
        applyEnabled: apply ? !apply.hasAttribute("disabled") : null,
        authorizationEnabled: authorizationSwitch
          ? authorizationSwitch.getAttribute("aria-disabled") !== "true"
          : null,
      }).toStrictEqual(expected);
    });
  },
);

test.each(
  (["accounts", "access"] as const).flatMap((view) => {
    return [false, true].map((dismissed) => {
      return { view, dismissed };
    });
  }),
)(
  "Preserve manual dialog intent when delayed $view recovery finishes with dismissed=$dismissed",
  async ({ view, dismissed }) => {
    const connector = connectedDefinition("http");
    mockDefinition(connector);
    context.mocks.data.org({ id: "org_1", name: "Test Org", role: "admin" });
    const release = context.mocks.deferred<void>();
    context.mocks.api(customConnectorsContract.list, async ({ respond }) => {
      await release.promise;
      return respond(200, { connectors: [connector] });
    });
    context.mocks.api(connectorAccountsContract.connections, ({ respond }) => {
      return respond(200, {
        connections: [account(connector)],
        nextCursor: null,
      });
    });
    await setupPage({
      context,
      path: `/connectors?tab=custom&customConnectorId=${connector.id}&view=${view}&agentId=${AGENT_ID}`,
    });
    const create = await waitFor(() => {
      return getConnectorAction("button", "New connector");
    });
    click(create);
    const draft = await screen.findByRole("dialog", {
      name: "New custom connector",
    });
    await fill(within(draft).getByLabelText("Display name"), "My draft");
    if (dismissed) {
      click(getConnectorAction("button", "Close", draft));
    }
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "New custom connector" }) !== null,
      ).toBe(!dismissed);
    });

    release.resolve();

    await waitFor(() => {
      expect(getConnectorCard(connector.displayName)).toBeInTheDocument();
    });
    expect({
      draftOpen:
        screen.queryByRole("dialog", { name: "New custom connector" }) !== null,
      draftValuePresent: screen.queryByDisplayValue("My draft") !== null,
      dialogCount: screen.queryAllByRole("dialog").length,
    }).toStrictEqual({
      draftOpen: !dismissed,
      draftValuePresent: !dismissed,
      dialogCount: dismissed ? 0 : 1,
    });
    expect(
      screen.queryByRole("dialog", {
        name: `Manage ${connector.displayName} ${view}`,
      }),
    ).not.toBeInTheDocument();
  },
);

test.each(
  [false, true].flatMap((namedPermission) => {
    return [false, true].map((cleared) => {
      return { namedPermission, cleared };
    });
  }),
)(
  "Keep manual Agent search during delayed recovery with permission=$namedPermission and cleared=$cleared",
  async ({ namedPermission, cleared }) => {
    const connector = customConnector({
      connected: true,
      permissionBundleRef: "builtin:feishu@1",
      missingRequiredFields: [],
    });
    mockDefinition(connector);
    const release = context.mocks.deferred<void>();
    context.mocks.api(
      agentCustomConnectorsContract.get,
      async ({ params, respond }) => {
        await release.promise;
        return respond(200, {
          grants:
            params.id === AGENT_ID
              ? [
                  {
                    customConnectorId: connector.id,
                    permissionNames: ["standard:use"],
                  },
                ]
              : [],
        });
      },
    );
    context.mocks.api(
      customConnectorByIdContract.permissions,
      ({ respond }) => {
        return respond(200, {
          ref: "builtin:feishu@1",
          permissions: [{ name: "standard:use", description: "Read data" }],
          defaultPolicies: { "standard:use": "allow" },
        });
      },
    );
    const params = new URLSearchParams({
      tab: "custom",
      customConnectorId: connector.id,
      view: "access",
      agentId: AGENT_ID,
    });
    if (namedPermission) {
      params.set("permission", "standard:use");
    }
    await setupPage({ context, path: `/connectors?${params.toString()}` });
    const dialog = await screen.findByRole("dialog", {
      name: `Manage ${connector.displayName} access`,
    });
    const search = within(dialog).getByRole("textbox");
    await fill(search, "Support");
    if (cleared) {
      await fill(search, "");
    }
    const expectedSearch = cleared ? "" : "Support";
    expect(search).toHaveValue(expectedSearch);

    release.resolve();

    await waitFor(() => {
      expect(
        within(getConnectorCard(connector.displayName)).getByTestId(
          "connector-card-agent-access",
        ),
      ).toHaveTextContent("Used by Research");
    });
    expect(search).toHaveValue(expectedSearch);
    expect(screen.queryAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByText("Support")).toBeInTheDocument();
  },
);

test("Keep a closed custom access review closed when Agent grants arrive", async () => {
  const connector = customConnector({
    connected: true,
    permissionBundleRef: "builtin:feishu@1",
    missingRequiredFields: [],
  });
  mockDefinition(connector);
  const requested = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    agentCustomConnectorsContract.get,
    async ({ params, respond }) => {
      if (!requested.settled()) {
        requested.resolve();
      }
      await release.promise;
      return respond(200, {
        grants:
          params.id === AGENT_ID
            ? [
                {
                  customConnectorId: connector.id,
                  permissionNames: ["standard:use"],
                },
              ]
            : [],
      });
    },
  );
  context.mocks.api(customConnectorByIdContract.permissions, ({ respond }) => {
    return respond(200, {
      ref: "builtin:feishu@1",
      permissions: [
        { name: "standard:use", description: "Read data" },
        { name: "messages:send-as-user", description: "Send as user" },
      ],
      defaultPolicies: {
        "standard:use": "allow",
        "messages:send-as-user": "deny",
      },
    });
  });
  await setupPage({
    context,
    path: `/connectors?tab=custom&customConnectorId=${connector.id}&view=access&permission=messages%3Asend-as-user&agentId=${AGENT_ID}`,
  });
  await requested.promise;
  const dialog = await screen.findByRole("dialog", {
    name: `Manage ${connector.displayName} access`,
  });
  click(getConnectorAction("button", "Close", dialog));
  release.resolve();
  await waitFor(() => {
    expect(
      within(getConnectorCard(connector.displayName)).getByTestId(
        "connector-card-agent-access",
      ),
    ).toHaveTextContent("Used by Research");
  });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
