import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  givenLinkedSlackUser,
  givenUserHasAgent,
} from "../../../../../../../src/__tests__/slack/api-helpers";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
  createTestRequest,
  createTestSchedule,
  linkRunToSchedule,
  completeTestRun,
  findTestThreadSession,
  createTestAgentSession,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../src/lib/callback/hmac";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();
const mockClient = vi.mocked(new WebClient(), true);

const MOCK_DM_CHANNEL_ID = "D-mock-dm-sched";

interface ScheduleCallbackPayload {
  scheduleId: string;
  composeId: string;
  composeName: string;
  userId: string;
}

function createCallbackRequest(
  body: {
    runId: string;
    status: "completed" | "failed";
    error?: string;
    payload: ScheduleCallbackPayload;
  },
  secret: string,
  options?: { invalidSignature?: boolean },
): NextRequest {
  const bodyString = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);

  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest(
    "http://localhost/api/internal/callbacks/slack/schedule",
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

describe("POST /api/internal/callbacks/slack/schedule", () => {
  beforeEach(() => {
    context.setupMocks();
    mockClient.chat.postMessage.mockClear();
    mockClient.reactions.remove.mockClear();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const { userLink } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "test-agent",
      });

      mockClerk({ userId: userLink.vm0UserId });
      const schedule = await createTestSchedule(
        binding.composeId,
        uniqueId("sched"),
      );
      const { runId } = await createTestRun(binding.composeId, "Test prompt");
      await linkRunToSchedule(runId, schedule.id);

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId: binding.composeId,
        composeName: "test-agent",
        userId: userLink.vm0UserId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack/schedule",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe("Slack DM Sending", () => {
    it("should send DM on successful scheduled run", async () => {
      const { userLink } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "scheduled-agent",
      });

      mockClerk({ userId: userLink.vm0UserId });
      const schedule = await createTestSchedule(
        binding.composeId,
        uniqueId("sched"),
      );
      const { runId } = await createTestRun(
        binding.composeId,
        "Scheduled task",
      );
      await linkRunToSchedule(runId, schedule.id);
      await completeTestRun(userLink.vm0UserId, runId);

      // Create agent session for thread session FK
      await createTestAgentSession(userLink.vm0UserId, binding.composeId);

      mockClient.chat.postMessage.mockImplementation((args) => {
        const channel = String(args.channel ?? "");
        return Promise.resolve({
          ok: true,
          ts: `${Date.now()}.000000`,
          channel: channel.startsWith("U") ? MOCK_DM_CHANNEL_ID : channel,
        }) as never;
      });

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId: binding.composeId,
        composeName: "scheduled-agent",
        userId: userLink.vm0UserId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack/schedule",
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

      // Verify Slack DM was sent
      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.chat.postMessage.mock.calls[0]![0] as {
        channel: string;
        blocks: Array<{ type: string; text?: { text: string } }>;
      };
      expect(callArgs.channel).toBe(userLink.slackUserId);

      const sectionTexts = callArgs.blocks
        .filter((b) => b.type === "section")
        .map((b) => b.text?.text ?? "");
      expect(sectionTexts.some((t) => t.includes("completed"))).toBe(true);
      expect(sectionTexts.some((t) => t.includes("scheduled-agent"))).toBe(
        true,
      );

      // Thread session should be saved with the DM channel ID
      const threadSession = await findTestThreadSession(MOCK_DM_CHANNEL_ID);
      expect(threadSession).not.toBeNull();
    });

    it("should send error DM on failed scheduled run", async () => {
      const { userLink } = await givenLinkedSlackUser();
      const { binding } = await givenUserHasAgent(userLink, {
        agentName: "my-agent",
      });

      mockClerk({ userId: userLink.vm0UserId });
      const schedule = await createTestSchedule(
        binding.composeId,
        uniqueId("sched"),
      );
      const { runId } = await createTestRun(
        binding.composeId,
        "Scheduled task",
      );
      await linkRunToSchedule(runId, schedule.id);

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId: binding.composeId,
        composeName: "my-agent",
        userId: userLink.vm0UserId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack/schedule",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "failed", error: "Agent crashed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.chat.postMessage.mock.calls[0]![0] as {
        channel: string;
        text: string;
        blocks: Array<{ type: string; text?: { text: string } }>;
      };
      expect(callArgs.channel).toBe(userLink.slackUserId);

      const sectionTexts = callArgs.blocks
        .filter((b) => b.type === "section")
        .map((b) => b.text?.text ?? "");
      expect(sectionTexts.some((t) => t.includes("failed"))).toBe(true);
      expect(sectionTexts.some((t) => t.includes("Agent crashed"))).toBe(true);
    });

    it("should skip when user has no Slack link", async () => {
      const user = await context.setupUser({ prefix: "no-slack" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("agent"));
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      await linkRunToSchedule(runId, schedule.id);

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId,
        composeName: "agent",
        userId: user.userId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack/schedule",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "failed", error: "error", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skipped).toBe(true);

      // No Slack DM should be sent
      expect(mockClient.chat.postMessage).not.toHaveBeenCalled();
    });
  });
});
