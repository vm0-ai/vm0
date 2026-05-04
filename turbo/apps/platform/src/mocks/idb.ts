/**
 * Mock idb library for tests.
 *
 * Returns a fake IDBDatabase whose object stores always return empty/undefined
 * reads (cache miss), so the IDB-cached chat data source falls through to the
 * remote (MSW-mocked) path. Real IDB behavior is tested in browser tests
 * (.btest.ts) against a real Chromium browser with fake-indexeddb.
 */

function fakeIndex() {
  return {
    openCursor: () => Promise.resolve(null),
  };
}

function fakeStore() {
  return {
    get: () => Promise.resolve(undefined),
    index: () => fakeIndex(),
    put: () => Promise.resolve(),
  };
}

function fakeTransaction() {
  return {
    get store() {
      return fakeStore();
    },
    objectStore() {
      return fakeStore();
    },
    done: Promise.resolve(),
  };
}

export function openDB(): Promise<Record<string, unknown>> {
  return Promise.resolve({
    objectStoreNames: {
      contains: () => false,
    },
    transaction: () => fakeTransaction(),
    // Direct get/put on the database (used by idb-thread-agent-store)
    get: () => Promise.resolve(undefined),
    put: () => Promise.resolve(),
  });
}
