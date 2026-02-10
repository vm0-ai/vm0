import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import {
  limit$,
  cursor$,
  search$,
  currentPageLogs$,
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
} from "../../../signals/logs-page/logs-signals.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";

const context = testContext();

describe("logs page signals", () => {
  describe("url-derived computeds", () => {
    it("limit$ defaults to 10", async () => {
      await setupPage({ context, path: "/logs" });
      expect(context.store.get(limit$)).toBe(10);
    });

    it("limit$ parses valid limit from URL", async () => {
      await setupPage({ context, path: "/logs?limit=50" });
      expect(context.store.get(limit$)).toBe(50);
    });

    it("limit$ ignores invalid limit values", async () => {
      await setupPage({ context, path: "/logs?limit=999" });
      expect(context.store.get(limit$)).toBe(10);
    });

    it("cursor$ reads cursor from URL", async () => {
      await setupPage({ context, path: "/logs?cursor=abc123" });
      expect(context.store.get(cursor$)).toBe("abc123");
    });

    it("cursor$ returns null when no cursor", async () => {
      await setupPage({ context, path: "/logs" });
      expect(context.store.get(cursor$)).toBeNull();
    });

    it("search$ reads search from URL", async () => {
      await setupPage({ context, path: "/logs?search=my-agent" });
      expect(context.store.get(search$)).toBe("my-agent");
    });

    it("search$ returns empty string when no search", async () => {
      await setupPage({ context, path: "/logs" });
      expect(context.store.get(search$)).toBe("");
    });

    it("rowsPerPageValue$ aliases limit$", async () => {
      await setupPage({ context, path: "/logs?limit=20" });
      expect(context.store.get(rowsPerPageValue$)).toBe(20);
    });

    it("searchQueryValue$ aliases search$", async () => {
      await setupPage({ context, path: "/logs?search=test" });
      expect(context.store.get(searchQueryValue$)).toBe("test");
    });
  });

  describe("currentPageLogs$", () => {
    it("fetches logs with params from URL", async () => {
      let capturedUrl = "";
      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          capturedUrl = request.url;
          return HttpResponse.json({
            data: [{ id: "log-1" }],
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });

      const result = await context.store.get(currentPageLogs$);
      expect(result.data).toHaveLength(1);

      const url = new URL(capturedUrl);
      expect(url.searchParams.get("limit")).toBe("10");
    });
  });

  describe("pagination computeds", () => {
    it("hasPrevPage$ is false when cursor is null", async () => {
      await setupPage({ context, path: "/logs" });
      expect(context.store.get(hasPrevPage$)).toBeFalsy();
    });

    it("hasPrevPage$ is true when cursor is set", async () => {
      await setupPage({ context, path: "/logs?cursor=abc" });
      expect(context.store.get(hasPrevPage$)).toBeTruthy();
    });

    it("currentPageNumber$ returns 1 on first page", async () => {
      await setupPage({ context, path: "/logs" });
      expect(context.store.get(currentPageNumber$)).toBe(1);
    });

    it("currentPageNumber$ returns correct page from history", async () => {
      await setupPage({ context, path: "/logs?cursor=abc" });
      expect(context.store.get(currentPageNumber$)).toBe(2);
    });
  });

  describe("pagination navigation", () => {
    it("goToNextPage$ writes next cursor to URL", async () => {
      server.use(
        http.get("*/api/platform/logs", () => {
          return HttpResponse.json({
            data: [{ id: "log-1" }],
            pagination: {
              hasMore: true,
              nextCursor: "cursor123",
              totalPages: 2,
            },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goToNextPage$);

      expect(context.store.get(cursor$)).toBe("cursor123");
      expect(context.store.get(currentPageNumber$)).toBe(2);
    });

    it("goToPrevPage$ writes previous cursor to URL", async () => {
      server.use(
        http.get("*/api/platform/logs", () => {
          return HttpResponse.json({
            data: [{ id: "log-1" }],
            pagination: {
              hasMore: true,
              nextCursor: "cursor123",
              totalPages: 2,
            },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goToNextPage$);
      expect(context.store.get(currentPageNumber$)).toBe(2);
      expect(context.store.get(hasPrevPage$)).toBeTruthy();

      context.store.set(goToPrevPage$);
      expect(context.store.get(cursor$)).toBeNull();
      expect(context.store.get(currentPageNumber$)).toBe(1);
      expect(context.store.get(hasPrevPage$)).toBeFalsy();
    });

    it("should not navigate to previous page when on first page", async () => {
      await setupPage({ context, path: "/logs" });
      context.store.set(goToPrevPage$);
      expect(context.store.get(currentPageNumber$)).toBe(1);
    });
  });

  describe("goForwardTwoPages$", () => {
    it("should navigate forward two pages", async () => {
      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: {
                hasMore: true,
                nextCursor: "cursor1",
                totalPages: 3,
              },
            });
          }
          if (cursor === "cursor1") {
            return HttpResponse.json({
              data: [{ id: "log-2" }],
              pagination: {
                hasMore: true,
                nextCursor: "cursor2",
                totalPages: 3,
              },
            });
          }
          return HttpResponse.json({
            data: [{ id: "log-3" }],
            pagination: { hasMore: false, nextCursor: null, totalPages: 3 },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goForwardTwoPages$);
      expect(context.store.get(currentPageNumber$)).toBe(3);
    });

    it("should stop at last available page if less than two pages ahead", async () => {
      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: {
                hasMore: true,
                nextCursor: "cursor1",
                totalPages: 2,
              },
            });
          }
          return HttpResponse.json({
            data: [{ id: "log-2" }],
            pagination: { hasMore: false, nextCursor: null, totalPages: 2 },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goForwardTwoPages$);
      expect(context.store.get(currentPageNumber$)).toBe(2);
    });
  });

  describe("goBackTwoPages$", () => {
    it("should navigate back two pages", async () => {
      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            return HttpResponse.json({
              data: [{ id: "log-1" }],
              pagination: {
                hasMore: true,
                nextCursor: "cursor1",
                totalPages: 3,
              },
            });
          }
          if (cursor === "cursor1") {
            return HttpResponse.json({
              data: [{ id: "log-2" }],
              pagination: {
                hasMore: true,
                nextCursor: "cursor2",
                totalPages: 3,
              },
            });
          }
          return HttpResponse.json({
            data: [{ id: "log-3" }],
            pagination: { hasMore: false, nextCursor: null, totalPages: 3 },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goToNextPage$);
      await context.store.set(goToNextPage$);
      expect(context.store.get(currentPageNumber$)).toBe(3);

      context.store.set(goBackTwoPages$);
      expect(context.store.get(currentPageNumber$)).toBe(1);
    });

    it("should go to first page if less than two pages back", async () => {
      server.use(
        http.get("*/api/platform/logs", () => {
          return HttpResponse.json({
            data: [{ id: "log-1" }],
            pagination: {
              hasMore: true,
              nextCursor: "cursor1",
              totalPages: 2,
            },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goToNextPage$);
      expect(context.store.get(currentPageNumber$)).toBe(2);

      context.store.set(goBackTwoPages$);
      expect(context.store.get(currentPageNumber$)).toBe(1);
    });

    it("should not navigate when on first page", async () => {
      await setupPage({ context, path: "/logs" });
      context.store.set(goBackTwoPages$);
      expect(context.store.get(currentPageNumber$)).toBe(1);
    });
  });

  describe("setRowsPerPage$", () => {
    it("should write limit to URL", async () => {
      await setupPage({ context, path: "/logs" });
      expect(context.store.get(rowsPerPageValue$)).toBe(10);

      context.store.set(setRowsPerPage$, 50);
      expect(context.store.get(rowsPerPageValue$)).toBe(50);
    });

    it("should reset cursor when changing rows per page", async () => {
      server.use(
        http.get("*/api/platform/logs", () => {
          return HttpResponse.json({
            data: [{ id: "log-1" }],
            pagination: {
              hasMore: true,
              nextCursor: "cursor123",
              totalPages: 2,
            },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goToNextPage$);
      expect(context.store.get(currentPageNumber$)).toBe(2);

      context.store.set(setRowsPerPage$, 20);
      expect(context.store.get(currentPageNumber$)).toBe(1);
      expect(context.store.get(cursor$)).toBeNull();
    });
  });

  describe("setSearch$", () => {
    it("should write search to URL", async () => {
      await setupPage({ context, path: "/logs" });
      expect(context.store.get(searchQueryValue$)).toBe("");

      context.store.set(setSearch$, "test-agent");
      expect(context.store.get(searchQueryValue$)).toBe("test-agent");
    });

    it("should reset cursor when searching", async () => {
      server.use(
        http.get("*/api/platform/logs", () => {
          return HttpResponse.json({
            data: [{ id: "log-1" }],
            pagination: {
              hasMore: true,
              nextCursor: "cursor123",
              totalPages: 2,
            },
          });
        }),
      );

      await setupPage({ context, path: "/logs" });
      await context.store.set(goToNextPage$);
      expect(context.store.get(currentPageNumber$)).toBe(2);

      context.store.set(setSearch$, "my-agent");
      expect(context.store.get(currentPageNumber$)).toBe(1);
      expect(context.store.get(cursor$)).toBeNull();
    });

    it("should pass search parameter to API", async () => {
      await setupPage({ context, path: "/logs" });
      context.store.set(setSearch$, "my-search-term");

      let capturedSearch: string | null = null;
      server.use(
        http.get("*/api/platform/logs", ({ request }) => {
          const url = new URL(request.url);
          capturedSearch = url.searchParams.get("search");
          return HttpResponse.json({
            data: [],
            pagination: { hasMore: false, nextCursor: null, totalPages: 1 },
          });
        }),
      );

      await context.store.get(currentPageLogs$);
      expect(capturedSearch).toBe("my-search-term");
    });
  });
});
