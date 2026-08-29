import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION,
  type ChatEventCursor,
  type ChatEventSnapshotProjection,
} from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { createStore, type Store } from "ccstate";
import { afterEach, beforeAll } from "vitest";
import { i18n, initializeI18n } from "../../i18n/index.ts";
import { DEFAULT_LOCALE } from "../../i18n/resources.ts";
import { logger, resetLoggerForTest } from "../log";
import { resetLocalStorageForTest$ } from "../external/local-storage";
import { resetSessionStorageForTest$ } from "../external/session-storage.ts";
import { resetAllMockHandlers } from "../../mocks/handlers";
import { createTestMocks, type TestMocks } from "./test-mocks.ts";
import { isAbortError } from "../utils.ts";

const L = logger("Test");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function testCursorEventId(row: ChatEventRow): string {
  if (UUID_PATTERN.test(row.id)) {
    return row.id;
  }
  const suffix = row.seqId.toString(16).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${suffix}`;
}

export function chatEventRowsResponse(
  rows: readonly ChatEventRow[],
  query: {
    readonly sinceSeqId: number;
    readonly sinceEventId?: string;
    readonly sinceProjection?: ChatEventSnapshotProjection;
  },
  options: {
    readonly cursor?: ChatEventCursor;
    readonly hasMore?: boolean;
    readonly projection?: ChatEventSnapshotProjection;
  } = {},
): {
  readonly rows: ChatEventRow[];
  readonly cursor: ChatEventCursor;
  readonly hasMore: boolean;
  readonly projection: ChatEventSnapshotProjection;
} {
  const projection =
    options.projection ?? CANONICAL_CHAT_EVENT_SNAPSHOT_PROJECTION;
  const lastRow = rows.at(-1);
  let cursor: ChatEventCursor;
  if (options.cursor !== undefined) {
    cursor = options.cursor;
  } else if (lastRow !== undefined) {
    cursor = {
      // Many old UI fixtures use human-readable row IDs even though real DB
      // cursors are UUIDs. Normalize only the mock cursor boundary.
      lastEventId: testCursorEventId(lastRow),
      lastSeqId: lastRow.seqId,
      projection,
    };
  } else if (query.sinceEventId !== undefined) {
    if (query.sinceProjection === undefined) {
      throw new Error("Current Chat Event row cursors require a projection");
    }
    cursor = {
      lastEventId: query.sinceEventId,
      lastSeqId: query.sinceSeqId,
      projection: query.sinceProjection,
    };
  } else {
    cursor = { lastEventId: null, lastSeqId: 0 };
  }
  return {
    rows: [...rows],
    cursor,
    hasMore: options.hasMore ?? false,
    projection,
  };
}

export interface TestContext {
  readonly mocks: TestMocks;
  readonly resourceId: string;
  readonly signal: AbortSignal;
  readonly store: Store;
  readonly workerStore: Store;
  readonly track: (promise: Promise<unknown>) => void;
}

export function testContext(): TestContext {
  let store: Store | null = null;
  let workerStore: Store | null = null;
  let mocks: TestMocks | null = null;
  let resourceId: string | null = null;
  let controller = new AbortController();
  let trackedPromises: Promise<PromiseSettledResult<unknown>[]>[] = [];

  const context: TestContext = {
    get mocks(): TestMocks {
      if (!mocks) {
        mocks = createTestMocks(() => {
          return context.signal;
        });
        context.signal.addEventListener(
          "abort",
          () => {
            resetAllMockHandlers();
          },
          { once: true },
        );
      }
      return mocks;
    },
    get resourceId(): string {
      resourceId ??= crypto.randomUUID();
      return resourceId;
    },
    get signal(): AbortSignal {
      return controller.signal;
    },
    get store(): Store {
      if (!store) {
        L.debug("create store");
        store = createStore();
        context.signal.addEventListener("abort", () => {
          store?.set(resetLocalStorageForTest$);
          store?.set(resetSessionStorageForTest$);
          resetLoggerForTest();

          store = null;
        });
      }
      return store;
    },
    get workerStore(): Store {
      if (!workerStore) {
        L.debug("create worker store");
        workerStore = createStore();
        context.signal.addEventListener(
          "abort",
          () => {
            workerStore = null;
          },
          { once: true },
        );
      }
      return workerStore;
    },
    track(promise: Promise<unknown>): void {
      trackedPromises.push(Promise.allSettled([promise]));
    },
  };

  afterEach(async () => {
    L.debug("cleanup context");
    const error = new Error("Aborted due to finished test");
    error.name = "AbortError";
    controller.abort(error);
    const results = (await Promise.all(trackedPromises)).flat();
    trackedPromises = [];
    if (
      document.documentElement.lang !== DEFAULT_LOCALE ||
      (i18n.isInitialized && i18n.resolvedLanguage !== DEFAULT_LOCALE)
    ) {
      document.documentElement.lang = DEFAULT_LOCALE;
      await initializeI18n(DEFAULT_LOCALE);
    }
    mocks = null;
    resourceId = null;
    controller = new AbortController();

    const failedResult = results.find((result) => {
      return result.status === "rejected" && !isAbortError(result.reason);
    });
    if (failedResult?.status === "rejected") {
      throw failedResult.reason;
    }
  });

  return context;
}

/**
 * Loads the real mermaid parser behind the test stub before a file's first
 * test. The stub delegates `parse` to the real module, whose one-time
 * transform is too slow for the first diagram assertion's waitFor budget, so
 * files that render diagrams pay it in setup instead.
 */
export function warmMermaidParser(): void {
  beforeAll(async () => {
    const { default: mermaid } = await import("virtual:mermaid");
    await mermaid.parse("flowchart TD\n  A --> B", { suppressErrors: true });
  }, 30_000);
}
