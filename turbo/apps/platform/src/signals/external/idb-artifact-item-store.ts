import type { IDBPDatabase } from "idb";
import {
  artifactItemSchema,
  type ArtifactItem,
} from "@vm0/api-contracts/contracts/chat-threads";
import { logger } from "../log.ts";
import {
  ARTIFACT_ITEMS_AGENT_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_AGENT_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_RUN_FILE_INDEX,
  ARTIFACT_ITEMS_STORE,
  ARTIFACT_ITEMS_THREAD_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_URL_INDEX,
} from "./chat-idb-schema.ts";
import {
  chatIdbReadOr,
  chatIdbWriteBestEffort,
  disabledChatIdbError,
  logChatIdbDisabled,
  withChatIdbTimeout,
} from "./chat-idb-safe.ts";
import { openChatIdb } from "./chat-idb-store.ts";
import { onRejection } from "../utils.ts";

const L = logger("ChatIdbCache");
const DEFAULT_ARTIFACT_ITEM_LIMIT = 50;

type ArtifactItemKind = ArtifactItem["artifactKind"];

type StoredArtifactItem = ArtifactItem & {
  readonly searchText: string;
};

export interface ArtifactItemCacheFilter {
  readonly agentId?: string;
  readonly artifactKind?: ArtifactItemKind;
  readonly threadId?: string;
  readonly query?: string;
  readonly limit?: number;
}

export interface ArtifactItemReadStore {
  readRecent(
    filter?: ArtifactItemCacheFilter,
    signal?: AbortSignal,
  ): Promise<ArtifactItem[]>;
  readByRunFile(
    runId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactItem | null>;
  readByUrl(url: string, signal?: AbortSignal): Promise<ArtifactItem | null>;
}

export interface ArtifactItemWriteStore {
  upsertItems(
    items: readonly ArtifactItem[],
    signal?: AbortSignal,
  ): Promise<void>;
  deleteItems(
    artifactItemIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<void>;
  clear(signal?: AbortSignal): Promise<void>;
}

export interface ArtifactItemStores {
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

function normalizedSearchTokens(query: string | undefined): readonly string[] {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  return normalized.split(/\s+/).filter((token) => {
    return token.length > 0;
  });
}

function artifactSearchText(item: ArtifactItem): string {
  return [item.filename, item.contentType, item.artifactKind ?? ""]
    .join("\n")
    .toLowerCase();
}

function storedArtifactItem(item: ArtifactItem): StoredArtifactItem {
  return {
    ...item,
    searchText: artifactSearchText(item),
  };
}

function storedSearchText(raw: unknown, item: ArtifactItem): string {
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof (raw as { searchText?: unknown }).searchText === "string"
  ) {
    return (raw as { searchText: string }).searchText;
  }
  return artifactSearchText(item);
}

function validateStoredArtifactItem(raw: unknown): ValidatedStoredArtifactItem {
  const item = artifactItemSchema.parse(raw);
  return {
    item,
    searchText: storedSearchText(raw, item),
  };
}

function prefixRange(prefix: IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound(prefix, [...prefix, []]);
}

function indexedReadPlan(filter: ArtifactItemCacheFilter): IndexedReadPlan {
  if (filter.threadId) {
    return {
      indexName: ARTIFACT_ITEMS_THREAD_CREATED_AT_INDEX,
      range: prefixRange([filter.threadId]),
    };
  }
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
  if (filter.threadId && item.threadId !== filter.threadId) {
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

    async readByUrl(url, signal) {
      return await chatIdbReadOr(
        "artifacts:readByUrl",
        async () => {
          const db = await getDb();
          signal?.throwIfAborted();
          const tx = db.transaction(storeName, "readonly");
          const raw = await tx.store.index(ARTIFACT_ITEMS_URL_INDEX).get(url);
          return raw === undefined
            ? null
            : validateStoredArtifactItem(raw).item;
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

export function createIdbArtifactItemStores(
  userId: string,
  orgId: string,
): ArtifactItemStores {
  const dbName = `vm0-chat-${userId}-${orgId}`;

  let dbPromise: Promise<IDBPDatabase> | null = null;
  let disabled = false;

  function disableForSession(reason: unknown): void {
    if (disabled) {
      return;
    }
    disabled = true;
    logChatIdbDisabled(dbName, reason);
  }

  async function getDb(): Promise<IDBPDatabase> {
    if (disabled) {
      throw disabledChatIdbError(dbName);
    }

    if (!dbPromise) {
      L.debug("openDB", { dbName, storeName: ARTIFACT_ITEMS_STORE });
      dbPromise = openChatIdb(userId, orgId);
    }

    const pending = dbPromise;
    return await onRejection(
      withChatIdbTimeout("artifacts:openDB", () => {
        return pending;
      }),
      (error) => {
        if (dbPromise === pending) {
          dbPromise = null;
        }
        disableForSession(error);
      },
    );
  }

  return createArtifactItemCacheStores(getDb);
}
