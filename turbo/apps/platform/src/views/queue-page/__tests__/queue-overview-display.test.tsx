/**
 * Display tests for QueuePage and QueueOverview components.
 *
 * Tests cover page title, loading state, concurrency values,
 * available slots, tier label, queue length, status message
 * pluralization, and estimated time metrics.
 *
 * Follows platform testing principles:
 * - Entry point: setupPage({ context, path })
 * - Mock (external): HTTP via MSW
 * - Real (internal): All signals, components, rendering
 */

import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

function queueResponse(overrides?: {
  concurrency?: {
    tier: string;
    limit: number;
    active: number;
    available: number;
  };
  queue?: unknown[];
  runningTasks?: unknown[];
  estimatedTimePerRun?: number | null;
}) {
  return {
    concurrency: overrides?.concurrency ?? {
      tier: "free",
      limit: 2,
      active: 1,
      available: 1,
    },
    queue: overrides?.queue ?? [],
    runningTasks: overrides?.runningTasks ?? [],
    estimatedTimePerRun: overrides?.estimatedTimePerRun ?? null,
  };
}

function makeQueueEntries(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => {
    return {
      position: i + 1,
      runId: `run-${i + 1}`,
      agentName: `test-agent-${i + 1}`,
      agentDisplayName: `Test Agent ${i + 1}`,
      userEmail: "user@test.com",
      createdAt: new Date().toISOString(),
      isOwner: false,
      prompt: null,
      triggerSource: null,
      sessionLink: null,
    };
  });
}

describe("queue-page - page title and description (QUEUE-D-001)", () => {
  it("displays the Run Queue heading and description", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(queueResponse());
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run Queue" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Organization-wide queue status and running tasks."),
      ).toBeInTheDocument();
    });
  });
});

describe("queue-page - loading state (QUEUE-S-002)", () => {
  it("shows loading skeleton before data arrives", async () => {
    const deferred = createDeferredPromise<void>(context.signal);
    server.use(
      http.get("*/api/zero/runs/queue", async () => {
        await deferred.promise;
        return HttpResponse.json(queueResponse());
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run Queue" }),
      ).toBeInTheDocument();
    });
    // Data not yet arrived — concurrency label should not be visible
    expect(screen.queryByText("Concurrency")).not.toBeInTheDocument();
    deferred.resolve();
  });
});

describe("queue-page - active and limit concurrency (QUEUE-D-003)", () => {
  it("displays active / limit concurrency value", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "pro", limit: 5, active: 3, available: 2 },
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("3 / 5")).toBeInTheDocument();
    });
  });
});

describe("queue-page - available slots count (QUEUE-D-004)", () => {
  it("displays available slot count in concurrency detail", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "pro", limit: 5, active: 3, available: 2 },
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText(/2 slots available/)).toBeInTheDocument();
    });
  });
});

describe("queue-page - tier label (QUEUE-D-005)", () => {
  it("displays the concurrency tier label", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "pro", limit: 5, active: 3, available: 2 },
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText(/\(pro\)/)).toBeInTheDocument();
    });
  });
});

describe("queue-page - queue length count (QUEUE-D-006)", () => {
  it("displays the queue length value", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: makeQueueEntries(4),
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("4 tasks waiting")).toBeInTheDocument();
    });
  });
});

describe("queue-page - queue status message pluralization (QUEUE-C-007)", () => {
  it("shows singular 'task waiting' for queue length 1", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: makeQueueEntries(1),
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("1 task waiting")).toBeInTheDocument();
    });
  });

  it("shows plural 'tasks waiting' for queue length 3", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: makeQueueEntries(3),
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("3 tasks waiting")).toBeInTheDocument();
    });
  });
});

describe("queue-page - estimated total clear time (QUEUE-D-008)", () => {
  it("displays the formatted etaTotal duration", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: makeQueueEntries(4),
            estimatedTimePerRun: 30_000,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    // 30_000ms * 4 = 120_000ms → "2m"
    await waitFor(() => {
      expect(screen.getByText("2m")).toBeInTheDocument();
    });
  });
});

describe("queue-page - estimated time per run (QUEUE-D-009)", () => {
  it("displays the formatted estimatedTimePerRun", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            queue: makeQueueEntries(1),
            estimatedTimePerRun: 30_000,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      expect(screen.getByText("~30s per run")).toBeInTheDocument();
    });
  });
});
