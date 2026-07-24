import type { IDBPDatabase } from "idb";
import {
  artifactItemSchema,
  type ArtifactItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  artifactMatchesCategory,
  type ArtifactCategory,
} from "../artifacts-page/artifact-category.ts";
import {
  artifactSearchText,
  normalizedSearchTokens,
} from "../artifacts-page/artifact-search.ts";
import { logger } from "../log.ts";
import {
  ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX,
  ARTIFACT_ITEMS_RUN_HOSTED_INDEX,
  ARTIFACT_ITEMS_STORE,
  ARTIFACT_ITEMS_UPDATED_AT_INDEX,
  ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX,
  ARTIFACT_SYNC_STORE,
} from "./chat-idb-schema.ts";
import { chatIdbReadOr, withChatIdbTimeout } from "./chat-idb-safe.ts";
import { withCleanup } from "../utils.ts";

const L = logger("ChatIdbCache");
const DEFAULT_ARTIFACT_ITEM_LIMIT = 50;
const ARTIFACT_SYNC_STATE_ID = "artifacts";

function storedLastSyncedAt(raw: unknown): string {
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    (raw as { id?: unknown }).id === ARTIFACT_SYNC_STATE_ID &&
    typeof (raw as { lastSyncedAt?: unknown }).lastSyncedAt === "string" &&
    !Number.isNaN(Date.parse((raw as { lastSyncedAt: string }).lastSyncedAt))
  ) {
    return (raw as { lastSyncedAt: string }).lastSyncedAt;
  }
  throw new Error("Invalid artifact sync state");
}

const storedArtifactItemSchema = artifactItemSchema
  .extend({
    hosted: artifactItemSchema.shape.size.unwrap(),
    size: artifactItemSchema.shape.size.unwrap(),
    searchText: artifactItemSchema.shape.filename,
  })
  .strict();
type StoredArtifactItem = ArtifactItem & {
  readonly hosted: 0 | 1;
  readonly searchText: string;
};

interface ArtifactItemCacheFilter {
  readonly agentId?: string;
  readonly artifactCategory?: ArtifactCategory;
  readonly query?: string;
  readonly limit?: number;
}

interface ArtifactItemReadStore {
  readRecent(
    filter?: ArtifactItemCacheFilter,
    signal?: AbortSignal,
  ): Promise<ArtifactItem[]>;
  readLastSyncedAt(signal?: AbortSignal): Promise<string | null>;
}

interface ArtifactItemWriteStore {
  beginFullSync(signal?: AbortSignal): Promise<void>;
  upsertItems(
    items: readonly ArtifactItem[],
    signal?: AbortSignal,
  ): Promise<void>;
  finishSync(lastSyncedAt: string, signal?: AbortSignal): Promise<void>;
}

interface ArtifactItemStores {
  readonly readStore: ArtifactItemReadStore;
  readonly writeStore: ArtifactItemWriteStore;
}

type GetDb = () => Promise<IDBPDatabase>;

interface IndexedReadPlan {
  readonly indexName: string;
  readonly range?: IDBKeyRange;
}

interface ValidatedStoredArtifactItem {
  readonly hosted: boolean;
  readonly item: ArtifactItem;
  readonly searchText: string;
}

async function runAbortableTransaction<T>(
  transaction: {
    readonly done: Promise<unknown>;
    abort(): void;
  },
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const abortTransaction = () => {
    transaction.abort();
  };
  signal?.addEventListener("abort", abortTransaction, { once: true });
  return await withCleanup(
    (async () => {
      signal?.throwIfAborted();
      const result = await operation();
      signal?.throwIfAborted();
      await transaction.done;
      return result;
    })(),
    () => {
      signal?.removeEventListener("abort", abortTransaction);
    },
  );
}

function storedArtifactItem(item: ArtifactItem): StoredArtifactItem {
  const cachedItem: ArtifactItem = artifactItemSchema.parse(item);
  return {
    ...cachedItem,
    hosted: artifactIsHosted(cachedItem) ? 1 : 0,
    searchText: artifactSearchText(cachedItem),
  };
}

function validateStoredArtifactItem(raw: unknown): ValidatedStoredArtifactItem {
  const { hosted, searchText, ...item } = storedArtifactItemSchema.parse(raw);
  if (hosted !== 0 && hosted !== 1) {
    throw new Error("Invalid stored artifact hosted flag");
  }
  return {
    hosted: hosted === 1,
    item,
    searchText,
  };
}

function prefixRange(prefix: IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound(prefix, [...prefix, []]);
}

function artifactIsHosted(item: ArtifactItem): boolean {
  return (
    item.artifactKind === "hosted-site" ||
    item.artifactKind === "presentation-html"
  );
}

function indexedReadPlan(filter: ArtifactItemCacheFilter): IndexedReadPlan {
  if (filter.agentId) {
    return {
      indexName: ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX,
      range: prefixRange([filter.agentId]),
    };
  }
  return { indexName: ARTIFACT_ITEMS_UPDATED_AT_INDEX };
}

function matchesFilter(
  stored: ValidatedStoredArtifactItem,
  filter: ArtifactItemCacheFilter,
  queryTokens: readonly string[],
): boolean {
  const item = stored.item;
  if (filter.agentId && item.agentId !== filter.agentId) {
    return false;
  }
  if (!artifactMatchesCategory(item, filter.artifactCategory)) {
    return false;
  }
  return queryTokens.every((token) => {
    return stored.searchText.includes(token);
  });
}

