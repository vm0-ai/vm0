import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroWorkflowsDetailContract,
  type ZeroWorkflowDetailResponse,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  zeroUserPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { UNKNOWN_PERMISSION_GRANT } from "@vm0/connectors/firewall-types";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const WORKFLOW_ID = "f0000001-0000-4000-a000-000000000901";
const THREAD_ID = "thread-action-cards";

function connectedConnector(
  overrides: Pick<ConnectorResponse, "type" | "authMethod"> &
    Partial<ConnectorResponse>,
): ConnectorResponse {
  return {
    id: crypto.randomUUID(),
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function mockAgentConnectorAuthorizations(initialTypes: string[]): void {
  let enabledTypes = initialTypes;
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledTypes });
  });
  context.mocks.api(zeroUserConnectorsContract.update, ({ body, respond }) => {
    enabledTypes = body.enabledTypes;
    return respond(200, { enabledTypes });
  });
}

function workflowDetailResponse(
  overrides: Partial<ZeroWorkflowDetailResponse> = {},
): ZeroWorkflowDetailResponse {
  return {
    id: WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: null,
    agentDisplayName: null,
    name: "daily-inbox-triage",
    displayName: "Daily inbox triage",
    description: null,
    visibility: "private",
    requestToPublish: false,
    ownerUserId: "test-user-123",
    canManage: true,
    createdByUserId: "test-user-123",
    updatedByUserId: "test-user-123",
    createdAt: "2026-06-09T10:00:00Z",
    updatedAt: "2026-06-09T10:00:00Z",
    instruction: null,
    files: null,
    fileContents: null,
    triggers: [],
    ...overrides,
  };
}

