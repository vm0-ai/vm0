import { describe, it, expect, beforeEach } from "vitest";
import {
  testContext,
  uniqueId,
  type UserContext,
} from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  findTestRunRecord,
} from "../../../../__tests__/api-test-helpers";
import { transitionRunStatus } from "../run-status";
import { seedTestRun } from "../../../../__tests__/db-test-seeders/runs";

const context = testContext();

// These tests verify the internal state-machine and database-level optimistic
// locking guarantees of transitionRunStatus(). They are intentionally kept as
// service-level tests because:
// - Webhook routes add idempotency checks that bypass transitionRunStatus for
//   terminal statuses, preventing route-level testing of rejection logic
// - Webhook routes use fixed allowed-status lists (["pending", "running"]),
//   so arbitrary status validation can't be tested via routes
// - Concurrent transition testing requires direct parallel service calls
//
// Route-level tests for webhook completion behavior live in:
//   app/api/webhooks/agent/complete/__tests__/route.test.ts
describe("transitionRunStatus", () => {
  let user: UserContext;
  let composeId: string;

  beforeEach(async () => {
    context.setupMocks();
    user = await context.setupUser();
    const compose = await createTestCompose(uniqueId("agent"));
    composeId = compose.composeId;
  });

  it("should transition from valid status", async () => {
    const { runId } = await seedTestRun(user.userId, composeId, {
      status: "pending",
    });

    const result = await transitionRunStatus(
      runId,
      { status: "completed", completedAt: new Date() },
      ["pending", "running"],
    );

    expect(result).toBe(true);
    const run = await findTestRunRecord(runId);
    expect(run!.status).toBe("completed");
  });

  it("should reject transition from terminal status", async () => {
    const { runId } = await seedTestRun(user.userId, composeId, {
      status: "completed",
    });

    const result = await transitionRunStatus(
      runId,
      { status: "failed", error: "test", completedAt: new Date() },
      ["pending", "running"],
    );

    expect(result).toBe(false);
    const run = await findTestRunRecord(runId);
    expect(run!.status).toBe("completed");
  });

  it("should reject transition when status not in allowed list", async () => {
    const { runId } = await seedTestRun(user.userId, composeId, {
      status: "running",
    });

    const result = await transitionRunStatus(
      runId,
      { status: "failed", error: "test", completedAt: new Date() },
      ["queued"], // running not in allowed list
    );

    expect(result).toBe(false);
    const run = await findTestRunRecord(runId);
    expect(run!.status).toBe("running");
  });

  it("should ensure only one concurrent transition wins", async () => {
    const { runId } = await seedTestRun(user.userId, composeId, {
      status: "running",
    });

    const [result1, result2] = await Promise.all([
      transitionRunStatus(
        runId,
        { status: "completed", completedAt: new Date() },
        ["pending", "running"],
      ),
      transitionRunStatus(
        runId,
        { status: "failed", error: "test", completedAt: new Date() },
        ["pending", "running"],
      ),
    ]);

    // Exactly one should succeed
    expect([result1, result2].filter(Boolean)).toHaveLength(1);

    const run = await findTestRunRecord(runId);
    expect(["completed", "failed"]).toContain(run!.status);
  });
});