async function readRecentItems(
  storeName: string,
  getDb: GetDb,
  filter?: ArtifactItemCacheFilter,
  signal?: AbortSignal,
): Promise<ArtifactItem[]> {
  const effectiveFilter = filter ?? {};
  const limit = effectiveFilter.limit ?? DEFAULT_ARTIFACT_ITEM_LIMIT;
  if (limit <= 0) {
    return [];
  }

  const db = await getDb();
  signal?.throwIfAborted();
  const tx = db.transaction(storeName, "readonly");
  const plan = indexedReadPlan(effectiveFilter);
  const index = tx.store.index(plan.indexName);
  const runHostedIndex = tx.store.index(ARTIFACT_ITEMS_RUN_HOSTED_INDEX);
  const urlIndex = tx.store.index(ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX);
  const queryTokens = normalizedSearchTokens(effectiveFilter.query);
  const items = await runAbortableTransaction(
    tx,
    async (): Promise<ArtifactItem[]> => {
      const hostedRuns = new Map<string, boolean>();
      const urlWinners = new Map<string, string | null>();
      const recent: ArtifactItem[] = [];
      const isVisibleArtifact = async (
        candidate: ValidatedStoredArtifactItem,
      ): Promise<boolean> => {
        if (candidate.hosted) {
          return true;
        }
        let runIsHosted = hostedRuns.get(candidate.item.runId);
        if (runIsHosted === undefined) {
          runIsHosted =
            (await runHostedIndex.get([candidate.item.runId, 1])) !== undefined;
          hostedRuns.set(candidate.item.runId, runIsHosted);
        }
        return !runIsHosted;
      };
      const findUrlWinner = async (url: string): Promise<string | null> => {
        let winnerCursor = await urlIndex.openCursor(
          prefixRange([url]),
          "prev",
        );
        while (winnerCursor) {
          const candidate = validateStoredArtifactItem(winnerCursor.value);
          if (await isVisibleArtifact(candidate)) {
            return candidate.item.artifactItemId;
          }
          winnerCursor = await winnerCursor.continue();
        }
        return null;
      };
      let cursor = await index.openCursor(plan.range, "prev");
      while (cursor && recent.length < limit) {
        signal?.throwIfAborted();
        const stored = validateStoredArtifactItem(cursor.value);
        if (
          matchesFilter(stored, effectiveFilter, queryTokens) &&
          (await isVisibleArtifact(stored))
        ) {
          let urlWinner = urlWinners.get(stored.item.url);
          if (urlWinner === undefined) {
            urlWinner = await findUrlWinner(stored.item.url);
            urlWinners.set(stored.item.url, urlWinner);
          }

          if (stored.item.artifactItemId === urlWinner) {
            recent.push(stored.item);
          }
        }
        if (recent.length >= limit) {
          break;
        }
        cursor = await cursor.continue();
      }
      return recent;
    },
    signal,
  );
  L.debug("artifacts:readRecent:done", {
    count: items.length,
    filter: effectiveFilter,
  });
  return items;
}

function createReadStore(
  storeName: string,
  getDb: GetDb,
): ArtifactItemReadStore {
  return {
    async readRecent(filter, signal) {
      return await withChatIdbTimeout(
        "artifacts:readRecent",
        async (operationSignal) => {
          return await readRecentItems(
            storeName,
            getDb,
            filter,
            operationSignal,
          );
        },
        signal,
      );
    },

    async readLastSyncedAt(signal) {
      return await chatIdbReadOr(
        "artifacts:readLastSyncedAt",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const raw = await db.get(ARTIFACT_SYNC_STORE, ARTIFACT_SYNC_STATE_ID);
          return raw === undefined ? null : storedLastSyncedAt(raw);
        },
        null,
        signal,
      );
    },
  };
}

function createWriteStore(
  storeName: string,
  getDb: GetDb,
): ArtifactItemWriteStore {
  return {
    async beginFullSync(signal) {
      await withChatIdbTimeout(
        "artifacts:beginFullSync",
        async (operationSignal) => {
          const db = await getDb();
          operationSignal.throwIfAborted();
          const tx = db.transaction(
            [storeName, ARTIFACT_SYNC_STORE],
            "readwrite",
          );
          await runAbortableTransaction(
            tx,
            async () => {
              await tx.objectStore(ARTIFACT_SYNC_STORE).clear();
              await tx.objectStore(storeName).clear();
            },
            operationSignal,
          );
        },
        signal,
      );
    },

    async upsertItems(items, signal) {
      if (items.length === 0) {
        return;
      }

      await withChatIdbTimeout(
        "artifacts:upsertItems",
        async (operationSignal) => {
          const db = await getDb();
          operationSignal.throwIfAborted();
          const tx = db.transaction(storeName, "readwrite");
          await runAbortableTransaction(
            tx,
            async () => {
              for (const item of items) {
                operationSignal.throwIfAborted();
                await tx.store.put(storedArtifactItem(item));
              }
            },
            operationSignal,
          );
          L.debug("artifacts:upsertItems:done", { count: items.length });
        },
        signal,
      );
    },

    async finishSync(lastSyncedAt, signal) {
      await withChatIdbTimeout(
        "artifacts:finishSync",
        async (operationSignal) => {
          const db = await getDb();
          operationSignal.throwIfAborted();
          const tx = db.transaction(ARTIFACT_SYNC_STORE, "readwrite");
          await runAbortableTransaction(
            tx,
            async () => {
              await tx.store.put({
                id: ARTIFACT_SYNC_STATE_ID,
                lastSyncedAt,
              });
            },
            operationSignal,
          );
        },
        signal,
      );
    },
  };
}

export function createArtifactItemCacheStores(
  getDb: GetDb,
): ArtifactItemStores {
  return Object.freeze({
    readStore: createReadStore(ARTIFACT_ITEMS_STORE, getDb),
    writeStore: createWriteStore(ARTIFACT_ITEMS_STORE, getDb),
  });
}
