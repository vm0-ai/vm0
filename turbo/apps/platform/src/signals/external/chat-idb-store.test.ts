import type { DBSchema, IDBPDatabase, OpenDBCallbacks } from "idb";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CHAT_IDB_VERSION,
  CHAT_MESSAGES_STORE,
  CHAT_THREAD_META_STORE,
} from "./chat-idb-schema.ts";

vi.mock("idb", () => {
  return {
    openDB: vi.fn(),
  };
});

type VersionChangeListener = (event: IDBVersionChangeEvent) => void;

interface FakeDb {
  readonly db: IDBPDatabase;
  readonly close: Mock<() => void>;
  readonly versionChangeListeners: VersionChangeListener[];
}

interface OpenCall {
  readonly name: string;
  readonly version: number | undefined;
  readonly callbacks: OpenDBCallbacks<unknown> | undefined;
}

interface FakeSchemaDb {
  readonly db: IDBPDatabase;
  readonly createObjectStore: Mock<
    (name: string, options?: IDBObjectStoreParameters) => { createIndex: Mock }
  >;
}

function versionChangeEvent(
  oldVersion: number,
  newVersion: number | null,
): IDBVersionChangeEvent {
  return { oldVersion, newVersion } as IDBVersionChangeEvent;
}

function fakeDb(): FakeDb {
  const versionChangeListeners: VersionChangeListener[] = [];
  const close = vi.fn();
  const addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "versionchange") {
        return;
      }
      if (typeof listener === "function") {
        versionChangeListeners.push(listener as VersionChangeListener);
        return;
      }
      versionChangeListeners.push((event) => {
        listener.handleEvent(event);
      });
    },
  );
  return {
    db: {
      addEventListener,
      close,
    } as unknown as IDBPDatabase,
    close,
    versionChangeListeners,
  };
}

function fakeSchemaDb(): FakeSchemaDb {
  const stores = new Set<string>();
  const createObjectStore = vi.fn(
    (name: string, _options?: IDBObjectStoreParameters) => {
      stores.add(name);
      return { createIndex: vi.fn() };
    },
  );
  return {
    db: {
      objectStoreNames: {
        contains: (name: string) => {
          return stores.has(name);
        },
      },
      createObjectStore,
      deleteObjectStore: vi.fn((name: string) => {
        stores.delete(name);
      }),
    } as unknown as IDBPDatabase,
    createObjectStore,
  };
}

