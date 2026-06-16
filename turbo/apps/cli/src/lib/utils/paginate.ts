/**
 * Generic pagination utility for fetching items across multiple API pages.
 * Supports both limited pagination (fetch up to N items) and unlimited pagination (fetch all items).
 */

interface PaginateOptions<T> {
  /**
   * Function to fetch a single page of items.
   * @param since - Timestamp cursor for pagination (undefined for first page)
   * @returns Promise with items array and hasMore flag
   */
  fetchPage: (since?: number) => Promise<{ items: T[]; hasMore: boolean }>;

  /**
   * Function to extract timestamp from an item for cursor-based pagination.
   * @param item - The item to extract timestamp from
   * @returns Timestamp in milliseconds
   */
  getTimestamp: (item: T) => number;

  /**
   * Target number of items to collect, or "all" for unlimited.
   */
  targetCount: number | "all";

  /**
   * Initial since timestamp (optional, used when --since flag is provided).
   */
  initialSince?: number;
}

/**
 * Paginate through API responses, collecting items until target count is reached
 * or no more items are available.
 *
 * @param options - Pagination configuration
 * @returns Promise resolving to array of collected items
 * @throws Error if any page fetch fails (no partial results)
 */
export async function paginate<T>(options: PaginateOptions<T>): Promise<T[]> {
  const { fetchPage, getTimestamp, targetCount, initialSince } = options;

  const collected: T[] = [];
  let since = initialSince;
  let hasMore = true;

  while (hasMore) {
    const response = await fetchPage(since);

    if (response.items.length === 0) {
      break;
    }

    const lastItem = response.items[response.items.length - 1]!;
    const nextSince = getTimestamp(lastItem);
    if (
      since !== undefined &&
      (!Number.isFinite(nextSince) || nextSince === since)
    ) {
      break;
    }

    collected.push(...response.items);
    hasMore = response.hasMore;

    if (targetCount !== "all" && collected.length >= targetCount) {
      return collected.slice(0, targetCount);
    }

    if (!Number.isFinite(nextSince)) {
      break;
    }
    since = nextSince;
  }

  return collected;
}
