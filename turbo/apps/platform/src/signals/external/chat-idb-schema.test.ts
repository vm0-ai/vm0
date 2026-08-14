import { deleteDB, openDB, type IDBPDatabase } from "idb";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import {
  CHAT_EVENT_CURSOR_STORE,
  CHAT_EVENT_ROWS_ORDER_INDEX,
  CHAT_EVENT_ROWS_STORE,
  CHAT_IDB_VERSION,
  CHAT_THREAD_EVENTS_ORDER_INDEX,
  CHAT_THREAD_EVENTS_STORE,
  CHAT_THREAD_EVENT_SYNC_STORE,
  CHAT_THREAD_SNAPSHOT_STORE,
} from "./chat-idb-schema.ts";
import { createChatIdbOpener } from "./chat-idb-store.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

function testDatabase() {
  const suffix = crypto.randomUUID();
  const userId = `schema-user-${suffix}`;
  const orgId = `schema-org-${suffix}`;
  const databaseName = `vm0-chat-${userId}-${orgId}`;
  const openedDatabases: IDBPDatabase[] = [];
  onTestFinished(async () => {
    for (const db of openedDatabases) {
      db.close();
    }
    await deleteDB(databaseName);
  });
  return {
    databaseName,
    async openProduction() {
      const opener = createChatIdbOpener({
        reload: () => {
          return undefined;
        },
      });
      const db = await opener.openChatIdb(userId, orgId);
      openedDatabases.push(db);
      return db;
    },
  };
}

function currentStoreNames(): string[] {
  return [
    CHAT_EVENT_CURSOR_STORE,
    CHAT_EVENT_ROWS_STORE,
    CHAT_THREAD_EVENTS_STORE,
    CHAT_THREAD_EVENT_SYNC_STORE,
    CHAT_THREAD_SNAPSHOT_STORE,
  ].sort();
}

describe("Chat IndexedDB schema bootstrap", () => {
  it("opens a new database at the current version with every production store", async () => {
    const database = testDatabase();

    const db = await database.openProduction();

    expect(db.version).toBe(CHAT_IDB_VERSION);
    expect(Array.from(db.objectStoreNames).sort()).toStrictEqual(
      currentStoreNames(),
    );

    const rowsTransaction = db.transaction(CHAT_EVENT_ROWS_STORE);
    const rowsIndex = rowsTransaction.store.index(CHAT_EVENT_ROWS_ORDER_INDEX);
    expect(rowsIndex.keyPath).toStrictEqual(["chatThreadId", "seqId"]);
    expect(rowsIndex.unique).toBe(true);
    await rowsTransaction.done;

    const threadEventsTransaction = db.transaction(CHAT_THREAD_EVENTS_STORE);
    const threadEventsIndex = threadEventsTransaction.store.index(
      CHAT_THREAD_EVENTS_ORDER_INDEX,
    );
    expect(threadEventsIndex.keyPath).toBe("seqId");
    expect(threadEventsIndex.unique).toBe(true);
    await threadEventsTransaction.done;
  });

  it("deletes an older cache generation through the real version upgrade", async () => {
    const database = testDatabase();
    const previous = await openDB(database.databaseName, CHAT_IDB_VERSION - 1, {
      upgrade(db) {
        db.createObjectStore("retired_cache", { keyPath: "id" });
      },
    });
    previous.close();

    const db = await database.openProduction();

    expect(db.version).toBe(CHAT_IDB_VERSION);
    expect(Array.from(db.objectStoreNames).sort()).toStrictEqual(
      currentStoreNames(),
    );
    expect(db.objectStoreNames.contains("retired_cache")).toBe(false);
  });

  it("preserves current-version data when the production opener reconnects", async () => {
    const database = testDatabase();
    const first = await database.openProduction();
    await first.put(CHAT_THREAD_SNAPSHOT_STORE, {
      id: "retained-snapshot",
      marker: "keep",
    });
    first.close();

    const second = await database.openProduction();

    await expect(
      second.get(CHAT_THREAD_SNAPSHOT_STORE, "retained-snapshot"),
    ).resolves.toStrictEqual({ id: "retained-snapshot", marker: "keep" });
  });
});