async function setupSubject(dbs: readonly FakeDb[]) {
  vi.resetModules();
  const idb = await import("idb");
  const openDB = vi.mocked(idb.openDB);
  const calls: OpenCall[] = [];
  const dbQueue = [...dbs];

  function openDbImplementation<DBTypes extends DBSchema | unknown = unknown>(
    name: string,
    version?: number,
    callbacks?: OpenDBCallbacks<DBTypes>,
  ): Promise<IDBPDatabase<DBTypes>> {
    const next = dbQueue.shift();
    if (next === undefined) {
      throw new Error("unexpected openDB call");
    }
    calls.push({
      name,
      version,
      callbacks: callbacks as OpenDBCallbacks<unknown> | undefined,
    });
    return Promise.resolve(next.db as IDBPDatabase<DBTypes>);
  }

  openDB.mockImplementation(openDbImplementation);
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {
    return undefined;
  });
  const subject = await import("./chat-idb-store.ts");
  return { calls, openDB, reload, subject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openChatIdb", () => {
  it("reuses the same open promise for the same user and org", async () => {
    const db = fakeDb();
    const { calls, subject } = await setupSubject([db]);

    const first = subject.openChatIdb("user_1", "org_1");
    const second = subject.openChatIdb("user_1", "org_1");

    expect(first).toBe(second);
    await expect(first).resolves.toBe(db.db);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("vm0-chat-user_1-org_1");
  });

  it("uses separate open promises for different chat databases", async () => {
    const firstDb = fakeDb();
    const secondDb = fakeDb();
    const { calls, subject } = await setupSubject([firstDb, secondDb]);

    const first = subject.openChatIdb("user_1", "org_1");
    const second = subject.openChatIdb("user_1", "org_2");

    expect(first).not.toBe(second);
    await expect(first).resolves.toBe(firstDb.db);
    await expect(second).resolves.toBe(secondDb.db);
    expect(
      calls.map((call) => {
        return call.name;
      }),
    ).toEqual(["vm0-chat-user_1-org_1", "vm0-chat-user_1-org_2"]);
  });

  it("registers the shared upgrade callback", async () => {
    const db = fakeDb();
    const { calls, subject } = await setupSubject([db]);

    await subject.openChatIdb("user_1", "org_1");

    expect(calls[0]?.version).toBe(CHAT_IDB_VERSION);
    const upgrade = calls[0]?.callbacks?.upgrade;
    expect(upgrade).toBeTypeOf("function");
    if (upgrade === undefined) {
      throw new Error("missing upgrade callback");
    }

    const schemaDb = fakeSchemaDb();
    type UpgradeCallback = NonNullable<OpenDBCallbacks<unknown>["upgrade"]>;
    const transaction = {} as Parameters<UpgradeCallback>[3];
    upgrade(
      schemaDb.db,
      0,
      CHAT_IDB_VERSION,
      transaction,
      versionChangeEvent(0, CHAT_IDB_VERSION),
    );

    expect(schemaDb.createObjectStore).toHaveBeenCalledWith(
      CHAT_MESSAGES_STORE,
      { keyPath: "id" },
    );
    expect(schemaDb.createObjectStore).toHaveBeenCalledWith(
      CHAT_THREAD_META_STORE,
      { keyPath: "threadId" },
    );
  });

  it("closes, invalidates, reloads once, and prevents stale reopen after version change", async () => {
    const firstDb = fakeDb();
    const { openDB, reload, subject } = await setupSubject([firstDb]);

    await subject.openChatIdb("user_1", "org_1");

    expect(firstDb.versionChangeListeners).toHaveLength(1);
    firstDb.versionChangeListeners[0]?.(
      versionChangeEvent(CHAT_IDB_VERSION, CHAT_IDB_VERSION + 1),
    );
    firstDb.versionChangeListeners[0]?.(
      versionChangeEvent(CHAT_IDB_VERSION, CHAT_IDB_VERSION + 1),
    );

    expect(firstDb.close).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
    await expect(subject.openChatIdb("user_1", "org_1")).rejects.toThrow(
      "Chat IndexedDB is closing for a page reload",
    );
    expect(openDB).toHaveBeenCalledTimes(1);
  });

  it("prevents reusing another cached database after reload is pending", async () => {
    const firstDb = fakeDb();
    const secondDb = fakeDb();
    const { openDB, subject } = await setupSubject([firstDb, secondDb]);

    await subject.openChatIdb("user_1", "org_1");
    await subject.openChatIdb("user_1", "org_2");

    firstDb.versionChangeListeners[0]?.(
      versionChangeEvent(CHAT_IDB_VERSION, CHAT_IDB_VERSION + 1),
    );

    await expect(subject.openChatIdb("user_1", "org_2")).rejects.toThrow(
      "Chat IndexedDB is closing for a page reload",
    );
    expect(openDB).toHaveBeenCalledTimes(2);
  });

  it("does not close or reload when this open request is blocked", async () => {
    const db = fakeDb();
    const { calls, reload, subject } = await setupSubject([db]);

    await subject.openChatIdb("user_1", "org_1");
    calls[0]?.callbacks?.blocked?.(
      CHAT_IDB_VERSION - 1,
      CHAT_IDB_VERSION,
      versionChangeEvent(CHAT_IDB_VERSION - 1, CHAT_IDB_VERSION),
    );

    expect(db.close).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
