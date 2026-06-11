import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import {
  zeroUserPermissionGrantsContract,
  type UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
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

    await user.click(within(permissionCard).getByText("Confirm"));

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
    });
  });

  it("lets users change permission duration before confirming", async () => {
    const user = userEvent.setup({ delay: null });
    const permissionAuthorizeUrl = `https://app.vm0.ai/agents/${AGENT_ID}/permissions?ref=slack&permission=admin.analytics%3Aread&action=allow&expiresIn=24h`;
    let capturedBody: unknown = null;
    context.mocks.api(zeroUserPermissionGrantsContract.list, ({ respond }) => {
      return respond(200, []);
    });
    context.mocks.api(
      zeroUserPermissionGrantsContract.upsert,
      ({ body, respond }) => {
        capturedBody = body;
        return respond(200, {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: body.permission,
          action: body.action,
          expiresAt: "2026-06-16T11:01:00.000Z",
          createdAt: "2026-06-09T11:00:00Z",
          updatedAt: "2026-06-09T11:01:00Z",
        });
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
    await user.click(
      within(permissionCard).getByLabelText("Permission duration"),
    );
    await user.click(await screen.findByText("7 days"));

    await waitFor(() => {
      expect(within(permissionCard).getByText("7 days")).toBeInTheDocument();
    });

    await user.click(within(permissionCard).getByText("Confirm"));

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permissions updated"),
      ).toBeInTheDocument();
      expect(capturedBody).toMatchObject({
        agentId: AGENT_ID,
        connectorRef: "slack",
        permission: "admin.analytics:read",
        action: "allow",
        expiresIn: "7d",
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
      zeroUserPermissionGrantsContract.upsert,
      ({ body, respond }) => {
        const grant: UserPermissionGrantResponse = {
          agentId: body.agentId,
          connectorRef: body.connectorRef,
          permission: body.permission,
          action: body.action,
          expiresAt: null,
          createdAt: grants[0]?.createdAt ?? "2026-06-09T10:30:00Z",
          updatedAt: "2026-06-09T11:02:00Z",
        };
        grants = [grant];
        return respond(200, grant);
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

    await user.click(within(permissionCard).getByText("Confirm"));

    await waitFor(() => {
      expect(
        within(permissionCard).getByText("Permission denied"),
      ).toBeInTheDocument();
    });
  });
});
