import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestCallback,
  createTestSlackOrgInstallation,
  createTestRequest,
  seedTestSlackOrgConnection,
  completeTestRun,
  createSignedCallbackRequest,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { POST } from "../route";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";

// The staff org ID whose FNV-1a hash (afce210e) is listed in STAFF_ORG_ID_HASHES,
// enabling the AuditLink feature switch for that org.
const STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

const context = testContext();

interface OrgCallbackPayload {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  connectionId: string;
  agentId: string;
  existingSessionId?: string | undefined;
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
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: {
        workspaceId: "T-test",
      },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      {
        runId,
        status: "completed",
        payload: {
          workspaceId: "T-test",
          channelId: undefined as unknown as string,
          threadTs: undefined as unknown as string,
          messageTs: undefined as unknown as string,
          connectionId: undefined as unknown as string,
          agentId: undefined as unknown as string,
        },
      },
      secret,
    );
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("verifyCallback returns correct payload for valid request", async () => {
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });

    const payload: OrgCallbackPayload = {
      workspaceId: uniqueId("T-ws"),
      channelId: uniqueId("C-ch"),
      threadTs: uniqueId("ts"),
      messageTs: uniqueId("ts"),
      connectionId: uniqueId("conn"),
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "progress", payload },
      secret,
    );

    // Call verifyCallback directly to see what it returns
    const { verifyCallback } =
      await import("../../../../../../../src/lib/infra/callback");
    const log = { warn: () => {} };
    const result = await verifyCallback(request, log);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const p = result.data.payload as Record<string, unknown>;
      expect(p).toBeDefined();
      expect(typeof p.workspaceId).toBe("string");
      expect(typeof p.channelId).toBe("string");
      expect(typeof p.agentId).toBe("string");
      expect(p.workspaceId).toBe(payload.workspaceId);
    }
  });

  it("handles progress status by setting thinking status", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });

    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId: uniqueId("C-ch"),
      threadTs: uniqueId("ts"),
      messageTs: uniqueId("ts"),
      connectionId,
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "progress", payload },
      secret,
    );

    const response = await POST(request);
    const data = await response.json();

    expect({ status: response.status, data }).toEqual(
      expect.objectContaining({ status: 200, data: { success: true } }),
    );

    // Verify thread status was set
    const { WebClient } = await import("@slack/web-api");
    const mockClient = new WebClient();
    expect(mockClient.assistant.threads.setStatus).toHaveBeenCalled();
  });

  it("posts completion message to Slack thread", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await completeTestRun(user.userId, runId);

    const channelId = uniqueId("C-ch");
    const threadTs = uniqueId("ts");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId,
      threadTs,
      messageTs: threadTs,
      connectionId,
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);
    const data = await response.json();

    expect({ status: response.status, data }).toEqual(
      expect.objectContaining({ status: 200, data: { success: true } }),
    );

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
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });

    const channelId = uniqueId("C-ch");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId,
      threadTs: uniqueId("ts"),
      messageTs: uniqueId("ts"),
      connectionId,
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "failed", error: "Something broke", payload },
      secret,
    );
    const response = await POST(request);
    const data = await response.json();

    expect({ status: response.status, data }).toEqual(
      expect.objectContaining({ status: 200, data: { success: true } }),
    );

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
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });

    const payload: OrgCallbackPayload = {
      workspaceId: "T-nonexistent",
      channelId: uniqueId("C-ch"),
      threadTs: uniqueId("ts"),
      messageTs: uniqueId("ts"),
      connectionId: uniqueId("conn"),
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);
    const data = await response.json();

    // Should fail with 404 (installation not found), not 400 (payload parse)
    expect({ status: response.status, data }).toEqual(
      expect.objectContaining({
        status: 404,
        data: { error: "Slack installation not found" },
      }),
    );
  });

  it("clears thread status after posting completion", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await completeTestRun(user.userId, runId);

    const threadTs = uniqueId("ts");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId: uniqueId("C-ch"),
      threadTs,
      messageTs: threadTs,
      connectionId,
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);
    const data = await response.json();

    expect({ status: response.status, data }).toEqual(
      expect.objectContaining({ status: 200, data: { success: true } }),
    );

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

  it("omits audit link block when AuditLink switch is off", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    // Use a non-staff orgId so the AuditLink feature switch is disabled
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await completeTestRun(user.userId, runId);

    const channelId = uniqueId("C-ch");
    const threadTs = uniqueId("ts");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId,
      threadTs,
      messageTs: threadTs,
      connectionId,
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);
    expect(response.status).toBe(200);

    const { WebClient } = await import("@slack/web-api");
    const mockClient = new WebClient();
    const call = (mockClient.chat.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { blocks: unknown[] };
    const blocksStr = JSON.stringify(call.blocks);
    expect(blocksStr).not.toContain("Audit");
    expect(blocksStr).not.toContain("clipboard");
  });

  it("includes audit link block when AuditLink switch is on", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    // Use the staff orgId whose hash is in STAFF_ORG_ID_HASHES, enabling AuditLink
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
      orgId: STAFF_ORG_ID,
    });
    await completeTestRun(user.userId, runId);

    const channelId = uniqueId("C-ch");
    const threadTs = uniqueId("ts");
    const payload: OrgCallbackPayload = {
      workspaceId,
      channelId,
      threadTs,
      messageTs: threadTs,
      connectionId,
      agentId: composeId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org",
      payload: { ...payload },
    });

    const request = createSignedCallbackRequest(
      "http://localhost/api/internal/callbacks/slack/org",
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);
    expect(response.status).toBe(200);

    const { WebClient } = await import("@slack/web-api");
    const mockClient = new WebClient();
    const call = (mockClient.chat.postMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as { blocks: unknown[] };
    const blocksStr = JSON.stringify(call.blocks);
    expect(blocksStr).toContain("Audit");
  });
});
