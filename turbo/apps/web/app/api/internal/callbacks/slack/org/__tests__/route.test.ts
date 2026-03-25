import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
  createTestRequest,
  completeTestRun,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../src/lib/callback/hmac";
import { POST } from "../route";

const context = testContext();

interface OrgCallbackPayload {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  connectionId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
}

function createCallbackRequest(
  body: {
    runId: string;
    status: "completed" | "failed" | "progress";
    error?: string;
    payload: OrgCallbackPayload;
  },
  secret: string,
): NextRequest {
  const bodyString = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest(
    "http://localhost/api/internal/callbacks/slack/org",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VM0-Signature": signature,
        "X-VM0-Timestamp": timestamp.toString(),
      },
      body: bodyString,
    },
  );
}

describe("POST /api/internal/callbacks/slack/org", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  async function setupOrgSlack() {
    const workspaceId = uniqueId("T-ws");
    const { slackWorkspaceId } = await createTestSlackOrgInstallation({
      workspaceId,
      orgId: user.orgId,
    });
    const { connectionId } = await seedTestSlackOrgConnection({
      slackUserId: uniqueId("U-slack"),
      slackWorkspaceId: slackWorkspaceId,
      vm0UserId: user.userId,
    });
    return { workspaceId: slackWorkspaceId, connectionId };
  }

  it("rejects request with invalid payload (missing required fields)", async () => {
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRun(composeId, "Test prompt");

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: {
        // Missing required fields
        workspaceId: "T-test",
      },
    });

    const request = createCallbackRequest(
      {
        runId,
        status: "completed",
        payload: {
          workspaceId: "T-test",
          channelId: undefined as unknown as string,
          threadTs: undefined as unknown as string,
          messageTs: undefined as unknown as string,
          connectionId: undefined as unknown as string,
          agentName: undefined as unknown as string,
          composeId: undefined as unknown as string,
        },
      },
      secret,
    );
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("handles progress status by setting thinking status", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRun(composeId, "Test prompt");

    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId: uniqueId("C-ch"),
      threadTs: uniqueId("ts"),
      messageTs: uniqueId("ts"),
      connectionId,
      agentName: "test-agent",
      composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "progress", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify thread status was set
    const { WebClient } = await import("@slack/web-api");
    const mockClient = new WebClient();
    expect(mockClient.assistant.threads.setStatus).toHaveBeenCalled();
  });

  it("posts completion message to Slack thread", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const channelId = uniqueId("C-ch");
    const threadTs = uniqueId("ts");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId,
      threadTs,
      messageTs: threadTs,
      connectionId,
      agentName: "test-agent",
      composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify message was posted to the thread
    const { WebClient } = await import("@slack/web-api");
    const mockClient = new WebClient();
    expect(mockClient.chat.postMessage).toHaveBeenCalled();
    const call = (
      mockClient.chat.postMessage as ReturnType<typeof import("vitest").vi.fn>
    ).mock.calls[0]![0] as { channel: string; thread_ts: string };
    expect(call.channel).toBe(channelId);
    expect(call.thread_ts).toBe(threadTs);
  });

  it("posts error message for failed status", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRun(composeId, "Test prompt");

    const channelId = uniqueId("C-ch");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId,
      threadTs: uniqueId("ts"),
      messageTs: uniqueId("ts"),
      connectionId,
      agentName: "test-agent",
      composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "failed", error: "Something broke", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify error message was posted
    const { WebClient } = await import("@slack/web-api");
    const mockClient = new WebClient();
    expect(mockClient.chat.postMessage).toHaveBeenCalled();
    const call = (
      mockClient.chat.postMessage as ReturnType<typeof import("vitest").vi.fn>
    ).mock.calls[0]![0] as { channel: string; text: string };
    expect(call.channel).toBe(channelId);
    expect(call.text).toContain("Something broke");
  });

  it("returns 404 when installation is not found (non-progress)", async () => {
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRun(composeId, "Test prompt");

    const payload: OrgCallbackPayload = {
      workspaceId: "T-nonexistent",
      channelId: uniqueId("C-ch"),
      threadTs: uniqueId("ts"),
      messageTs: uniqueId("ts"),
      connectionId: uniqueId("conn"),
      agentName: "test-agent",
      composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(404);
  });

  it("clears thread status after posting completion", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await completeTestRun(user.userId, runId);

    const threadTs = uniqueId("ts");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId: uniqueId("C-ch"),
      threadTs,
      messageTs: threadTs,
      connectionId,
      agentName: "test-agent",
      composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "completed", payload },
      secret,
    );
    await POST(request);

    // Thread status should be cleared (empty string)
    const { WebClient } = await import("@slack/web-api");
    const mockClient = new WebClient();
    const setStatusMock = mockClient.assistant.threads.setStatus as ReturnType<
      typeof import("vitest").vi.fn
    >;
    // Last call should clear the status (empty string)
    const lastCall = setStatusMock.mock.calls[
      setStatusMock.mock.calls.length - 1
    ]![0] as { status: string };
    expect(lastCall.status).toBe("");
  });
});
