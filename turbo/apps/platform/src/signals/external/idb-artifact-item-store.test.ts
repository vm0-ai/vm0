import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactItem } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ARTIFACT_ITEMS_AGENT_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_AGENT_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_KIND_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_RUN_FILE_INDEX,
  ARTIFACT_ITEMS_THREAD_CREATED_AT_INDEX,
  ARTIFACT_ITEMS_URL_INDEX,
} from "./chat-idb-schema.ts";
import { createArtifactItemCacheStores } from "./idb-artifact-item-store.ts";

interface FakeCursor {
  readonly value: unknown;
  continue(): Promise<FakeCursor | null>;
}

interface FakeIndex {
  openCursor(
    range?: IDBKeyRange,
    direction?: IDBCursorDirection,
  ): Promise<FakeCursor | null>;
  get(key: IDBValidKey): Promise<unknown | undefined>;
}

interface FakeStore {
  put(value: unknown): Promise<void>;
  delete(key: IDBValidKey): Promise<void>;
  clear(): Promise<void>;
  get(key: IDBValidKey): Promise<unknown | undefined>;
  index(indexName: string): FakeIndex;
}

interface FakeTransaction {
  readonly store: FakeStore;
  readonly done: Promise<void>;
}

interface IndexedRow {
  readonly key: IDBValidKey;
  readonly value: ArtifactItem;
}

class MemoryCursor implements FakeCursor {
  private position = 0;

  constructor(private readonly values: readonly ArtifactItem[]) {}

  get value(): unknown {
    return this.values[this.position];
  }

  continue(): Promise<FakeCursor | null> {
    this.position += 1;
    return Promise.resolve(this.position < this.values.length ? this : null);
  }
}

function compareIdbKeys(left: IDBValidKey, right: IDBValidKey): number {
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const comparison = compareIdbKeys(left[index]!, right[index]!);
      if (comparison !== 0) {
        return comparison;
      }
    }
    return left.length - right.length;
  }

  if (Array.isArray(left)) {
    return 1;
  }
  if (Array.isArray(right)) {
    return -1;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
  }
  return 0;
}

function keyMatchesRange(
  range: IDBKeyRange | undefined,
  key: IDBValidKey,
): boolean {
  return range === undefined || range.includes(key);
}

function indexKey(indexName: string, item: ArtifactItem): IDBValidKey | null {
  switch (indexName) {
    case ARTIFACT_ITEMS_CREATED_AT_INDEX: {
      return [item.createdAt, item.artifactItemId];
    }
    case ARTIFACT_ITEMS_AGENT_CREATED_AT_INDEX: {
      return [item.agentId, item.createdAt, item.artifactItemId];
    }
    case ARTIFACT_ITEMS_KIND_CREATED_AT_INDEX: {
      return item.artifactKind
        ? [item.artifactKind, item.createdAt, item.artifactItemId]
        : null;
    }
    case ARTIFACT_ITEMS_AGENT_KIND_CREATED_AT_INDEX: {
      return item.artifactKind
        ? [item.agentId, item.artifactKind, item.createdAt, item.artifactItemId]
        : null;
    }
    case ARTIFACT_ITEMS_THREAD_CREATED_AT_INDEX: {
      return [item.threadId, item.createdAt, item.artifactItemId];
    }
    case ARTIFACT_ITEMS_RUN_FILE_INDEX: {
      return [item.runId, item.fileId];
    }
    case ARTIFACT_ITEMS_URL_INDEX: {
      return item.url;
    }
    default: {
      throw new Error(`Unexpected index: ${indexName}`);
    }
  }
}

class MemoryArtifactDb {
  private readonly rows = new Map<string, ArtifactItem>();

  get db(): IDBPDatabase {
    return {
      transaction: () => {
        return {
          store: this.store(),
          done: Promise.resolve(),
        } satisfies FakeTransaction;
      },
    } as unknown as IDBPDatabase;
  }

  private store(): FakeStore {
    return {
      put: (value) => {
        const item = value as ArtifactItem;
        this.rows.set(item.artifactItemId, item);
        return Promise.resolve();
      },
      delete: (key) => {
        if (typeof key === "string") {
          this.rows.delete(key);
        }
        return Promise.resolve();
      },
      clear: () => {
        this.rows.clear();
        return Promise.resolve();
      },
      get: (key) => {
        return Promise.resolve(
          typeof key === "string" ? this.rows.get(key) : undefined,
        );
      },
      index: (indexName) => {
        return this.index(indexName);
      },
    };
  }

  private index(indexName: string): FakeIndex {
    return {
      openCursor: (range, direction) => {
        const indexedRows = this.indexedRows(indexName).filter((row) => {
          return keyMatchesRange(range, row.key);
        });
        indexedRows.sort((left, right) => {
          return compareIdbKeys(left.key, right.key);
        });
        if (direction === "prev" || direction === "prevunique") {
          indexedRows.reverse();
        }
        if (indexedRows.length === 0) {
          return Promise.resolve(null);
        }
        return Promise.resolve(
          new MemoryCursor(
            indexedRows.map((row) => {
              return row.value;
            }),
          ),
        );
      },
      get: (key) => {
        return Promise.resolve(
          this.indexedRows(indexName).find((row) => {
            return compareIdbKeys(row.key, key) === 0;
          })?.value,
        );
      },
    };
  }

  private indexedRows(indexName: string): IndexedRow[] {
    return Array.from(this.rows.values()).flatMap((item) => {
      const key = indexKey(indexName, item);
      return key === null ? [] : [{ key, value: item }];
    });
  }
}

