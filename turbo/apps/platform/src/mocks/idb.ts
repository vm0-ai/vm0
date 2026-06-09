/**
 * Mock idb library for tests.
 *
 * Returns a fake IDBDatabase whose object stores always return empty/undefined
 * reads (cache miss), so IDB-backed data sources fall through to the remote
 * (MSW-mocked) path in happy-dom tests.
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
