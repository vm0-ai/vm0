type LogOrder = "asc" | "desc";

interface CursorLogPageRequest {
  readonly sinceTime?: number;
  readonly cursor?: string;
  readonly limit: number;
  readonly order: LogOrder;
}

interface CursorLogPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor?: string | null;
}

interface CollectLogItemsOptions<T> {
  readonly fetchPage: (
    request: CursorLogPageRequest,
  ) => Promise<CursorLogPage<T>>;
  readonly sinceTime?: number;
  readonly targetCount: number | "all";
  readonly order: LogOrder;
  readonly pageLimit: number;
}

export function parsePositiveLogCount(
  value: string,
  optionName: string,
): number {
  const trimmed = value.trim();
  if (!/^0*[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Option ${optionName} must be a positive integer`);
  }

  const count = Number(trimmed);
  if (!Number.isSafeInteger(count)) {
    throw new Error(`Option ${optionName} must be a positive integer`);
  }

  return count;
}

export async function collectLogItems<T>(
  options: CollectLogItemsOptions<T>,
): Promise<T[]> {
  const collected: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const requestLimit =
      options.targetCount === "all"
        ? options.pageLimit
        : Math.min(options.pageLimit, options.targetCount - collected.length);

    const page = await options.fetchPage({
      sinceTime: options.sinceTime,
      cursor,
      limit: requestLimit,
      order: options.order,
    });

    collected.push(...page.items);

    if (page.items.length === 0) {
      break;
    }

    if (
      options.targetCount !== "all" &&
      collected.length >= options.targetCount
    ) {
      break;
    }

    const nextCursor = page.nextCursor ?? null;
    if (!page.hasMore || !nextCursor || seenCursors.has(nextCursor)) {
      break;
    }

    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  const entries =
    options.targetCount === "all"
      ? collected
      : collected.slice(0, options.targetCount);

  return options.order === "desc" ? entries.reverse() : entries;
}
