import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { cancelQueueRun$ } from "../queue-signals.ts";

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
  it("should POST to cancel endpoint with correct run ID", async () => {
    let cancelCalledWith: string | null = null;

    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(mockQueueResponse());
      }),
      http.post("*/api/zero/runs/:runId/cancel", ({ params }) => {
        cancelCalledWith = params.runId as string;
        return HttpResponse.json({
          id: params.runId,
          status: "cancelled",
          message: "Run cancelled",
        });
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await context.store.set(cancelQueueRun$, "run-1", context.signal);

    expect(cancelCalledWith).toBe("run-1");
  });

  it("should throw on non-ok cancel response", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(mockQueueResponse());
      }),
      http.post("*/api/zero/runs/:runId/cancel", () => {
        return HttpResponse.json(
          { error: { message: "Forbidden", code: "FORBIDDEN" } },
          { status: 403 },
        );
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    await expect(
      context.store.set(cancelQueueRun$, "run-1", context.signal),
    ).rejects.toThrow("Forbidden");
  });
});
