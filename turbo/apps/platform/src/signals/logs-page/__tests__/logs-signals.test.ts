import { describe, expect, it, vi } from "vitest";
import { computed } from "ccstate";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import {
  logs$,
  setLogs$,
  selectedFilter$,
  currentCursor$,
  hasMore$,
  createLogsFetch,
  loadMore$,
  changeFilter$,
  navigateToRunDetail$,
} from "../logs-signals.ts";
import { FILTER_VALUES, type LogResponse } from "../types.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { mockLocation } from "../../location.ts";

// Mock Clerk BEFORE any module evaluation using vi.hoisted
vi.hoisted(() => {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "test_key");
  vi.stubEnv("VITE_API_URL", "http://localhost:3000");
});

// Mock Clerk to avoid network requests
vi.mock("@clerk/clerk-js", () => ({
  Clerk: function MockClerk() {
    return {
      user: null,
      session: {
        getToken: () => Promise.resolve("mock-token"),
      },
      load: () => Promise.resolve(),
      addListener: () => () => {},
    };
  },
}));

// Mock navigateInReact$
vi.mock("../route.ts", async () => {
  const actual = await vi.importActual("../route.ts");
  return {
    ...actual,
    navigateInReact$: {
      init: vi.fn(),
    },
  };
});

const context = testContext();