function encodeBase64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function buttonByText(text: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function waitForButtonByText(
  text: string,
  container: ParentNode,
): Promise<HTMLElement> {
  let button: HTMLElement | undefined;
  await waitFor(() => {
    button = buttonByText(text, container);
    expect(button).toBeEnabled();
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function confirmPermissionAction(
  user: ReturnType<typeof userEvent.setup>,
  card: HTMLElement,
): Promise<void> {
  await user.click(await waitForButtonByText("Confirm", card));
}

describe("chat message action cards", () => {
  it("lets users authorize connectors and confirm permissions from assistant messages", async () => {
    const user = userEvent.setup({ delay: null });
    const connectorAuthorizeUrl = `https://app.vm0.ai/connectors/github/authorize?agentId=${AGENT_ID}`;
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`;

    context.mocks.data.connectors([
      connectedConnector({
        type: "github",
        authMethod: "oauth",
        externalUsername: "octocat",
      }),
    ]);
    mockAgentConnectorAuthorizations([]);
    mockChatLifecycle(context, {
      threadId: THREAD_ID,
      threadTitle: "Action cards",
      chatMessages: [
        {
          id: "msg-user-action-request",
          role: "user",
          content: "Set up the integrations",
          runId: "run-action-cards",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-action-cards",
          role: "assistant",
          content: `${connectorAuthorizeUrl}\n\n${permissionAuthorizeUrl}`,
          runId: "run-action-cards",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}`,
    });

    const connectorCard = await screen.findByTestId("connector-action-card");
    expect(within(connectorCard).getByText("GitHub")).toBeInTheDocument();
    await user.click(within(connectorCard).getByText("Connect"));

    await waitFor(() => {
      expect(within(connectorCard).getByText("Connected")).toBeInTheDocument();
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    expect(
      within(permissionCard).getByText("Slack permissions"),
    ).toBeInTheDocument();
    expect(
      within(permissionCard).getByText("Allow admin.analytics:read"),
    ).toBeInTheDocument();
    expect(within(permissionCard).getByText("24 hours")).toBeInTheDocument();

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
    });
  });

  it("lets users confirm workflow permission requests from assistant messages", async () => {
    const user = userEvent.setup({ delay: null });
    const triggerId = "f0000001-0000-4000-a000-000000000902";
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/workflows/${WORKFLOW_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=24h&triggerId=${triggerId}`;
    let capturedBody: unknown = null;

    context.mocks.api(
      zeroWorkflowsDetailContract.get,
      ({ params, respond }) => {
        if (params.workflowId !== WORKFLOW_ID) {
          return respond(404, {
            error: {
              code: "NOT_FOUND",
              message: "Workflow not found",
            },
          });
        }
        return respond(200, workflowDetailResponse());
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.list,
      ({ query, respond }) => {
        expect(query).toMatchObject({ workflowId: WORKFLOW_ID });
        expect(query).not.toHaveProperty("agentId");
        return respond(200, []);
      },
    );
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        capturedBody = body;
        expect(body).not.toHaveProperty("agentId");
        return respond(200, [
          {
            workflowId: body.workflowId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: "2026-06-10T11:00:00.000Z",
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-workflow-permission`,
      threadTitle: "Workflow permission card",
      chatMessages: [
        {
          id: "msg-user-workflow-permission-request",
          role: "user",
          content: "Workflow needs Gmail access",
          runId: "run-workflow-permission",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-workflow-permission-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-workflow-permission",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-workflow-permission`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    expect(
      within(permissionCard).getByText("Gmail permissions"),
    ).toBeInTheDocument();
    expect(
      within(permissionCard).getByText(
        "Allow messages.write for Daily inbox triage",
      ),
    ).toBeInTheDocument();
    expect(within(permissionCard).getByText("24 hours")).toBeInTheDocument();

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        workflowId: WORKFLOW_ID,
        connectorRef: "gmail",
        mode: "patch",
        grants: [
          {
            permission: "messages.write",
            action: "allow",
            expiresIn: "24h",
          },
        ],
      });
    });
  });

  it("renders custom connector proposal links as configure cards", async () => {
    const proposalUrl = `https://app.vm0.ai/connectors/custom/proposal?p=${encodeBase64UrlJson(
      {
        operation: "create",
        displayName: "Acme Internal API",
        prefixTemplates: ["https://{{variables.subdomain}}.acme.test/v1/"],
        fields: [
          {
            key: "api_key",
            label: "API key",
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
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.api_key}}",
          },
        ],
        queryInjections: [],
      },
    )}&agentId=${AGENT_ID}`;

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-custom-connector`,
      threadTitle: "Custom connector card",
      chatMessages: [
        {
          id: "msg-user-custom-connector",
          role: "user",
          content: "Set up the custom connector",
          runId: "run-custom-connector",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-custom-connector-card",
          role: "assistant",
          content: proposalUrl,
          runId: "run-custom-connector",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {},
      path: `/chats/${THREAD_ID}-custom-connector`,
    });

    const card = await screen.findByTestId("custom-connector-action-card");
    expect(within(card).getByText("Acme Internal API")).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Review, connect, and authorize this custom connector for the agent.",
      ),
    ).toBeInTheDocument();
    const configureLink = queryAllByRoleFast("link", card).find((link) => {
      return /configure/i.test(link.textContent ?? "");
    });
    expect(configureLink).toHaveAttribute("href", proposalUrl);
  });

  it("renders delegated computer use authorization links as action cards", async () => {
    const authorizationUrl =
      "https://app.vm0.ai/computer-use/authorize/vm0_computer_use_authorization_request_test";

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-computer-use-authorization`,
      threadTitle: "Computer Use authorization card",
      chatMessages: [
        {
          id: "msg-user-computer-use-authorization",
          role: "user",
          content: "Use my desktop",
          runId: "run-computer-use-authorization",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-computer-use-authorization-card",
          role: "assistant",
          content: authorizationUrl,
          runId: "run-computer-use-authorization",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      featureSwitches: {
        [FeatureSwitchKey.ComputerUseDelegatedAuthorization]: true,
      },
      path: `/chats/${THREAD_ID}-computer-use-authorization`,
    });

    const card = await screen.findByTestId("computer-use-authorization-card");
    expect(
      within(card).getByText("Computer Use authorization"),
    ).toBeInTheDocument();
    expect(
      within(card).getByText(
        "Select a Desktop host for future runs in this thread.",
      ),
    ).toBeInTheDocument();
    const authorizeLink = queryAllByRoleFast("link", card).find((link) => {
      return /authorize/i.test(link.textContent ?? "");
    });
    expect(authorizeLink).toHaveAttribute(
      "href",
      "/computer-use/authorize/vm0_computer_use_authorization_request_test",
    );
  });

  it("automatically retries permission action loading before showing an error", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=1h`;
    let listRequests = 0;
    let capturedBody: unknown = null;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      listRequests += 1;
      if (listRequests === 1) {
        throw new Error("temporary permission grant load failure");
      }
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        capturedBody = body;
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: "2026-06-09T12:00:00.000Z",
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-load-retry`,
      threadTitle: "Permission load retry",
      chatMessages: [
        {
          id: "msg-user-permission-load-retry",
          role: "user",
          content: "Allow Gmail message writes",
          runId: "run-permission-load-retry",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-load-retry-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-load-retry",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-load-retry`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    expect(
      within(permissionCard).getByText("Gmail permissions"),
    ).toBeInTheDocument();
    expect(
      within(permissionCard).getByText("Allow messages.write"),
    ).toBeInTheDocument();

    await waitForButtonByText("Confirm", permissionCard);
    expect(listRequests).toBe(2);
    expect(
      within(permissionCard).queryByText("Failed to load permissions"),
    ).not.toBeInTheDocument();

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "gmail",
        mode: "patch",
        grants: [
          {
            permission: "messages.write",
            action: "allow",
            expiresIn: "1h",
          },
        ],
      });
    });
  });

  it("does not retry non-transient permission action loading failures", async () => {
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=gmail&permission=messages.write&action=allow&expiresIn=1h`;
    let listRequests = 0;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      listRequests += 1;
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Forbidden",
        },
      });
    });

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-permission-load-forbidden`,
      threadTitle: "Permission load forbidden",
      chatMessages: [
        {
          id: "msg-user-permission-load-forbidden",
          role: "user",
          content: "Allow Gmail message writes",
          runId: "run-permission-load-forbidden",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-load-forbidden-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-load-forbidden",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-permission-load-forbidden`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitFor(() => {
      expect(
        buttonByText("Failed to load permissions", permissionCard),
      ).toBeDisabled();
    });
    expect(listRequests).toBe(1);
  });

  it("lets users change permission duration before confirming", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`;
    let capturedBody: unknown = null;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        capturedBody = body;
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: "2026-06-16T11:01:00.000Z",
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-duration`,
      threadTitle: "Permission duration",
      chatMessages: [
        {
          id: "msg-user-permission-duration-request",
          role: "user",
          content: "Allow Slack analytics for a week",
          runId: "run-permission-duration",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-duration-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-permission-duration",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-duration`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    await waitForButtonByText("Confirm", permissionCard);
    await user.click(
      within(permissionCard).getByLabelText("Permission duration"),
    );
    await user.click(await screen.findByText("7 days"));

    await waitFor(() => {
      expect(within(permissionCard).getByText("7 days")).toBeInTheDocument();
    });

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "slack",
        mode: "patch",
        grants: [
          {
            permission: "admin.analytics:read",
            action: "allow",
            expiresIn: "7d",
          },
        ],
      });
    });
  });

  it("lets users confirm unknown endpoint permissions from assistant messages", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=cloudflare&permission=${UNKNOWN_PERMISSION_GRANT}&action=allow&expiresIn=1h`;
    let capturedBody: unknown = null;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const grant = body.grants[0];
        if (!grant) {
          throw new Error("Expected a permission grant");
        }
        capturedBody = body;
        return respond(200, [
          {
            agentId: body.agentId,
            connectorRef: body.connectorRef,
            permission: grant.permission,
            action: grant.action,
            expiresAt: "2026-06-09T12:00:00.000Z",
            createdAt: "2026-06-09T11:00:00Z",
            updatedAt: "2026-06-09T11:01:00Z",
          },
        ]);
      },
    );
    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-unknown-permission`,
      threadTitle: "Unknown permission",
      chatMessages: [
        {
          id: "msg-user-unknown-permission-request",
          role: "user",
          content: "Allow the Cloudflare request",
          runId: "run-unknown-permission",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-unknown-permission-card",
          role: "assistant",
          content: permissionAuthorizeUrl,
          runId: "run-unknown-permission",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-unknown-permission`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    expect(
      within(permissionCard).getByText("Cloudflare permissions"),
    ).toBeInTheDocument();
    expect(
      within(permissionCard).getByText(`Allow ${UNKNOWN_PERMISSION_GRANT}`),
    ).toBeInTheDocument();

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "cloudflare",
        mode: "patch",
        grants: [
          {
            permission: UNKNOWN_PERMISSION_GRANT,
            action: "allow",
            expiresIn: "1h",
          },
        ],
      });
    });
  });

  it("lets users deny a permission request from an assistant message", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionDenyUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=deny`;
    let grants: UserPermissionGrantResponse[] = [
      {
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "admin.analytics:read",
        action: "allow",
        expiresAt: null,
        createdAt: "2026-06-09T10:30:00Z",
        updatedAt: "2026-06-09T10:30:00Z",
      },
    ];
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, grants);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.apply,
      ({ body, respond }) => {
        const appliedGrant = body.grants[0];
        if (!appliedGrant) {
          throw new Error("Expected a permission grant");
        }
        expect(body.mode).toBe("patch");
        const grant: UserPermissionGrantResponse = {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: appliedGrant.permission,
          action: appliedGrant.action,
          expiresAt: null,
          createdAt: grants[0]?.createdAt ?? "2026-06-09T10:30:00Z",
          updatedAt: "2026-06-09T11:02:00Z",
        };
        grants = [grant];
        return respond(200, [grant]);
      },
    );

    mockChatLifecycle(context, {
      threadId: `${THREAD_ID}-deny`,
      threadTitle: "Permission action",
      chatMessages: [
        {
          id: "msg-user-permission-deny-request",
          role: "user",
          content: "Block Slack analytics access",
          runId: "run-permission-deny",
          createdAt: "2026-06-09T11:00:00Z",
        },
        {
          id: "msg-assistant-permission-deny-card",
          role: "assistant",
          content: permissionDenyUrl,
          runId: "run-permission-deny",
          createdAt: "2026-06-09T11:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${THREAD_ID}-deny`,
    });

    const permissionCard = await screen.findByTestId("permission-action-card");
    expect(
      within(permissionCard).getByText("Slack permissions"),
    ).toBeInTheDocument();
    expect(
      within(permissionCard).getByText("Deny admin.analytics:read"),
    ).toBeInTheDocument();

    await confirmPermissionAction(user, permissionCard);

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permission denied"),
      ).toBeInTheDocument();
    });
  });
});
