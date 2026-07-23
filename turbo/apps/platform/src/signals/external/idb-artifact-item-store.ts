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
  ARTIFACT_ITEMS_AGENT_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_AGENT_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_RUN_FILE_INDEX,
  ARTIFACT_ITEMS_STORE,
  ARTIFACT_SYNC_STORE,
} from "./chat-idb-schema.ts";
import { chatIdbReadOr, chatIdbWriteBestEffort } from "./chat-idb-safe.ts";

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

type ArtifactItemKind = ArtifactItem["artifactKind"];

const storedArtifactItemSchema = artifactItemSchema
  .extend({
    size: artifactItemSchema.shape.size.unwrap(),
    searchText: artifactItemSchema.shape.filename,
  })
  .strict();
type StoredArtifactItem = ArtifactItem & { readonly searchText: string };

interface ArtifactItemCacheFilter {
  readonly agentId?: string;
  readonly artifactCategory?: ArtifactCategory;
  readonly artifactKind?: ArtifactItemKind;
  readonly query?: string;
  readonly limit?: number;
}

interface ArtifactItemReadStore {
  readRecent(
    filter?: ArtifactItemCacheFilter,
    signal?: AbortSignal,
  ): Promise<ArtifactItem[]>;
  readByRunFile(
    runId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactItem | null>;
  readLastSyncedAt(signal?: AbortSignal): Promise<string | null>;
}

interface ArtifactItemWriteStore {
  upsertItems(
    items: readonly ArtifactItem[],
    signal?: AbortSignal,
  ): Promise<void>;
  replaceItems(
    items: readonly ArtifactItem[],
    signal?: AbortSignal,
  ): Promise<boolean>;
  setLastSyncedAt(lastSyncedAt: string, signal?: AbortSignal): Promise<void>;
  deleteItems(
    artifactItemIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
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
  readonly item: ArtifactItem;
  readonly searchText: string;
}

function storedArtifactItem(item: ArtifactItem): StoredArtifactItem {
  const cachedItem: ArtifactItem = artifactItemSchema.parse(item);
  return {
    ...cachedItem,
    searchText: artifactSearchText(cachedItem),
  };
}

function validateStoredArtifactItem(raw: unknown): ValidatedStoredArtifactItem {
  const { searchText, ...item } = storedArtifactItemSchema.parse(raw);
  return {
    item,
    searchText,
  };
}

function prefixRange(prefix: IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound(prefix, [...prefix, []]);
}

function indexedReadPlan(filter: ArtifactItemCacheFilter): IndexedReadPlan {
  if (filter.agentId && filter.artifactKind) {
    return {
      indexName: ARTIFACT_ITEMS_AGENT_KIND_CREATED_AT_INDEX,
      range: prefixRange([filter.agentId, filter.artifactKind]),
    };
  }
  if (filter.agentId) {
    return {
      indexName: ARTIFACT_ITEMS_AGENT_CREATED_AT_INDEX,
      range: prefixRange([filter.agentId]),
    };
  }
  if (filter.artifactKind) {
    return {
      indexName: ARTIFACT_ITEMS_KIND_CREATED_AT_INDEX,
      range: prefixRange([filter.artifactKind]),
    };
  }
  return { indexName: ARTIFACT_ITEMS_CREATED_AT_INDEX };
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
  if (filter.artifactKind && item.artifactKind !== filter.artifactKind) {
    return false;
  }
  if (!artifactMatchesCategory(item, filter.artifactCategory)) {
    return false;
  }
  return queryTokens.every((token) => {
    return stored.searchText.includes(token);
  });
}

function createReadStore(
  storeName: string,
  getDb: GetDb,
): ArtifactItemReadStore {
  return {
    async readRecent(filter, signal) {
      return await chatIdbReadOr(
        "artifacts:readRecent",
        async () => {
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
          const queryTokens = normalizedSearchTokens(effectiveFilter.query);
          const items: ArtifactItem[] = [];
          let cursor = await index.openCursor(plan.range, "prev");
          while (cursor && items.length < limit) {
            signal?.throwIfAborted();
            const stored = validateStoredArtifactItem(cursor.value);
            if (matchesFilter(stored, effectiveFilter, queryTokens)) {
              items.push(stored.item);
            }
            cursor = await cursor.continue();
          }
          L.debug("artifacts:readRecent:done", {
            count: items.length,
            filter: effectiveFilter,
          });
          return items;
        },
        [],
        signal,
      );
    },

    async readByRunFile(runId, fileId, signal) {
      return await chatIdbReadOr(
        "artifacts:readByRunFile",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readonly");
          const raw = await tx.store
            .index(ARTIFACT_ITEMS_RUN_FILE_INDEX)
            .get([runId, fileId]);
          return raw === undefined
            ? null
            : validateStoredArtifactItem(raw).item;
        },
        null,
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
    async upsertItems(items, signal) {
      if (items.length === 0) {
        return;
      }

      await chatIdbWriteBestEffort(
        "artifacts:upsertItems",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readwrite");
          for (const item of items) {
            signal?.throwIfAborted();
            await tx.store.put(storedArtifactItem(item));
          }
          await tx.done;
          L.debug("artifacts:upsertItems:done", { count: items.length });
        },
        signal,
      );
    },

    async replaceItems(items, signal) {
      return await chatIdbWriteBestEffort(
        "artifacts:replaceItems",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readwrite");
          await tx.store.clear();
          for (const item of items) {
            signal?.throwIfAborted();
            await tx.store.put(storedArtifactItem(item));
          }
          await tx.done;
          L.debug("artifacts:replaceItems:done", { count: items.length });
        },
        signal,
      );
    },

    async setLastSyncedAt(lastSyncedAt, signal) {
      await chatIdbWriteBestEffort(
        "artifacts:setLastSyncedAt",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          await db.put(ARTIFACT_SYNC_STORE, {
            id: ARTIFACT_SYNC_STATE_ID,
            lastSyncedAt,
          });
        },
        signal,
      );
    },

    async deleteItems(artifactItemIds, signal) {
      if (artifactItemIds.length === 0) {
        return;
      }

      await chatIdbWriteBestEffort(
        "artifacts:deleteItems",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readwrite");
          for (const artifactItemId of artifactItemIds) {
            signal?.throwIfAborted();
            await tx.store.delete(artifactItemId);
          }
          await tx.done;
        },
        signal,
      );
    },

    async clear(signal) {
      await chatIdbWriteBestEffort(
        "artifacts:clear",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readwrite");
          await tx.store.clear();
          await tx.done;
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
