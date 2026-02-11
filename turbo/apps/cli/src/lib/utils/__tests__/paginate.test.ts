/**
 * Tests for paginate utility
 */

import { describe, it, expect, vi } from "vitest";
import { paginate } from "../paginate";

interface TestItem {
  id: number;
  ts: number;
}

describe("paginate", () => {
  it("should collect all items when targetCount is 'all'", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: 1, ts: 1000 }],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: 2, ts: 2000 }],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: 3, ts: 3000 }],
        hasMore: false,
      });

    const result = await paginate<TestItem>({
      fetchPage,
      getTimestamp: (item) => item.ts,
      targetCount: "all",
    });

    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("should stop when targetCount is reached", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({
      items: [
        { id: 1, ts: 1000 },
        { id: 2, ts: 2000 },
        { id: 3, ts: 3000 },
      ],
      hasMore: true,
    });

    const result = await paginate<TestItem>({
      fetchPage,
      getTimestamp: (item) => item.ts,
      targetCount: 2,
    });

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("should paginate until targetCount is reached across pages", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { id: 1, ts: 1000 },
          { id: 2, ts: 2000 },
        ],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [
          { id: 3, ts: 3000 },
          { id: 4, ts: 4000 },
        ],
        hasMore: true,
      });

    const result = await paginate<TestItem>({
      fetchPage,
      getTimestamp: (item) => item.ts,
      targetCount: 3,
    });

    expect(result).toHaveLength(3);
    expect(result.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("should pass correct since cursor to subsequent pages", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: 1, ts: 1000 }],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [{ id: 2, ts: 2000 }],
        hasMore: false,
      });

    await paginate<TestItem>({
      fetchPage,
      getTimestamp: (item) => item.ts,
      targetCount: "all",
    });

    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 1000);
  });

  it("should use initialSince for first page", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({
      items: [{ id: 1, ts: 2000 }],
      hasMore: false,
    });

    await paginate<TestItem>({
      fetchPage,
      getTimestamp: (item) => item.ts,
      targetCount: "all",
      initialSince: 1000,
    });

    expect(fetchPage).toHaveBeenCalledWith(1000);
  });

  it("should stop when no items returned", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: 1, ts: 1000 }],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [],
        hasMore: true, // API says hasMore but returns no items
      });

    const result = await paginate<TestItem>({
      fetchPage,
      getTimestamp: (item) => item.ts,
      targetCount: "all",
    });

    expect(result).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("should propagate fetch errors", async () => {
    const fetchPage = vi.fn().mockRejectedValueOnce(new Error("API error"));

    await expect(
      paginate<TestItem>({
        fetchPage,
        getTimestamp: (item) => item.ts,
        targetCount: "all",
      }),
    ).rejects.toThrow("API error");
  });

  it("should return empty array when first page is empty", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({
      items: [],
      hasMore: false,
    });

    const result = await paginate<TestItem>({
      fetchPage,
      getTimestamp: (item) => item.ts,
      targetCount: "all",
    });

    expect(result).toHaveLength(0);
  });
});