function artifact(
  index: number,
  overrides: Partial<ArtifactItem> = {},
): ArtifactItem {
  return {
    artifactItemId: `run-${index}:file-${index}`,
    threadId: "thread-1",
    runId: `run-${index}`,
    fileId: `file-${index}`,
    agentId: "agent-1",
    filename: `artifact-${index}.html`,
    contentType: "text/html",
    size: index,
    url: `https://cdn.vm0.test/artifact-${index}.html`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    artifactKind: "hosted-site",
    ...overrides,
  };
}

function artifactIds(items: readonly ArtifactItem[]): string[] {
  return items.map((item) => {
    return item.artifactItemId;
  });
}

function setupStores(db = new MemoryArtifactDb()) {
  return {
    db,
    stores: createArtifactItemCacheStores(() => {
      return Promise.resolve(db.db);
    }),
  };
}

describe("artifact item IndexedDB cache reads", () => {
  it("reads recent cached artifact items newest first", async () => {
    const { stores } = setupStores();
    const first = artifact(1);
    const second = artifact(2);

    await stores.writeStore.upsertItems([first, second]);

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([
      second,
      first,
    ]);
  });

  it("upserts idempotently and replaces stale metadata", async () => {
    const { stores } = setupStores();
    const original = artifact(1, { filename: "old.html" });
    const refreshed = artifact(1, {
      filename: "fresh.html",
      googleDriveSync: {
        status: "synced",
        id: "drive-1",
        name: "fresh.html",
        webViewLink: null,
      },
    });

    await stores.writeStore.upsertItems([original]);
    await stores.writeStore.upsertItems([original, refreshed]);

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([
      refreshed,
    ]);
    await expect(
      stores.readStore.readByRunFile(refreshed.runId, refreshed.fileId),
    ).resolves.toStrictEqual(refreshed);
  });

  it("reads by agent, artifact kind, and their compound index", async () => {
    const { stores } = setupStores();
    const hostedFirst = artifact(1, {
      agentId: "agent-a",
      artifactKind: "hosted-site",
    });
    const presentation = artifact(2, {
      agentId: "agent-a",
      artifactKind: "presentation-html",
    });
    const hostedSecond = artifact(3, {
      agentId: "agent-b",
      artifactKind: "hosted-site",
    });

    await stores.writeStore.upsertItems([
      hostedFirst,
      presentation,
      hostedSecond,
    ]);

    await expect(
      stores.readStore.readRecent({ agentId: "agent-a" }),
    ).resolves.toStrictEqual([presentation, hostedFirst]);
    await expect(
      stores.readStore.readRecent({ artifactKind: "hosted-site" }),
    ).resolves.toStrictEqual([hostedSecond, hostedFirst]);
    await expect(
      stores.readStore.readRecent({
        agentId: "agent-a",
        artifactKind: "presentation-html",
      }),
    ).resolves.toStrictEqual([presentation]);
  });

  it("reads by thread and applies lightweight cached search text", async () => {
    const { stores } = setupStores();
    const threadMatch = artifact(1, {
      threadId: "thread-a",
      filename: "Quarterly Plan.html",
    });
    const threadMiss = artifact(2, {
      threadId: "thread-a",
      filename: "Map Demo.html",
    });
    const otherThread = artifact(3, {
      threadId: "thread-b",
      filename: "Quarterly Plan Copy.html",
    });

    await stores.writeStore.upsertItems([threadMatch, threadMiss, otherThread]);

    await expect(
      stores.readStore.readRecent({ threadId: "thread-a", query: "quarterly" }),
    ).resolves.toStrictEqual([threadMatch]);
  });

  it("reads by run/file and url indexes", async () => {
    const { stores } = setupStores();
    const item = artifact(1);

    await stores.writeStore.upsertItems([item]);

    await expect(
      stores.readStore.readByRunFile(item.runId, item.fileId),
    ).resolves.toStrictEqual(item);
    await expect(stores.readStore.readByUrl(item.url)).resolves.toStrictEqual(
      item,
    );
  });
});

describe("artifact item IndexedDB cache writes and failures", () => {
  it("deletes selected artifacts and clears the cache", async () => {
    const { stores } = setupStores();
    const first = artifact(1);
    const second = artifact(2);

    await stores.writeStore.upsertItems([first, second]);
    await stores.writeStore.deleteItems([first.artifactItemId]);

    expect(artifactIds(await stores.readStore.readRecent())).toStrictEqual([
      second.artifactItemId,
    ]);

    await stores.writeStore.clear();

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([]);
  });

  it("falls back to cache miss values when IndexedDB reads fail", async () => {
    const stores = createArtifactItemCacheStores(() => {
      return Promise.reject(new Error("open failed"));
    });

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([]);
    await expect(
      stores.readStore.readByUrl("https://example.test"),
    ).resolves.toBe(null);
  });

  it("ignores best-effort write failures", async () => {
    const stores = createArtifactItemCacheStores(() => {
      return Promise.reject(new Error("open failed"));
    });
    const item = artifact(1);

    await expect(
      stores.writeStore.upsertItems([item]),
    ).resolves.toBeUndefined();
    await expect(
      stores.writeStore.deleteItems([item.artifactItemId]),
    ).resolves.toBeUndefined();
    await expect(stores.writeStore.clear()).resolves.toBeUndefined();
  });

  it("does not open IndexedDB for empty writes", async () => {
    const getDb = vi.fn(() => {
      return Promise.reject(new Error("should not open"));
    });
    const stores = createArtifactItemCacheStores(getDb);

    await stores.writeStore.upsertItems([]);
    await stores.writeStore.deleteItems([]);

    expect(getDb).not.toHaveBeenCalled();
  });
});
