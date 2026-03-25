import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { cancelQueueRun$, queueData$ } from "../queue-signals.ts";

const context = testContext();

function mockQueueResponse() {
  return {
    concurrency: { tier: "free", limit: 1, active: 1, available: 0 },
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
  it("should POST to cancel endpoint and refresh queue data", async () => {
    let cancelCalledWith: string | null = null;
    let queueFetchCount = 0;

    server.use(
      http.get("*/api/zero/runs/queue", () => {
        queueFetchCount++;
        return HttpResponse.json(mockQueueResponse());
      }),
      http.post("*/api/zero/runs/:runId/cancel", ({ params }) => {
        cancelCalledWith = params.runId as string;
        return HttpResponse.json({ ok: true });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    // Cancel a run — this also triggers fetchQueueData$ internally
    await context.store.set(cancelQueueRun$, "run-1", context.signal);

    // Verify cancel was called with correct run ID
    expect(cancelCalledWith).toBe("run-1");

    // Verify queue was refreshed after cancel (fetchQueueData$ called)
    expect(queueFetchCount).toBeGreaterThanOrEqual(1);

    // Verify queueData$ is now populated from the refresh
    const data = context.store.get(queueData$);
    expect(data).toBeTruthy();
  });

  it("should throw on non-ok cancel response", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(mockQueueResponse());
      }),
      http.post("*/api/zero/runs/:runId/cancel", () => {
        return new HttpResponse(null, {
          status: 403,
          statusText: "Forbidden",
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await expect(
      context.store.set(cancelQueueRun$, "run-1", context.signal),
    ).rejects.toThrow("Failed to cancel run");
  });
});
