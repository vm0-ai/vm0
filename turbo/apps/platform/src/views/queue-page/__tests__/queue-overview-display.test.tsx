/**
 * Display tests for QueuePage and QueueOverview components.
 *
 * Tests cover page title, concurrency values, available slots,
 * tier label, queue length, status message pluralization, and
 * estimated time metrics.
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

describe("queue-page - page title (QUEUE-D-001)", () => {
  it("displays the Run Queue heading", async () => {
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
    });
  });
});

describe("queue-page - concurrency and queue display (QUEUE-D-003 through QUEUE-D-009)", () => {
  it("displays concurrency values, tier label, and queue length together", async () => {
    server.use(
      http.get("*/api/zero/runs/queue", () => {
        return HttpResponse.json(
          queueResponse({
            concurrency: { tier: "pro", limit: 5, active: 3, available: 2 },
            queue: makeQueueEntries(4),
            estimatedTimePerRun: 30_000,
          }),
        );
      }),
    );
    await setupPage({ context, path: "/queues" });
    await waitFor(() => {
      // active / limit (QUEUE-D-003)
      expect(screen.getByText("3 / 5")).toBeInTheDocument();
      // available slots (QUEUE-D-004)
      expect(screen.getByText(/2 slots available/)).toBeInTheDocument();
      // tier label (QUEUE-D-005)
      expect(screen.getByText(/\(pro\)/)).toBeInTheDocument();
      // queue length (QUEUE-D-006)
      expect(screen.getByText("4 tasks waiting")).toBeInTheDocument();
      // estimated total clear time: 30_000ms * 4 = 120_000ms → "2m" (QUEUE-D-008)
      expect(screen.getByText("2m")).toBeInTheDocument();
      // estimated time per run (QUEUE-D-009)
      expect(screen.getByText("~30s per run")).toBeInTheDocument();
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
