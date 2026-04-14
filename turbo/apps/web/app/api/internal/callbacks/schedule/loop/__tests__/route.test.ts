import { describe, it, expect, beforeEach } from "vitest";
import { POST } from "../route";
import {
  testContext,
  uniqueId,
} from "../../../../../../../src/__tests__/test-helpers";
import {
  createTestCompose,
  createTestRunInDb,
  createTestCallback,
  createTestSchedule,
  createTestZeroAgent,
  enableTestSchedule,
  disableTestSchedule,
  deleteTestSchedule,
  updateTestScheduleState,
  findTestScheduleById,
  createSignedCallbackRequest,
} from "../../../../../../../src/__tests__/api-test-helpers";

const context = testContext();

describe("POST /api/internal/callbacks/schedule/loop", () => {
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

  async function setupLoopSchedule() {
    const schedule = await createTestSchedule(composeId, uniqueId("loop"), {
      intervalSeconds: 300,
    });
    await enableTestSchedule(composeId, schedule.name);
    const { runId } = await createTestRunInDb(userId, composeId, {
      prompt: "Loop task",
    });
    const { callbackId, secret } = await createTestCallback({
      runId,
      url: "http://localhost/api/internal/callbacks/schedule/loop",
      payload: {
        scheduleId: schedule.id,
      },
    });
    return { schedule, runId, callbackId, secret };
  }

  describe("Signature Verification", () => {
    it("should reject request with invalid signature", async () => {
      const { schedule, runId, secret } = await setupLoopSchedule();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "completed",
          payload: { scheduleId: schedule.id },
        },
        secret,
        { invalidSignature: true },
      );
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it("should reject request with unknown runId", async () => {
      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId: "00000000-0000-0000-0000-000000000000",
          status: "completed",
          payload: {
            scheduleId: "00000000-0000-0000-0000-000000000000",
          },
        },
        "fake-secret",
      );
      const response = await POST(request);

      expect(response.status).toBe(404);
    });

    it("should verify using callbackId for PK-based secret lookup", async () => {
      const { schedule, runId, callbackId, secret } = await setupLoopSchedule();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          callbackId,
          runId,
          status: "completed",
          payload: { scheduleId: schedule.id },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });

    it("should verify correct callback when multiple callbacks exist for same run", async () => {
      const { schedule, runId, callbackId, secret } = await setupLoopSchedule();

      // Create additional callbacks for the same run (simulates email + slack)
      await createTestCallback({
        runId,
        url: "http://localhost/api/internal/callbacks/slack",
        payload: { workspaceId: "W1" },
      });
      await createTestCallback({
        runId,
        url: "http://localhost/api/zero/email/callbacks/reply",
        payload: { emailId: "E1" },
      });

      // With callbackId, the loop callback should still verify with its own secret
      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          callbackId,
          runId,
          status: "completed",
          payload: { scheduleId: schedule.id },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);

      const updated = await findTestScheduleById(schedule.id);
      expect(updated!.nextRunAt).not.toBeNull();
    });
  });

  describe("Success Callback", () => {
    it("should reset failure counter and schedule next run", async () => {
      const { schedule, runId, secret } = await setupLoopSchedule();

      // Simulate prior consecutive failures
      await updateTestScheduleState(schedule.id, { consecutiveFailures: 2 });

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "completed",
          payload: { scheduleId: schedule.id },
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
      const { schedule, runId, secret } = await setupLoopSchedule();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "failed",
          error: "Agent crashed",
          payload: { scheduleId: schedule.id },
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
      const { schedule, runId, secret } = await setupLoopSchedule();

      // Set to 2 consecutive failures already
      await updateTestScheduleState(schedule.id, { consecutiveFailures: 2 });

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "failed",
          error: "Third failure",
          payload: { scheduleId: schedule.id },
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

  describe("Progress Callback", () => {
    it("should ignore progress notifications without affecting failure count", async () => {
      const { schedule, runId, secret } = await setupLoopSchedule();

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "progress",
          payload: { scheduleId: schedule.id },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skipped).toBe(true);

      const updated = await findTestScheduleById(schedule.id);
      expect(updated!.consecutiveFailures).toBe(0);
      expect(updated!.enabled).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should skip callback for deleted schedule", async () => {
      const { schedule, runId, secret } = await setupLoopSchedule();

      // Delete the schedule via API helper
      await deleteTestSchedule(composeId, schedule.name);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "completed",
          payload: { scheduleId: schedule.id },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skipped).toBe(true);
    });

    it("should skip callback for disabled schedule", async () => {
      const { schedule, runId, secret } = await setupLoopSchedule();

      // Disable the schedule via API helper
      await disableTestSchedule(composeId, schedule.name);

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "completed",
          payload: { scheduleId: schedule.id },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.skipped).toBe(true);
    });

    it("should use current DB interval, not stale value from run creation time", async () => {
      const { schedule, runId, secret } = await setupLoopSchedule();

      // User changes interval from 300 to 600 while run is in progress
      await updateTestScheduleState(schedule.id, { intervalSeconds: 600 });

      const request = createSignedCallbackRequest(
        "http://localhost/api/internal/callbacks/schedule/loop",
        {
          runId,
          status: "completed",
          payload: { scheduleId: schedule.id },
        },
        secret,
      );
      const response = await POST(request);

      expect(response.status).toBe(200);

      const updated = await findTestScheduleById(schedule.id);
      // nextRunAt should be ~600s from now, not the original 300s
      const expectedMin = new Date(Date.now() + 599 * 1000);
      const expectedMax = new Date(Date.now() + 601 * 1000);
      expect(updated!.nextRunAt!.getTime()).toBeGreaterThanOrEqual(
        expectedMin.getTime(),
      );
      expect(updated!.nextRunAt!.getTime()).toBeLessThanOrEqual(
        expectedMax.getTime(),
      );
    });
  });
});
