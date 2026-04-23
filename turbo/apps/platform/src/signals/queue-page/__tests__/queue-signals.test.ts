import { describe, it, expect } from "vitest";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { cancelQueueRun$ } from "../queue-signals.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { zeroRunsQueueContract, zeroRunsCancelContract } from "@vm0/core";

const context = testContext();
const mockApi = createMockApi(context);

function mockQueueResponse() {
  return {
    concurrency: { tier: "free" as const, limit: 1, active: 1, available: 0 },
    queue: [],
    runningTasks: [
      {
        runId: "run-1",
        agentName: "agent-a",
        agentDisplayName: "Agent A",
        userEmail: "user@test.com",
        startedAt: new Date().toISOString(),
        isOwner: true,
      },
    ],
    estimatedTimePerRun: 30_000,
  };
}

describe("cancelQueueRun$", () => {
  it("should POST to cancel endpoint with correct run ID", async () => {
    let cancelCalledWith: string | null = null;

    server.use(
      mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
        return respond(200, mockQueueResponse());
      }),
      mockApi(zeroRunsCancelContract.cancel, ({ params, respond }) => {
        cancelCalledWith = params.id;
        return respond(200, {
          id: params.id,
          status: "cancelled",
          message: "Run cancelled",
        });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await context.store.set(cancelQueueRun$, "run-1", context.signal);

    expect(cancelCalledWith).toBe("run-1");
  });

  it("should throw on non-ok cancel response", async () => {
    server.use(
      mockApi(zeroRunsQueueContract.getQueue, ({ respond }) => {
        return respond(200, mockQueueResponse());
      }),
      mockApi(zeroRunsCancelContract.cancel, ({ respond }) => {
        return respond(403, {
          error: { message: "Forbidden", code: "FORBIDDEN" },
        });
      }),
    );

    detachedSetupPage({ context, path: "/", withoutRender: true });

    await expect(
      context.store.set(cancelQueueRun$, "run-1", context.signal),
    ).rejects.toThrow("Forbidden");
  });
});
