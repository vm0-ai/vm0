import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRunInDb,
  createTestCallback,
  createTestRequest,
  createTestSchedule,
  createTestZeroAgent,
  enableTestSchedule,
  disableTestSchedule,
  deleteTestSchedule,
  updateTestScheduleState,
  findTestScheduleById,
} from "../../../../../../../src/__tests__/api-test-helpers";
import { computeHmacSignature } from "../../../../../../../src/lib/infra/callback/hmac";

const context = testContext();

interface CronCallbackPayload {
  scheduleId: string;
  cronExpression: string;
  timezone: string;
}

function createCallbackRequest(
  body: {
    callbackId?: string;
    runId: string;
    status: "completed" | "failed";
    error?: string;
    payload: CronCallbackPayload;
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
    "http://localhost/api/internal/callbacks/schedule/cron",
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

describe("POST /api/internal/callbacks/schedule/cron", () => {
  let composeId: string;
  let userId: string;

  beforeEach(async () => {
    context.setupMocks();
    const user = await context.setupUser();
    userId = user.userId;
    const agentName = uniqueId("agent");
    composeId = (await createTestCompose(agentName)).composeId;
    await createTestZeroAgent(user.orgId, agentName, {});
  });

  async function setupCronSchedule() {
    const schedule = await createTestSchedule(composeId, uniqueId("cron"), {
      cronExpression: "0 9 * * *",
      timezone: "UTC",
    });
    await enableTestSchedule(composeId, schedule.name);
    const { runId } = await createTestRunInDb(userId, composeId, {
      prompt: "Cron task",
    });
    const { callbackId, secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/schedule/cron",
      payload: {
        scheduleId: schedule.id,
        cronExpression: "0 9 * * *",
        timezone: "UTC",
      },
    });
    return { schedule, runId, callbackId, secret };
  }

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const { schedule, runId, secret } = await setupCronSchedule();

      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            scheduleId: schedule.id,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it("should reject request with unknown runId", async () => {
      const request = createCallbackRequest(
        {
          runId: "00000000-0000-0000-0000-000000000000",
          status: "completed",
          payload: {
            scheduleId: "00000000-0000-0000-0000-000000000000",
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
        "fake-secret",
      );
      const response = await POST(request);

      expect(response.status).toBe(404);
    });
  });

  describe("Success Callback", () => {
    it("should reset failure counter and schedule next run", async () => {
      const { schedule, runId, secret } = await setupCronSchedule();

      // Simulate prior consecutive failures
      await updateTestScheduleState(schedule.id, { consecutiveFailures: 2 });

      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            scheduleId: schedule.id,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      // Verify DB state
      const updated = await findTestScheduleById(schedule.id);
      expect(updated!.consecutiveFailures).toBe(0);
      expect(updated!.nextRunAt).not.toBeNull();
      expect(updated!.enabled).toBe(true);
    });
  });

  describe("Failure Callback", () => {
    it("should increment failure counter on first failure", async () => {
      const { schedule, runId, secret } = await setupCronSchedule();

      const request = createCallbackRequest(
        {
          runId,
          status: "failed",
          error: "Agent crashed",
          payload: {
            scheduleId: schedule.id,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      const updated = await findTestScheduleById(schedule.id);
      expect(updated!.consecutiveFailures).toBe(1);
      expect(updated!.enabled).toBe(true);
      // Should still schedule next run
      expect(updated!.nextRunAt).not.toBeNull();
    });

    it("should auto-disable after 3 consecutive failures", async () => {
      const { schedule, runId, secret } = await setupCronSchedule();

      // Set to 2 consecutive failures already
      await updateTestScheduleState(schedule.id, { consecutiveFailures: 2 });

      const request = createCallbackRequest(
        {
          runId,
          status: "failed",
          error: "Third failure",
          payload: {
            scheduleId: schedule.id,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      const updated = await findTestScheduleById(schedule.id);
      expect(updated!.consecutiveFailures).toBe(3);
      expect(updated!.enabled).toBe(false);
      expect(updated!.nextRunAt).toBeNull();
    });
  });

  describe("Edge Cases", () => {
    it("should skip callback for deleted schedule", async () => {
      const { schedule, runId, secret } = await setupCronSchedule();

      // Delete the schedule via API helper
      await deleteTestSchedule(composeId, schedule.name);

      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            scheduleId: schedule.id,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skipped).toBe(true);
    });

    it("should skip callback for disabled schedule", async () => {
      const { schedule, runId, secret } = await setupCronSchedule();

      // Disable the schedule via API helper
      await disableTestSchedule(composeId, schedule.name);

      const request = createCallbackRequest(
        {
          runId,
          status: "completed",
          payload: {
            scheduleId: schedule.id,
            cronExpression: "0 9 * * *",
            timezone: "UTC",
          },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skipped).toBe(true);
    });
  });
});
