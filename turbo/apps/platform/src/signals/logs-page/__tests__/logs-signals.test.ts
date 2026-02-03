import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import {
  currentPageLogs$,
  initLogs$,
  hasPrevPage$,
  goToNextPage$,
  goToPrevPage$,
  goForwardTwoPages$,
  goBackTwoPages$,
  setRowsPerPage$,
  setSearch$,
  rowsPerPageValue$,
  searchQueryValue$,
  currentPageNumber$,
  initAccumulatedEvents$,
  loadMoreAgentEvents$,
  agentEventsAccumulated$,
  agentEventsHasMore$,
  agentEventsIsLoadingMore$,
} from "../logs-signals.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { mockLocation, mockPushState } from "../../location.ts";

const context = testContext();

describe("logs-signals", () => {
  // Mock location for each test to ensure clean URL state
  beforeEach(() => {
    const { signal } = context;
    mockLocation({ pathname: "/logs", search: "" }, signal);
    mockPushState(() => {}, signal);
  });

  describe("initLogs$", () => {
    it("should load first page", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);

      const currentPage = store.get(currentPageLogs$);
      expect(currentPage).not.toBeNull();
    });

    it("should reset to page 1", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);

      expect(store.get(currentPageNumber$)).toBe(1);
      expect(store.get(hasPrevPage$)).toBeFalsy();
    });

    it("should respect abort signal", () => {
      const { store } = context;
      const controller = new AbortController();
      controller.abort();

      expect(() => store.set(initLogs$, controller.signal)).toThrow();
    });
  });

  describe("pagination navigation", () => {
    it("should navigate to next page when hasMore is true", async () => {
      const { store, signal } = context;

      // Mock API to return hasMore = true
      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor123" },
            });
          }

          return HttpResponse.json({
            data: [{ id: "log-2" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      expect(store.get(currentPageNumber$)).toBe(1);

      await store.set(goToNextPage$, signal);
      expect(store.get(currentPageNumber$)).toBe(2);
    });

    it("should navigate back to previous page", async () => {
      const { store, signal } = context;

      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor123" },
            });
          }

          return HttpResponse.json({
            data: [{ id: "log-2" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      await store.set(goToNextPage$, signal);
      expect(store.get(currentPageNumber$)).toBe(2);
      expect(store.get(hasPrevPage$)).toBeTruthy();

      store.set(goToPrevPage$, signal);
      expect(store.get(currentPageNumber$)).toBe(1);
      expect(store.get(hasPrevPage$)).toBeFalsy();
    });

    it("should not navigate to previous page when on first page", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);
      store.set(goToPrevPage$, signal);

      expect(store.get(currentPageNumber$)).toBe(1);
    });
  });

  describe("goForwardTwoPages$", () => {
    it("should navigate forward two pages", async () => {
      const { store, signal } = context;

      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            // Page 1 - has more
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor1" },
            });
          }
          if (cursor === "cursor1") {
            // Page 2 - has more
            return HttpResponse.json({
              data: [{ id: "log-2" }],
              pagination: { hasMore: true, nextCursor: "cursor2" },
            });
          }
          // Page 3 - no more
          return HttpResponse.json({
            data: [{ id: "log-3" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      expect(store.get(currentPageNumber$)).toBe(1);

      await store.set(goForwardTwoPages$, signal);
      expect(store.get(currentPageNumber$)).toBe(3);
    });

    it("should stop at last available page if less than two pages ahead", async () => {
      const { store, signal } = context;

      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            // First page - has more
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor1" },
            });
          }
          // Second page - no more
          return HttpResponse.json({
            data: [{ id: "log-2" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      await store.set(goForwardTwoPages$, signal);

      // Should stop at page 2 since there's no page 3
      expect(store.get(currentPageNumber$)).toBe(2);
    });
  });

  describe("goBackTwoPages$", () => {
    it("should navigate back two pages", async () => {
      const { store, signal } = context;

      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor1" },
            });
          }
          if (cursor === "cursor1") {
            return HttpResponse.json({
              data: [{ id: "log-2" }],
              pagination: { hasMore: true, nextCursor: "cursor2" },
            });
          }
          return HttpResponse.json({
            data: [{ id: "log-3" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      await store.set(goToNextPage$, signal);
      await store.set(goToNextPage$, signal);
      expect(store.get(currentPageNumber$)).toBe(3);

      store.set(goBackTwoPages$, signal);
      expect(store.get(currentPageNumber$)).toBe(1);
    });

    it("should go to first page if less than two pages back", async () => {
      const { store, signal } = context;

      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor1" },
            });
          }
          return HttpResponse.json({
            data: [{ id: "log-2" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      await store.set(goToNextPage$, signal);
      expect(store.get(currentPageNumber$)).toBe(2);

      store.set(goBackTwoPages$, signal);
      expect(store.get(currentPageNumber$)).toBe(1);
    });

    it("should not navigate when on first page", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);
      store.set(goBackTwoPages$, signal);

      expect(store.get(currentPageNumber$)).toBe(1);
    });
  });

  describe("setRowsPerPage$", () => {
    it("should update rows per page value", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);
      expect(store.get(rowsPerPageValue$)).toBe(10);

      store.set(setRowsPerPage$, { limit: 50, signal });
      expect(store.get(rowsPerPageValue$)).toBe(50);
    });

    it("should reset to first page when changing rows per page", async () => {
      const { store, signal } = context;

      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor123" },
            });
          }

          return HttpResponse.json({
            data: [{ id: "log-2" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      await store.set(goToNextPage$, signal);
      expect(store.get(currentPageNumber$)).toBe(2);

      store.set(setRowsPerPage$, { limit: 20, signal });
      expect(store.get(currentPageNumber$)).toBe(1);
    });
  });

  describe("setSearch$", () => {
    it("should update search query value", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);
      expect(store.get(searchQueryValue$)).toBe("");

      store.set(setSearch$, { search: "test-agent", signal });
      expect(store.get(searchQueryValue$)).toBe("test-agent");
    });

    it("should reset to first page when searching", async () => {
      const { store, signal } = context;

      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: { hasMore: true, nextCursor: "cursor123" },
            });
          }

          return HttpResponse.json({
            data: [{ id: "log-2" }],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      await store.set(goToNextPage$, signal);
      expect(store.get(currentPageNumber$)).toBe(2);

      store.set(setSearch$, { search: "my-agent", signal });
      expect(store.get(currentPageNumber$)).toBe(1);
    });

    it("should pass search parameter to API", async () => {
      const { store, signal } = context;

      let capturedSearch: string | null = null;
      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          capturedSearch = url.searchParams.get("search");
          return HttpResponse.json({
            data: [],
            pagination: { hasMore: false, nextCursor: null },
          });
        }),
      );

      store.set(initLogs$, signal);
      store.set(setSearch$, { search: "my-search-term", signal });

      // Trigger the fetch by awaiting the computed
      const page = store.get(currentPageLogs$);
      expect(page).not.toBeNull();
      await store.get(page!);

      // The search param should be set
      expect(capturedSearch).toBe("my-search-term");
    });
  });

  describe("hasPrevPage$", () => {
    it("should return false for hasPrevPage on first page", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);

      expect(store.get(hasPrevPage$)).toBeFalsy();
    });
  });

  describe("agent events pagination", () => {
    describe("initAccumulatedEvents$", () => {
      it("should initialize accumulated events with provided data", () => {
        const { store, signal } = context;

        store.set(initLogs$, signal);

        const events = [
          {
            sequenceNumber: 1,
            eventType: "test-event",
            eventData: { foo: "bar" },
            createdAt: "2024-01-01T00:00:00.000Z",
          },
          {
            sequenceNumber: 2,
            eventType: "test-event-2",
            eventData: { baz: "qux" },
            createdAt: "2024-01-01T00:00:01.000Z",
          },
        ];

        store.set(initAccumulatedEvents$, {
          events,
          hasMore: true,
        });

        expect(store.get(agentEventsAccumulated$)).toStrictEqual(events);
        expect(store.get(agentEventsHasMore$)).toBeTruthy();
      });

      it("should set hasMore to false when no more events", () => {
        const { store, signal } = context;

        store.set(initLogs$, signal);

        store.set(initAccumulatedEvents$, {
          events: [],
          hasMore: false,
        });

        expect(store.get(agentEventsAccumulated$)).toStrictEqual([]);
        expect(store.get(agentEventsHasMore$)).toBeFalsy();
      });
    });

    describe("loadMoreAgentEvents$", () => {
      it("should append new events to accumulated state", async () => {
        const { store, signal } = context;

        // Initialize with some events
        store.set(initLogs$, signal);

        const initialEvents = [
          {
            sequenceNumber: 1,
            eventType: "initial",
            eventData: {},
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ];

        store.set(initAccumulatedEvents$, {
          events: initialEvents,
          hasMore: true,
        });

        // Mock API for load more
        const moreEvents = [
          {
            sequenceNumber: 2,
            eventType: "more",
            eventData: {},
            createdAt: "2024-01-01T00:00:01.000Z",
          },
          {
            sequenceNumber: 3,
            eventType: "more-2",
            eventData: {},
            createdAt: "2024-01-01T00:00:02.000Z",
          },
        ];

        server.use(
          http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
            return HttpResponse.json({
              events: moreEvents,
              hasMore: false,
            });
          }),
        );

        await store.set(loadMoreAgentEvents$, {
          runId: "test-run-id",
          since: "2024-01-01T00:00:00.000Z",
        });

        const accumulated = store.get(agentEventsAccumulated$);
        expect(accumulated).toHaveLength(3);
        expect(accumulated[0]).toStrictEqual(initialEvents[0]);
        expect(accumulated[1]).toStrictEqual(moreEvents[0]);
        expect(accumulated[2]).toStrictEqual(moreEvents[1]);
        expect(store.get(agentEventsHasMore$)).toBeFalsy();
      });

      it("should set loading state during fetch", async () => {
        const { store, signal } = context;

        store.set(initLogs$, signal);
        store.set(initAccumulatedEvents$, {
          events: [
            {
              sequenceNumber: 1,
              eventType: "initial",
              eventData: {},
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
          hasMore: true,
        });

        let resolveRequest: (() => void) | null = null;
        const requestPromise = new Promise<void>((resolve) => {
          resolveRequest = resolve;
        });

        server.use(
          http.get("*/api/agent/runs/:runId/telemetry/agent", async () => {
            await requestPromise;
            return HttpResponse.json({
              events: [],
              hasMore: false,
            });
          }),
        );

        // Start loading (don't await)
        const loadPromise = store.set(loadMoreAgentEvents$, {
          runId: "test-run-id",
          since: "2024-01-01T00:00:00.000Z",
        });

        // Check loading state is true during fetch
        expect(store.get(agentEventsIsLoadingMore$)).toBeTruthy();

        // Resolve the request
        resolveRequest!();
        await loadPromise;

        // Loading state should be false after completion
        expect(store.get(agentEventsIsLoadingMore$)).toBeFalsy();
      });

      it("should pass correct parameters to API", async () => {
        const { store, signal } = context;

        store.set(initLogs$, signal);
        store.set(initAccumulatedEvents$, {
          events: [
            {
              sequenceNumber: 1,
              eventType: "initial",
              eventData: {},
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
          hasMore: true,
        });

        let capturedRunId: string | null = null;
        let capturedSince: string | null = null;
        let capturedLimit: string | null = null;
        let capturedOrder: string | null = null;

        server.use(
          http.get(
            "*/api/agent/runs/:runId/telemetry/agent",
            ({ request, params }) => {
              capturedRunId = params.runId as string;
              const url = new URL(request.url);
              capturedSince = url.searchParams.get("since");
              capturedLimit = url.searchParams.get("limit");
              capturedOrder = url.searchParams.get("order");
              return HttpResponse.json({
                events: [],
                hasMore: false,
              });
            },
          ),
        );

        const sinceDate = "2024-01-15T12:30:00.000Z";
        await store.set(loadMoreAgentEvents$, {
          runId: "my-test-run-123",
          since: sinceDate,
        });

        expect(capturedRunId).toBe("my-test-run-123");
        expect(capturedSince).toBe(String(new Date(sinceDate).getTime()));
        expect(capturedLimit).toBe("30");
        expect(capturedOrder).toBe("asc");
      });

      it("should update hasMore based on API response", async () => {
        const { store, signal } = context;

        store.set(initLogs$, signal);
        store.set(initAccumulatedEvents$, {
          events: [
            {
              sequenceNumber: 1,
              eventType: "initial",
              eventData: {},
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
          hasMore: true,
        });

        server.use(
          http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
            return HttpResponse.json({
              events: [
                {
                  sequenceNumber: 2,
                  eventType: "more",
                  eventData: {},
                  createdAt: "2024-01-01T00:00:01.000Z",
                },
              ],
              hasMore: true,
            });
          }),
        );

        await store.set(loadMoreAgentEvents$, {
          runId: "test-run-id",
          since: "2024-01-01T00:00:00.000Z",
        });

        expect(store.get(agentEventsHasMore$)).toBeTruthy();
      });

      it("should reset loading state on error", async () => {
        const { store, signal } = context;

        store.set(initLogs$, signal);
        store.set(initAccumulatedEvents$, {
          events: [
            {
              sequenceNumber: 1,
              eventType: "initial",
              eventData: {},
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
          hasMore: true,
        });

        server.use(
          http.get("*/api/agent/runs/:runId/telemetry/agent", () => {
            return HttpResponse.json(
              { error: "Internal Server Error" },
              { status: 500 },
            );
          }),
        );

        await expect(
          store.set(loadMoreAgentEvents$, {
            runId: "test-run-id",
            since: "2024-01-01T00:00:00.000Z",
          }),
        ).rejects.toThrow("Failed to fetch more agent events");

        // Loading state should be reset even on error
        expect(store.get(agentEventsIsLoadingMore$)).toBeFalsy();
      });
    });

    describe("initLogs$ resets accumulated events", () => {
      it("should reset accumulated events state on init", () => {
        const { store, signal } = context;

        // First set some accumulated events
        store.set(initLogs$, signal);
        store.set(initAccumulatedEvents$, {
          events: [
            {
              sequenceNumber: 1,
              eventType: "test",
              eventData: {},
              createdAt: "2024-01-01T00:00:00.000Z",
            },
          ],
          hasMore: true,
        });

        expect(store.get(agentEventsAccumulated$)).toHaveLength(1);
        expect(store.get(agentEventsHasMore$)).toBeTruthy();

        // Re-init logs should reset accumulated events
        store.set(initLogs$, signal);

        expect(store.get(agentEventsAccumulated$)).toStrictEqual([]);
        expect(store.get(agentEventsHasMore$)).toBeFalsy();
        expect(store.get(agentEventsIsLoadingMore$)).toBeFalsy();
      });
    });
  });
});
