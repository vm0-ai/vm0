import type { IDBPDatabase } from "idb";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactItem } from "@vm0/api-contracts/contracts/chat-threads";
import {
  ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX,
  ARTIFACT_ITEMS_RUN_HOSTED_INDEX,
  ARTIFACT_ITEMS_UPDATED_AT_INDEX,
  ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX,
  ARTIFACT_SYNC_STORE,
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
  get(key: IDBValidKey): Promise<unknown>;
}

interface FakeStore {
  put(value: unknown): Promise<void>;
  delete(key: IDBValidKey): Promise<void>;
  clear(): Promise<void>;
  get(key: IDBValidKey): Promise<unknown>;
  index(indexName: string): FakeIndex;
}

interface FakeTransaction {
  abort(): void;
  readonly store: FakeStore;
  readonly done: Promise<void>;
  objectStore(storeName: string): FakeStore;
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
    case ARTIFACT_ITEMS_UPDATED_AT_INDEX: {
      return [item.updatedAt, item.createdAt, item.artifactItemId];
    }
    case ARTIFACT_ITEMS_AGENT_UPDATED_AT_INDEX: {
      return [
        item.agentId,
        item.updatedAt,
        item.createdAt,
        item.artifactItemId,
      ];
    }
    case ARTIFACT_ITEMS_RUN_HOSTED_INDEX: {
      return [
        item.runId,
        item.artifactKind === "hosted-site" ||
        item.artifactKind === "presentation-html"
          ? 1
          : 0,
      ];
    }
    case ARTIFACT_ITEMS_URL_UPDATED_AT_INDEX: {
      return [item.url, item.updatedAt, item.createdAt, item.artifactItemId];
    }
    default: {
      throw new Error(`Unexpected index: ${indexName}`);
    }
  }
}

class MemoryArtifactDb {
  private readonly rows = new Map<string, ArtifactItem>();
  private syncState: unknown;

  get db(): IDBPDatabase {
    return {
      transaction: (storeNames: string | string[]) => {
        const storeName = Array.isArray(storeNames)
          ? (storeNames[0] ?? "")
          : storeNames;
        return {
          abort: () => {
            return undefined;
          },
          store:
            storeName === ARTIFACT_SYNC_STORE
              ? this.syncStateStore()
              : this.store(),
          done: Promise.resolve(),
          objectStore: (name: string) => {
            return name === ARTIFACT_SYNC_STORE
              ? this.syncStateStore()
              : this.store();
          },
        } satisfies FakeTransaction;
      },
      get: (storeName: string) => {
        return Promise.resolve(
          storeName === ARTIFACT_SYNC_STORE ? this.syncState : undefined,
        );
      },
      put: (storeName: string, value: unknown) => {
        if (storeName === ARTIFACT_SYNC_STORE) {
          this.syncState = value;
        }
        return Promise.resolve();
      },
    } as unknown as IDBPDatabase;
  }

  private syncStateStore(): FakeStore {
    return {
      put: (value) => {
        this.syncState = value;
        return Promise.resolve();
      },
      delete: () => {
        this.syncState = undefined;
        return Promise.resolve();
      },
      clear: () => {
        this.syncState = undefined;
        return Promise.resolve();
      },
      get: () => {
        return Promise.resolve(this.syncState);
      },
      index: () => {
        throw new Error("Sync state store has no indexes");
      },
    };
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
    size: 1024 + index,
    url: `https://cdn.vm0.test/artifact-${index}.html`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    artifactKind: "hosted-site",
    ...overrides,
  };
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
  it("reads recently updated cached artifact items newest first", async () => {
    const { stores } = setupStores();
    const first = artifact(1, {
      createdAt: "2026-01-03T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const second = artifact(2, {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    await stores.writeStore.upsertItems([first, second]);

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([
      second,
      first,
    ]);
  });

  it("stops after the requested recent-item window", async () => {
    const { stores } = setupStores();
    const items = Array.from({ length: 61 }, (_, index) => {
      return artifact(index + 1, {
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, -index)).toISOString(),
      });
    });

    await stores.writeStore.upsertItems(items);

    const recent = await stores.readStore.readRecent({ limit: 60 });
    expect(recent).toHaveLength(60);
    expect(recent[0]).toStrictEqual(items[60]);
    expect(recent[59]).toStrictEqual(items[1]);
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
  });

