import { computed } from "ccstate";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  logs$,
  setLogs$,
  selectedFilter$,
  currentCursor$,
  hasMore$,
  createLogsFetch,
  loadMore$,
  changeFilter$,
} from "../logs-signals.ts";
import type { LogResponse } from "../types.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { mockLocation } from "../../location.ts";
import * as route from "../../route.ts";

const context = testContext();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Mock the fetch$ signal to return the global fetch
vi.mock("../../fetch.ts", () => ({
  fetch$: computed(() => async (url: string) => {
    const response = await fetch(url);
    return response;
  }),
}));

// Mock navigateInReact$
vi.mock("../../route.ts", async () => {
  const actual = await vi.importActual<typeof route>("../../route.ts");
  return {
    ...actual,
    navigateInReact$: {
      init: vi.fn(),
    },
  };
});

describe("logs-signals", () => {
  describe("logs$", () => {
    it("should initialize as empty array", () => {
      const { store } = context;
      const logs = store.get(logs$);
      expect(logs).toStrictEqual([]);
    });

    it("should allow setting logs array", () => {
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
      const validFilters: ["all" | "agent" | "system" | "network", string][] =
        [
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
      const mockResponse: LogResponse = {
        data: [
          {
            id: "run_123",
            agent_id: "agent_456",
            agent_name: "Test Agent",
            status: "completed",
            prompt: "test prompt",
            created_at: "2024-01-01T00:00:00Z",
            started_at: "2024-01-01T00:00:01Z",
            completed_at: "2024-01-01T00:00:10Z",
          },
        ],
        pagination: { has_more: false, next_cursor: null },
      };

      vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
        const urlObj =
          url instanceof Request ? new URL(url.url) : new URL(url);
        expect(urlObj.searchParams.get("cursor")).toBeNull();
        expect(urlObj.searchParams.get("limit")).toBe("20");
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      const fetchComputed = createLogsFetch(null);
      const response = await store.get(fetchComputed);

      expect(response).toStrictEqual(mockResponse);
    });

    it("should create computed that fetches with cursor", async () => {
      const { store } = context;
      const mockResponse: LogResponse = {
        data: [],
        pagination: { has_more: false, next_cursor: null },
      };

      vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
        const urlObj =
          url instanceof Request ? new URL(url.url) : new URL(url);
        expect(urlObj.searchParams.get("cursor")).toBe("cursor123");
        expect(urlObj.searchParams.get("limit")).toBe("20");
        return Promise.resolve(
          new Response(JSON.stringify(mockResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      });

      const fetchComputed = createLogsFetch("cursor123");
      const response = await store.get(fetchComputed);

      expect(response).toStrictEqual(mockResponse);
    });

    it("should throw error on fetch failure", async () => {
      const { store } = context;

      vi.mocked(fetch).mockImplementation(() =>
        Promise.resolve(
          new Response(null, {
            status: 500,
            statusText: "Internal Server Error",
          }),
        ),
      );

      const fetchComputed = createLogsFetch(null);

      await expect(store.get(fetchComputed)).rejects.toThrow(
        "Failed to fetch runs: Internal Server Error",
      );
    });
  });

  describe("loadMore$", () => {
    it("should append computed to empty array", async () => {
      const { store, signal } = context;
      const mockResponse: LogResponse = {
        data: [],
        pagination: { has_more: false, next_cursor: null },
      };

      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

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
      const secondResponse: LogResponse = {
        data: [],
        pagination: { has_more: false, next_cursor: null },
      };

      const firstComputed$ = computed(() => Promise.resolve(firstResponse));
      store.set(setLogs$, [firstComputed$]);

      vi.mocked(fetch).mockImplementation((url: string | URL | Request) => {
        const urlObj =
          url instanceof Request ? new URL(url.url) : new URL(url);
        if (urlObj.searchParams.get("cursor") === "cursor123") {
          return Promise.resolve(
            new Response(JSON.stringify(secondResponse), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      });

      await store.set(loadMore$, signal);

      const logs = store.get(logs$);
      expect(logs).toHaveLength(2);
    });

    it("should use current cursor from logs$", async () => {
      const { store, signal } = context;
      const firstResponse: LogResponse = {
        data: [
          {
            id: "run_1",
            agent_id: "agent_1",
            agent_name: "Agent 1",
            status: "completed",
            prompt: "test",
            created_at: "2024-01-01T00:00:00Z",
            started_at: null,
            completed_at: null,
          },
        ],
        pagination: { has_more: true, next_cursor: "cursor-abc" },
      };

      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(firstResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      // Load first batch
      store.set(setLogs$, []);
      await store.set(loadMore$, signal);

      // Verify we have one batch
      expect(store.get(logs$)).toHaveLength(1);

      // Verify currentCursor$ returns the cursor from first batch
      const cursor = await store.get(currentCursor$);
      expect(cursor).toBe("cursor-abc");
    });

    it("should respect abort signal", async () => {
      const { store } = context;
      const controller = new AbortController();
      controller.abort();

      vi.mocked(fetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [],
            pagination: { has_more: false, next_cursor: null },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

      await expect(store.set(loadMore$, controller.signal)).rejects.toThrow();
    });
  });

  describe("changeFilter$", () => {
    it("should not throw when called", () => {
      const { store } = context;

      // Just verify the command runs without errors
      expect(() => {
        store.set(changeFilter$, "agent");
      }).not.toThrow();
    });
  });
});
