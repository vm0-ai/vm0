import { describe, it, expect, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
import type { Block, KnownBlock } from "@slack/web-api";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../../../src/__tests__/clerk-mock";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
  createTestSlackOrgInstallation,
  createTestSlackOrgConnection,
  createTestRequest,
  completeTestRun,
  linkRunToSchedule,
  createTestSchedule,
} from "../../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../../src/lib/callback/hmac";

const context = testContext();

interface OrgScheduleCallbackPayload {
  scheduleId: string;
  agentId: string;
  agentName: string;
  userId: string;
  orgId: string;
  slackChannelId?: string | null;
}

function createCallbackRequest(
  body: {
    runId: string;
    status: "completed" | "failed" | "progress";
    error?: string;
    payload: OrgScheduleCallbackPayload;
  },
  secret: string,
): NextRequest {
  const bodyString = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest(
    "http://localhost/api/internal/callbacks/slack/org/schedule",
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

async function setupSlackOrg(user: UserContext) {
  const { slackWorkspaceId } = await createTestSlackOrgInstallation({
    orgId: user.orgId,
  });

  const { slackUserId } = await createTestSlackOrgConnection({
    slackWorkspaceId,
    vm0UserId: user.userId,
  });

  return { slackWorkspaceId, slackUserId };
}

describe("POST /api/internal/callbacks/slack/org/schedule", () => {
  let user: UserContext;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
  });

  it("rejects request with invalid payload (missing orgId)", async () => {
    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
      payload: {
        scheduleId: schedule.id,
        agentId: composeId,
        agentName: "sched-agent",
        userId: user.userId,
        // orgId intentionally missing
      },
    });

    const request = createCallbackRequest(
      {
        runId,
        status: "completed",
        payload: {
          scheduleId: schedule.id,
          agentId: composeId,
          agentName: "sched-agent",
          userId: user.userId,
          orgId: undefined as unknown as string, // missing orgId
        },
      },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
  });

  it("sends notification to channel when slackChannelId is set", async () => {
    await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);
    await completeTestRun(user.userId, runId);

    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: user.orgId,
      slackChannelId: "C-TARGET-CHANNEL",
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
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

    // Verify postMessage was called with the target channel, not the user DM
    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).toHaveBeenCalled();

    const firstCall = postMessageMock.mock.calls[0]![0] as {
      channel: string;
      blocks: (Block | KnownBlock)[];
    };
    expect(firstCall.channel).toBe("C-TARGET-CHANNEL");

    // Verify blocks use markdown block type (from buildAgentResponseMessage)
    const markdownBlock = firstCall.blocks.find((b) => b.type === "markdown");
    expect(markdownBlock).toBeDefined();

    // Verify no header — content should be the raw output without a title prefix
    const markdownText = (markdownBlock as { type: "markdown"; text: string })
      .text;
    expect(markdownText).not.toContain("Scheduled run for");

    // Verify audit link is present as a context block
    const contextBlock = firstCall.blocks.find((b) => b.type === "context");
    expect(contextBlock).toBeDefined();
    expect(contextBlock).toMatchObject({
      type: "context",
      elements: [{ type: "mrkdwn", text: expect.stringContaining("Audit") }],
    });
  });

  it("falls back to user DM when slackChannelId is not set", async () => {
    const { slackUserId } = await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);
    await completeTestRun(user.userId, runId);

    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: user.orgId,
      // slackChannelId not set — should fall back to DM
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
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

    // Verify postMessage was called with the user's Slack ID (DM)
    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).toHaveBeenCalled();

    const firstCall = postMessageMock.mock.calls[0]![0] as {
      channel: string;
    };
    expect(firstCall.channel).toBe(slackUserId);
  });

  it("sends failure notification to configured channel", async () => {
    await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);

    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: user.orgId,
      slackChannelId: "C-FAIL-CHANNEL",
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "failed", error: "Agent crashed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);

    // Verify error message was sent to configured channel
    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).toHaveBeenCalledOnce();

    const call = postMessageMock.mock.calls[0]![0] as {
      channel: string;
      text: string;
      blocks: (Block | KnownBlock)[];
    };
    expect(call.channel).toBe("C-FAIL-CHANNEL");
    expect(call.text).toContain("failed");

    // Verify failure message uses markdown block with error content
    const markdownBlock = call.blocks.find((b) => b.type === "markdown");
    expect(markdownBlock).toBeDefined();
    const markdownText = (markdownBlock as { type: "markdown"; text: string })
      .text;
    expect(markdownText).toContain("Failed");
    expect(markdownText).toContain("Agent crashed");

    // Verify audit link is present
    const contextBlock = call.blocks.find((b) => b.type === "context");
    expect(contextBlock).toBeDefined();
    expect(contextBlock).toMatchObject({
      type: "context",
      elements: [{ type: "mrkdwn", text: expect.stringContaining("Audit") }],
    });
  });

  it("includes schedule attribution footer in completed notification", async () => {
    await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"), {
      description: "Daily standup summary",
    });
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);
    await completeTestRun(user.userId, runId);

    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: user.orgId,
      slackChannelId: "C-ATTR-CHANNEL",
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);

    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).toHaveBeenCalled();

    const firstCall = postMessageMock.mock.calls[0]![0] as {
      blocks: (Block | KnownBlock)[];
    };

    // Should have a divider followed by an attribution context block
    const dividerBlocks = firstCall.blocks.filter((b) => b.type === "divider");
    expect(dividerBlocks).toHaveLength(1);

    const contextBlocks = firstCall.blocks.filter((b) => b.type === "context");
    // audit context + attribution context
    expect(contextBlocks).toHaveLength(2);

    const attrText = (contextBlocks[1] as { elements: { text: string }[] })
      .elements[0]!.text;
    expect(attrText).toContain("Triggered by schedule");
    expect(attrText).toContain("Daily standup summary");
  });

  it("includes schedule attribution footer in failure notification", async () => {
    await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"), {
      description: "Nightly report",
    });
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);

    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: user.orgId,
      slackChannelId: "C-ATTR-FAIL",
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "failed", error: "Timeout", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);

    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).toHaveBeenCalledOnce();

    const call = postMessageMock.mock.calls[0]![0] as {
      blocks: (Block | KnownBlock)[];
    };

    const contextBlocks = call.blocks.filter((b) => b.type === "context");
    expect(contextBlocks).toHaveLength(2);

    const attrText = (contextBlocks[1] as { elements: { text: string }[] })
      .elements[0]!.text;
    expect(attrText).toContain("Triggered by schedule");
    expect(attrText).toContain("Nightly report");
  });

  it("skips notification for progress heartbeat", async () => {
    await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);

    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: user.orgId,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "progress", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skipped).toBe(true);

    // Verify no Slack messages were sent
    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("does not send notification to wrong org's Slack when user has connections in multiple orgs", async () => {
    // Setup: user has Slack connected in org A (their default org)
    await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);
    await completeTestRun(user.userId, runId);

    // Schedule callback comes from org B (a different org where user has NO Slack)
    const otherOrgId = "org_other_no_slack";
    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: otherOrgId, // different org — no Slack installation here
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
      payload: { ...payload },
    });

    const request = createCallbackRequest(
      { runId, status: "completed", payload },
      secret,
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    // Should skip — no Slack connection for otherOrgId
    expect(data.skipped).toBe(true);

    // Verify postMessage was NOT called (should not leak to org A's Slack)
    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("sends notification to correct org when user has Slack in multiple orgs", async () => {
    // Setup: user has Slack in org A (default) and org B
    const { slackUserId: slackUserIdOrgA } = await setupSlackOrg(user);
    mockClerk({ userId: user.userId });

    const orgB = `org_mock_${uniqueId("org-b")}`;
    const { slackWorkspaceId: wsB } = await createTestSlackOrgInstallation({
      orgId: orgB,
    });
    const { slackUserId: slackUserIdOrgB } = await createTestSlackOrgConnection(
      {
        slackWorkspaceId: wsB,
        vm0UserId: user.userId,
      },
    );

    const { composeId } = await createTestCompose(uniqueId("sched-agent"));
    const schedule = await createTestSchedule(composeId, uniqueId("sched"));
    const { runId } = await createTestRun(composeId, "Test prompt");
    await linkRunToSchedule(runId, schedule.id);
    await completeTestRun(user.userId, runId);

    // Schedule callback targets org B
    const payload: OrgScheduleCallbackPayload = {
      scheduleId: schedule.id,
      agentId: composeId,
      agentName: "sched-agent",
      userId: user.userId,
      orgId: orgB,
    };

    const { secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/slack/org/schedule",
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

    // Verify postMessage was called with org B's Slack user ID, not org A's
    const mockClient = new WebClient();
    const postMessageMock = mockClient.chat.postMessage as ReturnType<
      typeof import("vitest").vi.fn
    >;
    expect(postMessageMock).toHaveBeenCalled();

    const firstCall = postMessageMock.mock.calls[0]![0] as {
      channel: string;
    };
    // Should use org B's slack user for DM, not org A's
    expect(firstCall.channel).toBe(slackUserIdOrgB);
    expect(firstCall.channel).not.toBe(slackUserIdOrgA);
  });
});