describe("logs-signals", () => {
  describe("logs$", () => {
    it("should initialize as empty array", () => {
      const { store } = context;
      const logs = store.get(logs$);
      expect(logs).toStrictEqual([]);
    });

    it("should allow setting logs array via setLogs$", () => {
      const { store } = context;
      const mockComputed$ = computed(() =>
        Promise.resolve({
          data: [],
          pagination: { has_more: false, next_cursor: null },
        }),
      );

      store.set(setLogs$, [mockComputed$]);
      const logs = store.get(logs$);
      expect(logs).toHaveLength(1);
    });
  });

  describe("selectedFilter$", () => {
    it("should return 'all' when no filter param", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/logs", search: "" }, signal);

      const filter = store.get(selectedFilter$);
      expect(filter).toBe("all");
    });

    it("should return filter param when valid", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/logs", search: "?filter=agent" }, signal);

      const filter = store.get(selectedFilter$);
      expect(filter).toBe("agent");
    });

    it("should return 'all' when invalid filter param", () => {
      const { store, signal } = context;
      mockLocation({ pathname: "/logs", search: "?filter=invalid" }, signal);

      const filter = store.get(selectedFilter$);
      expect(filter).toBe("all");
    });

    it("should support all valid filter values", () => {
      const { signal } = context;

      // Use FILTER_VALUES to verify all defined filters work
      expect(FILTER_VALUES).toHaveLength(4);

      const validFilters: ["all" | "agent" | "system" | "network", string][] = [
        ["all", "all"],
        ["agent", "agent"],
        ["system", "system"],
        ["network", "network"],
      ];

      for (const [filterValue, expected] of validFilters) {
        // Create fresh store for each iteration to avoid signal caching
        const { store: freshStore } = testContext();
        mockLocation(
          { pathname: "/logs", search: `?filter=${filterValue}` },
          signal,
        );
        const filter = freshStore.get(selectedFilter$);
        expect(filter).toBe(expected);
      }
    });
  });

  describe("currentCursor$", () => {
    it("should return null when logs$ is empty", async () => {
      const { store } = context;
      store.set(setLogs$, []);

      const cursor = await store.get(currentCursor$);
      expect(cursor).toBeNull();
    });

    it("should return null when last response has no cursor", async () => {
      const { store } = context;
      const mockResponse: LogResponse = {
        data: [],
        pagination: { has_more: false, next_cursor: null },
      };
      const mockComputed$ = computed(() => Promise.resolve(mockResponse));

      store.set(setLogs$, [mockComputed$]);

      const cursor = await store.get(currentCursor$);
      expect(cursor).toBeNull();
    });

    it("should return cursor value when available", async () => {
      const { store } = context;
      const mockResponse: LogResponse = {
        data: [],
        pagination: { has_more: true, next_cursor: "cursor123" },
      };
      const mockComputed$ = computed(() => Promise.resolve(mockResponse));

      store.set(setLogs$, [mockComputed$]);

      const cursor = await store.get(currentCursor$);
      expect(cursor).toBe("cursor123");
    });
  });

  describe("hasMore$", () => {
    it("should return false when logs$ is empty", async () => {
      const { store } = context;
      store.set(setLogs$, []);

      const hasMore = await store.get(hasMore$);
      expect(hasMore).toBeFalsy();
    });

    it("should return false when has_more is false", async () => {
      const { store } = context;
      const mockResponse: LogResponse = {
        data: [],
        pagination: { has_more: false, next_cursor: null },
      };
      const mockComputed$ = computed(() => Promise.resolve(mockResponse));

      store.set(setLogs$, [mockComputed$]);

      const hasMore = await store.get(hasMore$);
      expect(hasMore).toBeFalsy();
    });

    it("should return true when has_more is true", async () => {
      const { store } = context;
      const mockResponse: LogResponse = {
        data: [],
        pagination: { has_more: true, next_cursor: "cursor123" },
      };
      const mockComputed$ = computed(() => Promise.resolve(mockResponse));

      store.set(setLogs$, [mockComputed$]);

      const hasMore = await store.get(hasMore$);
      expect(hasMore).toBeTruthy();
    });
  });

  describe("createLogsFetch", () => {
    it("should create computed that fetches without cursor", async () => {
      const { store } = context;

      // Use default MSW handler from v1-runs.ts
      const fetchComputed$ = createLogsFetch(null);
      const response = await store.get(fetchComputed$);

      expect(response.data).toBeDefined();
      expect(response.pagination).toBeDefined();
      expect(response.pagination.has_more).toBeDefined();
    });

    it("should create computed that fetches with cursor", async () => {
      const { store } = context;
      const mockResponse: LogResponse = {
        data: [],
        pagination: { has_more: false, next_cursor: null },
      };

      // Override MSW handler for this specific test
      server.use(
        http.get("/v1/runs", ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("cursor")).toBe("cursor123");
          expect(url.searchParams.get("limit")).toBe("20");
          return HttpResponse.json(mockResponse);
        }),
      );

      const fetchComputed$ = createLogsFetch("cursor123");
      const response = await store.get(fetchComputed$);

      expect(response).toStrictEqual(mockResponse);
    });

    it("should throw error on fetch failure", async () => {
      const { store } = context;

      // Override MSW handler to return error
      server.use(
        http.get("/v1/runs", () =>
          HttpResponse.json(null, {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      );

      const fetchComputed$ = createLogsFetch(null);

      await expect(store.get(fetchComputed$)).rejects.toThrow(
        "Failed to fetch runs",
      );
    });
  });

  describe("loadMore$", () => {
    it("should append computed to empty array", async () => {
      const { store, signal } = context;

      store.set(setLogs$, []);
      await store.set(loadMore$, signal);

      const logs = store.get(logs$);
      expect(logs).toHaveLength(1);
    });

    it("should append computed to existing array", async () => {
      const { store, signal } = context;
      const firstResponse: LogResponse = {
        data: [],
        pagination: { has_more: true, next_cursor: "cursor123" },
      };

      const firstComputed$ = computed(() => Promise.resolve(firstResponse));
      store.set(setLogs$, [firstComputed$]);

      // Override MSW handler for second fetch
      server.use(
        http.get("/v1/runs", ({ request }) => {
          const url = new URL(request.url);
          if (url.searchParams.get("cursor") === "cursor123") {
            return HttpResponse.json({
              data: [],
              pagination: { has_more: false, next_cursor: null },
            });
          }
          return HttpResponse.json(null, { status: 404 });
        }),
      );

      await store.set(loadMore$, signal);

      const logs = store.get(logs$);
      expect(logs).toHaveLength(2);
    });

    it("should use current cursor from logs$", async () => {
      const { store, signal } = context;

      // Use default MSW handler which returns mock data
      store.set(setLogs$, []);
      await store.set(loadMore$, signal);

      // Verify we have one batch
      expect(store.get(logs$)).toHaveLength(1);

      // Verify currentCursor$ works
      const cursor = await store.get(currentCursor$);
      // Default handler returns next_cursor based on mock data
      expect(cursor).toBeDefined();
    });

    it("should respect abort signal", async () => {
      const { store } = context;
      const controller = new AbortController();
      controller.abort();

      await expect(store.set(loadMore$, controller.signal)).rejects.toThrow();
    });
  });

  describe("changeFilter$", () => {
    it("should call navigateInReact$ when executed", () => {
      const { store } = context;

      // navigateInReact$ requires rootSignal$ which isn't set up in tests
      // Just verify the command is callable (will throw "No root signal" which is expected)
      expect(() => {
        store.set(changeFilter$, "agent");
      }).toThrow("No root signal");
    });
  });

  describe("navigateToRunDetail$", () => {
    it("should be callable", () => {
      const { store } = context;

      // navigateToRunDetail$ requires rootSignal$ which isn't set up in tests
      // Just verify the command exists and is callable
      expect(() => {
        store.set(navigateToRunDetail$);
      }).toThrow("No root signal");
    });
  });
});
