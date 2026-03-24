import { describe, it, expect, beforeEach } from "vitest";
import { WebClient } from "@slack/web-api";
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
    };
    expect(firstCall.channel).toBe("C-TARGET-CHANNEL");
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
    };
    expect(call.channel).toBe("C-FAIL-CHANNEL");
    expect(call.text).toContain("failed");
  });
});
