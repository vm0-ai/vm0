import { deleteDB, openDB, type IDBPDatabase } from "idb";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { setupPage } from "../../__tests__/page-helper.ts";
import { testContext } from "../__tests__/test-helpers.ts";
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
import { chatIdb$ } from "./chat-idb-store.ts";

vi.mock("idb", async () => {
  return await vi.importActual<typeof import("idb")>("idb-real");
});

const context = testContext();

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
      await setupPage({
        context,
        path: "/error",
        withoutRender: true,
        user: { id: userId, fullName: "Chat IDB Schema User" },
        session: { token: "test-token" },
        org: {
          activeOrg: { id: orgId, name: "Chat IDB Schema Org" },
          memberships: [{ id: orgId }],
        },
      });
      const db = await context.store.get(chatIdb$);
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

describe("Chat IndexedDB production bootstrap", () => {
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
});
