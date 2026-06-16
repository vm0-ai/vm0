import { describe, expect, it, vi } from "vitest";

import { paginate } from "../paginate";

interface Item {
  readonly id: string;
  readonly timestamp: number;
}

type FetchPage = (
  since: number | undefined,
) => Promise<{ items: Item[]; hasMore: boolean }>;

describe("paginate", () => {
  it("stops without appending a page when the cursor does not advance", async () => {
    const firstPage = [{ id: "first", timestamp: 100 }];
    const duplicatePage = [{ id: "duplicate", timestamp: 100 }];
    const fetchPage = vi
      .fn<FetchPage>()
      .mockResolvedValueOnce({ items: firstPage, hasMore: true })
      .mockResolvedValueOnce({ items: duplicatePage, hasMore: true });

    const items = await paginate<Item>({
      fetchPage,
      getTimestamp: (item) => {
        return item.timestamp;
      },
      targetCount: "all",
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 100);
    expect(items).toStrictEqual(firstPage);
  });

  it("returns the first page but stops when the cursor timestamp is invalid", async () => {
    const firstPage = [{ id: "bad-cursor", timestamp: Number.NaN }];
    const fetchPage = vi
      .fn<FetchPage>()
      .mockResolvedValue({ items: firstPage, hasMore: true });

    const items = await paginate<Item>({
      fetchPage,
      getTimestamp: (item) => {
        return item.timestamp;
      },
      targetCount: "all",
    });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(items).toStrictEqual(firstPage);
  });
});