  it("selects URL winners and hosted runs while reading", async () => {
    const { stores } = setupStores();
    const sharedUrl = "https://cdn.vm0.test/shared.html";
    const older = artifact(1, {
      artifactKind: undefined,
      url: sharedUrl,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = artifact(2, {
      url: sharedUrl,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const rawRunFile = artifact(3, {
      artifactKind: undefined,
      runId: "hosted-run",
    });
    const hostedRun = artifact(4, {
      runId: "hosted-run",
    });

    await stores.writeStore.upsertItems([older, rawRunFile]);
    await stores.writeStore.upsertItems([newer, hostedRun]);

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([
      newer,
      hostedRun,
    ]);
  });

  it("selects URL winners after hiding raw files from hosted runs", async () => {
    const { stores } = setupStores();
    const sharedUrl = "https://cdn.vm0.test/shared.html";
    const visibleOlder = artifact(1, {
      artifactKind: undefined,
      runId: "visible-run",
      url: sharedUrl,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const hiddenNewer = artifact(2, {
      artifactKind: undefined,
      runId: "hosted-run",
      url: sharedUrl,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const hostedRun = artifact(3, {
      runId: "hosted-run",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    await stores.writeStore.upsertItems([visibleOlder, hiddenNewer, hostedRun]);

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([
      hostedRun,
      visibleOlder,
    ]);
  });
});

describe("artifact item IndexedDB cache filters and sync marker", () => {
  it("reads by agent and artifact category", async () => {
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
      stores.readStore.readRecent({ artifactCategory: "website" }),
    ).resolves.toStrictEqual([hostedSecond, hostedFirst]);
    await expect(
      stores.readStore.readRecent({
        agentId: "agent-a",
        artifactCategory: "presentation",
      }),
    ).resolves.toStrictEqual([presentation]);
  });

  it("applies lightweight cached search text", async () => {
    const { stores } = setupStores();
    const queryMatch = artifact(1, {
      filename: "Quarterly Plan.html",
    });
    const queryMiss = artifact(2, {
      filename: "Map Demo.html",
    });

    await stores.writeStore.upsertItems([queryMatch, queryMiss]);

    await expect(
      stores.readStore.readRecent({ query: "quarterly" }),
    ).resolves.toStrictEqual([queryMatch]);
  });

  it("reads and writes the last artifact synchronization timestamp", async () => {
    const { stores } = setupStores();
    const lastSyncedAt = "2026-07-20T04:00:00.000Z";

    await expect(stores.readStore.readLastSyncedAt()).resolves.toBe(null);
    await stores.writeStore.finishSync(lastSyncedAt);
    await expect(stores.readStore.readLastSyncedAt()).resolves.toBe(
      lastSyncedAt,
    );
  });
});

describe("artifact item IndexedDB cache writes and failures", () => {
  it("atomically begins a full synchronization", async () => {
    const { stores } = setupStores();
    await stores.writeStore.upsertItems([artifact(1)]);
    await stores.writeStore.finishSync("2026-01-02T00:00:00.000Z");

    await stores.writeStore.beginFullSync();

    await expect(stores.readStore.readRecent()).resolves.toStrictEqual([]);
    await expect(stores.readStore.readLastSyncedAt()).resolves.toBe(null);
  });

  it("rejects strict cache reads", async () => {
    const stores = createArtifactItemCacheStores(() => {
      return Promise.reject(new Error("open failed"));
    });

    await expect(stores.readStore.readRecent()).rejects.toThrow("open failed");
  });

  it("rejects strict cache reads when IndexedDB misses the deadline", async () => {
    const pendingDb = Promise.withResolvers<IDBPDatabase>();
    const stores = createArtifactItemCacheStores(() => {
      return pendingDb.promise;
    });

    await expect(stores.readStore.readRecent()).rejects.toThrow(
      "IndexedDB operation timed out: artifacts:readRecent",
    );
  });

  it("classifies a timeout-aborted transaction as a deadline failure", async () => {
    const pendingCursor = Promise.withResolvers<FakeCursor | null>();
    let transactionAborted = false;
    const index: FakeIndex = {
      openCursor: () => {
        return pendingCursor.promise;
      },
      get: () => {
        return Promise.resolve(undefined);
      },
    };
    const store: FakeStore = {
      put: () => {
        return Promise.resolve();
      },
      delete: () => {
        return Promise.resolve();
      },
      clear: () => {
        return Promise.resolve();
      },
      get: () => {
        return Promise.resolve(undefined);
      },
      index: () => {
        return index;
      },
    };
    const transaction: FakeTransaction = {
      abort: () => {
        transactionAborted = true;
        pendingCursor.reject(
          new DOMException("Transaction aborted", "AbortError"),
        );
      },
      store,
      done: Promise.resolve(),
      objectStore: () => {
        return store;
      },
    };
    const db = {
      transaction: () => {
        return transaction;
      },
    } as unknown as IDBPDatabase;
    const stores = createArtifactItemCacheStores(() => {
      return Promise.resolve(db);
    });

    await expect(stores.readStore.readRecent()).rejects.toThrow(
      "IndexedDB operation timed out: artifacts:readRecent",
    );
    expect(transactionAborted).toBeTruthy();
  });

  it("propagates synchronization write failures", async () => {
    const stores = createArtifactItemCacheStores(() => {
      return Promise.reject(new Error("open failed"));
    });
    const item = artifact(1);

    await expect(stores.writeStore.beginFullSync()).rejects.toThrow(
      "open failed",
    );
    await expect(stores.writeStore.upsertItems([item])).rejects.toThrow(
      "open failed",
    );
    await expect(
      stores.writeStore.finishSync("2026-01-01T00:00:00.000Z"),
    ).rejects.toThrow("open failed");
  });

  it("does not open IndexedDB for empty writes", async () => {
    const getDb = vi.fn(() => {
      return Promise.reject(new Error("should not open"));
    });
    const stores = createArtifactItemCacheStores(getDb);

    await expect(stores.writeStore.upsertItems([])).resolves.toBeUndefined();

    expect(getDb).not.toHaveBeenCalled();
  });
});
