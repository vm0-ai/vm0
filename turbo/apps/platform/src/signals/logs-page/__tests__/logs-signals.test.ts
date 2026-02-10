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
});
