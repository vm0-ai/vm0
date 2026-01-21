import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import {
  logs$,
  initLogs$,
  currentCursor$,
  hasMore$,
  loadMore$,
} from "../logs-signals.ts";
import { testContext } from "../../__tests__/test-helpers.ts";

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

const context = testContext();

describe("logs-signals", () => {
  describe("logs$", () => {
    it("should initialize as empty array", () => {
      const { store } = context;
      const logs = store.get(logs$);
      expect(logs).toStrictEqual([]);
    });
  });

  describe("initLogs$", () => {
    it("should load first batch", () => {
      const { store, signal } = context;

      store.set(initLogs$, signal);

      const logs = store.get(logs$);
      expect(logs).toHaveLength(1);
    });

    it("should clear existing logs before loading", async () => {
      const { store, signal } = context;

      // Load first batch
      store.set(initLogs$, signal);
      expect(store.get(logs$)).toHaveLength(1);

      // Load more to have 2 batches
      await store.set(loadMore$, signal);
      expect(store.get(logs$)).toHaveLength(2);

      // Initialize again should clear and start fresh
      store.set(initLogs$, signal);
      expect(store.get(logs$)).toHaveLength(1);
    });

    it("should respect abort signal", () => {
      const { store } = context;
      const controller = new AbortController();
      controller.abort();

      expect(() => store.set(initLogs$, controller.signal)).toThrow();
    });
  });

  describe("loadMore$", () => {
    it("should append new batch to existing logs", async () => {
      const { store, signal } = context;

      // Initialize with first batch
      store.set(initLogs$, signal);
      expect(store.get(logs$)).toHaveLength(1);

      // Load more should append
      await store.set(loadMore$, signal);
      expect(store.get(logs$)).toHaveLength(2);
    });

    it("should use cursor from previous batch", async () => {
      const { store, signal } = context;

      // Mock API to return specific cursor
      server.use(
        http.get("/v1/runs", ({ request }) => {
          const url = new URL(request.url);
          const cursor = url.searchParams.get("cursor");

          if (!cursor) {
            // First batch
            return HttpResponse.json({
              data: [],
              pagination: { has_more: true, next_cursor: "cursor123" },
            });
          }

          if (cursor === "cursor123") {
            // Second batch
            return HttpResponse.json({
              data: [],
              pagination: { has_more: false, next_cursor: null },
            });
          }

          return HttpResponse.json(null, { status: 404 });
        }),
      );

      store.set(initLogs$, signal);
      await store.set(loadMore$, signal);

      expect(store.get(logs$)).toHaveLength(2);
    });

    it("should respect abort signal", async () => {
      const { store } = context;
      const controller = new AbortController();
      controller.abort();

      await expect(store.set(loadMore$, controller.signal)).rejects.toThrow();
    });
  });

  describe("currentCursor$ and hasMore$", () => {
    it("should return null cursor and false hasMore when no logs", async () => {
      const { store } = context;

      const cursor = await store.get(currentCursor$);
      const hasMore = await store.get(hasMore$);

      expect(cursor).toBeNull();
      expect(hasMore).toBeFalsy();
    });

    it("should return cursor and hasMore from last batch", async () => {
      const { store, signal } = context;

      // Mock API response with cursor
      server.use(
        http.get("/v1/runs", () =>
          HttpResponse.json({
            data: [],
            pagination: { has_more: true, next_cursor: "cursor456" },
          }),
        ),
      );

      store.set(initLogs$, signal);

      const cursor = await store.get(currentCursor$);
      const hasMore = await store.get(hasMore$);

      expect(cursor).toBe("cursor456");
      expect(hasMore).toBeTruthy();
    });

    it("should return null cursor when has_more is false", async () => {
      const { store, signal } = context;

      // Mock API response without cursor
      server.use(
        http.get("/v1/runs", () =>
          HttpResponse.json({
            data: [],
            pagination: { has_more: false, next_cursor: null },
          }),
        ),
      );

      store.set(initLogs$, signal);

      const cursor = await store.get(currentCursor$);
      const hasMore = await store.get(hasMore$);

      expect(cursor).toBeNull();
      expect(hasMore).toBeFalsy();
    });
  });
});
