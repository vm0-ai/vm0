import type { DBSchema, IDBPDatabase, OpenDBCallbacks, openDB } from "idb";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { CHAT_IDB_VERSION, CHAT_MESSAGES_STORE } from "./chat-idb-schema.ts";
import { createChatIdbOpener } from "./chat-idb-store.ts";

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

function setupSubject(dbs: readonly FakeDb[]) {
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

  const openDatabaseMock = vi.fn(openDbImplementation);
  const openDatabase = openDatabaseMock as unknown as typeof openDB;
  const reload = vi.fn(() => {
    return undefined;
  });
  const subject = createChatIdbOpener({ openDatabase, reload });
  return { calls, reload, subject };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openChatIdb", () => {
  it("opens the database scoped to the user and organization", async () => {
    const db = fakeDb();
    const { calls, subject } = setupSubject([db]);

    await expect(subject.openChatIdb("user_1", "org_1")).resolves.toBe(db.db);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("vm0-chat-user_1-org_1");
  });

  it("does not cache connections outside the ccstate computed", async () => {
    const firstDb = fakeDb();
    const secondDb = fakeDb();
    const { calls, subject } = setupSubject([firstDb, secondDb]);

    const first = subject.openChatIdb("user_1", "org_1");
    const second = subject.openChatIdb("user_1", "org_1");

    expect(first).not.toBe(second);
    await expect(first).resolves.toBe(firstDb.db);
    await expect(second).resolves.toBe(secondDb.db);
    expect(
      calls.map((call) => {
        return call.name;
      }),
    ).toEqual(["vm0-chat-user_1-org_1", "vm0-chat-user_1-org_1"]);
    expect(firstDb.close).not.toHaveBeenCalled();
    expect(secondDb.close).not.toHaveBeenCalled();
  });

  it("registers the shared upgrade callback", async () => {
    const db = fakeDb();
    const { calls, subject } = setupSubject([db]);

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
  });

  it("closes the connection and reloads after a version change", async () => {
    const db = fakeDb();
    const { reload, subject } = setupSubject([db]);

    await subject.openChatIdb("user_1", "org_1");

    expect(db.versionChangeListeners).toHaveLength(1);
    db.versionChangeListeners[0]?.(
      versionChangeEvent(CHAT_IDB_VERSION, CHAT_IDB_VERSION + 1),
    );

    expect(db.close).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not close or reload when this open request is blocked", async () => {
    const db = fakeDb();
    const { calls, reload, subject } = setupSubject([db]);

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
