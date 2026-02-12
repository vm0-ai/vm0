import { describe, it, expect, beforeEach, vi } from "vitest";
import { Resend } from "resend";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRun,
  createTestCallback,
  createTestRequest,
  createTestSchedule,
  linkRunToSchedule,
  completeTestRun,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../src/lib/callback/hmac";
import { mockClerk } from "../../../../../../../src/__tests__/clerk-mock";

const context = testContext();
const mockResend = vi.mocked(new Resend(""), true);

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
  options?: { invalidSignature?: boolean; expiredTimestamp?: boolean },
): NextRequest {
  const bodyString = JSON.stringify(body);
  const timestamp = options?.expiredTimestamp
    ? Math.floor(Date.now() / 1000) - 600
    : Math.floor(Date.now() / 1000);

  const signature = options?.invalidSignature
    ? "invalid-signature"
    : computeHmacSignature(bodyString, secret, timestamp);

  return createTestRequest(
    "http://localhost/api/internal/callbacks/email/schedule",
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

describe("POST /api/internal/callbacks/email/schedule", () => {
  beforeEach(() => {
    context.setupMocks();
    mockResend.emails.send.mockClear();
  });

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const user = await context.setupUser({ prefix: "email-sched-sig" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("sched-agent"));
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      await linkRunToSchedule(runId, schedule.id);

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId,
        composeName: "sched-agent",
        userId: user.userId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/schedule",
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

    it("should reject request with expired timestamp", async () => {
      const user = await context.setupUser({ prefix: "email-sched-exp" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("sched-agent"));
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      await linkRunToSchedule(runId, schedule.id);

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId,
        composeName: "sched-agent",
        userId: user.userId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/schedule",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "completed", payload },
        secret,
        { expiredTimestamp: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe("Email Sending", () => {
    it("should send completion email for successful scheduled run", async () => {
      const user = await context.setupUser({ prefix: "email-sched-ok" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("sched-agent"));
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      await linkRunToSchedule(runId, schedule.id);
      await completeTestRun(user.userId, runId);

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId,
        composeName: "test-agent",
        userId: user.userId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/schedule",
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

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        from: string;
        to: string;
        subject: string;
      };
      expect(sendArgs.to).toBe("test@example.com");
      expect(sendArgs.subject).toContain("completed");
      expect(sendArgs.from).toContain("test-agent");
    });

    it("should send failure email for failed scheduled run", async () => {
      const user = await context.setupUser({ prefix: "email-sched-fail" });
      mockClerk({ userId: user.userId });
      const { composeId } = await createTestCompose(uniqueId("fail-agent"));
      const schedule = await createTestSchedule(composeId, uniqueId("sched"));
      const { runId } = await createTestRun(composeId, "Test prompt");
      await linkRunToSchedule(runId, schedule.id);

      const payload: ScheduleCallbackPayload = {
        scheduleId: schedule.id,
        composeId,
        composeName: "fail-agent",
        userId: user.userId,
      };

      const { secret } = await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/email/schedule",
        payload: { ...payload },
      });

      const request = createCallbackRequest(
        { runId, status: "failed", error: "Agent crashed", payload },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      expect(mockResend.emails.send).toHaveBeenCalledTimes(1);
      const sendArgs = mockResend.emails.send.mock.calls[0]![0] as {
        to: string;
        subject: string;
      };
      expect(sendArgs.to).toBe("test@example.com");
      expect(sendArgs.subject).toContain("failed");
    });
  });
});
