import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestCallback,
  completeTestRun,
  createSignedCallbackRequest,
  setTestRunSelectedModel,
  createTestOrgModelProvider,
} from "../../../../../../../src/__tests__/api-test-helpers";
import {
  createTestSlackOrgInstallation,
  seedTestSlackOrgConnection,
  insertTestSlackOrgThreadSession,
} from "../../../../../../../src/__tests__/db-test-seeders/slack";
import { updateOrgDefaultAgent } from "../../../../../../../src/__tests__/db-test-seeders/org";
import { POST } from "../route";
import { seedTestRun } from "../../../../../../../src/__tests__/db-test-seeders/runs";
import { seedUserFeatureSwitches } from "../../../../../../../src/__tests__/db-test-seeders/feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { reloadEnv } from "../../../../../../../src/env";

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
    const slackUserId = uniqueId("U-slack");
    const { connectionId } = await seedTestSlackOrgConnection({
      slackUserId,
      slackWorkspaceId: slackWorkspaceId,
      vm0UserId: user.userId,
    });
    return { workspaceId: slackWorkspaceId, connectionId, slackUserId };
  }

  /**
   * Seed N additional Slack connections with pre-existing thread sessions in
   * the given thread. Used to simulate other Slack users having mentioned the
   * agent earlier in the same thread.
   */
  async function seedAdditionalMentioners(
    workspaceId: string,
    channelId: string,
    threadTs: string,
    count: number,
  ): Promise<void> {
    for (let i = 0; i < count; i++) {
      const { connectionId: extraConnId } = await seedTestSlackOrgConnection({
        slackUserId: uniqueId("U-extra"),
        slackWorkspaceId: workspaceId,
        vm0UserId: uniqueId("vm0-u"),
      });
      await insertTestSlackOrgThreadSession({
        connectionId: extraConnId,
        slackChannelId: channelId,
        slackThreadTs: threadTs,
      });
    }
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
    vi.stubEnv("AXIOM_TOKEN_SESSIONS", "test-sessions-token");
    reloadEnv();

    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    context.mocks.axiom.queryAxiom
      .mockResolvedValueOnce([{ sequenceNumber: 0 }])
      .mockResolvedValueOnce([
        { eventData: { result: "HELLO_FROM_CALLBACK" } },
      ]);
    await completeTestRun(user.userId, runId, undefined, {
      lastEventSequence: 0,
    });

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
    ).mock.calls[0]![0] as {
      channel: string;
      thread_ts: string;
      text: string;
    };
    expect(call.channel).toBe(channelId);
    expect(call.thread_ts).toBe(threadTs);
    expect(call.text).toContain("HELLO_FROM_CALLBACK");
    expect(context.mocks.axiom.queryAxiom).toHaveBeenCalledTimes(2);
  });

  it("posts Codex agent_message output instead of the completion fallback", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await setTestRunSelectedModel(runId, "gpt-5.5");
    await completeTestRun(user.userId, runId);
    context.mocks.axiom.queryAxiom.mockResolvedValueOnce([
      {
        eventType: "item.completed",
        eventData: {
          item: {
            type: "agent_message",
            text: "I am okay.",
          },
        },
      },
    ]);

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
      .calls[0]![0] as { text: string; blocks: unknown[] };
    const blocksStr = JSON.stringify(call.blocks);
    expect(call.text).toBe("I am okay.");
    expect(call.text).not.toBe("Task completed successfully.");
    expect(blocksStr).toContain("gpt-5.5");
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
    // Enable AuditLink for the test user via a DB override
    await seedUserFeatureSwitches(user.orgId, user.userId, {
      [FeatureSwitchKey.AuditLink]: true,
    });
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
    expect(blocksStr).toContain("Audit");
  });

  it("includes model name when selectedModel is set and org has no default provider", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await setTestRunSelectedModel(runId, "claude-opus-4-7");
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
    expect(blocksStr).toContain("Claude Opus 4.7");
  });

  it("omits footer entirely when default agent, no selectedModel, and one thread mentioner", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    // Mark this compose as the org default so `Responded by` is suppressed.
    await updateOrgDefaultAgent(user.orgId, composeId);
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
    expect(blocksStr).not.toContain("Claude");
    expect(blocksStr).not.toContain("Reply to");
    expect(blocksStr).not.toContain("Responded by");
  });

  it("shows `Responded by X` when the responding agent is not the org default", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const agentName = uniqueId("custom");
    const { composeId } = await createTestCompose(agentName);
    // Do NOT set org default — this compose stays non-default.
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
    expect(blocksStr).toContain(`Responded by ${agentName}`);
  });

  it("omits `Responded by` when the responding agent is the org default", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("default-agent"));
    await updateOrgDefaultAgent(user.orgId, composeId);
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
    expect(blocksStr).not.toContain("Responded by");
  });

  it("shows model in footer even when selectedModel matches org default", async () => {
    await createTestOrgModelProvider(
      "anthropic-api-key",
      "test-api-key",
      "claude-sonnet-4-6",
    );
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"), {
      skipDefaultApiKey: true,
    });
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await setTestRunSelectedModel(runId, "claude-sonnet-4-6");
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
    expect(blocksStr).toContain("Claude Sonnet 4.6");
  });

  it("includes model in footer when selectedModel differs from org default", async () => {
    await createTestOrgModelProvider(
      "anthropic-api-key",
      "test-api-key",
      "claude-sonnet-4-6",
    );
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"), {
      skipDefaultApiKey: true,
    });
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await setTestRunSelectedModel(runId, "claude-opus-4-7");
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
    expect(blocksStr).toContain("Claude Opus 4.7");
  });

  it("shows `Reply to <@U>` when the thread has more than two distinct mentioners", async () => {
    const { workspaceId, connectionId, slackUserId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await completeTestRun(user.userId, runId);

    const channelId = uniqueId("C-ch");
    const threadTs = uniqueId("ts");
    // Two other Slack users already mentioned the agent in this thread.
    // Combined with the current user, that brings distinct mentioners to 3.
    await seedAdditionalMentioners(workspaceId, channelId, threadTs, 2);

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
    expect(blocksStr).toContain(`Reply to <@${slackUserId}>`);
  });

  it("omits `Reply to` when the thread has only one distinct mentioner", async () => {
    const { workspaceId, connectionId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"));
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await completeTestRun(user.userId, runId);

    const channelId = uniqueId("C-ch");
    const threadTs = uniqueId("ts");
    // Only the current user mentioned the agent = 1 distinct, below threshold.

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
    expect(blocksStr).not.toContain("Reply to");
  });

  it("renders combined footer with `Reply to` and model joined by `·`", async () => {
    await createTestOrgModelProvider(
      "anthropic-api-key",
      "test-api-key",
      "claude-sonnet-4-6",
    );
    const { workspaceId, connectionId, slackUserId } = await setupOrgSlack();
    const { composeId } = await createTestCompose(uniqueId("agent"), {
      skipDefaultApiKey: true,
    });
    const { runId } = await seedTestRun(user.userId, composeId, {
      prompt: "Test prompt",
    });
    await setTestRunSelectedModel(runId, "claude-opus-4-7");
    await completeTestRun(user.userId, runId);

    const channelId = uniqueId("C-ch");
    const threadTs = uniqueId("ts");
    await seedAdditionalMentioners(workspaceId, channelId, threadTs, 2);

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
    expect(blocksStr).toContain(`Reply to <@${slackUserId}> · Claude Opus 4.7`);
  });
});
