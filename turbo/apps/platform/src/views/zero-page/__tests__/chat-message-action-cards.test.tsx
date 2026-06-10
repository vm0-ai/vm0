import type { ConnectorResponse } from "@vm0/api-contracts/contracts/connector-schemas";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
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
          status: "completed",
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
});
