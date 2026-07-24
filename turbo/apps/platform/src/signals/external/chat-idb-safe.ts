import { createDeferredPromise, throwIfAbort, withCleanup } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ChatIdbCache");

const CHAT_IDB_OPERATION_TIMEOUT_MS = 200;

class ChatIdbTimeoutError extends Error {
  constructor(label: string) {
    super(`IndexedDB operation timed out: ${label}`);
    this.name = "ChatIdbTimeoutError";
  }
}

class ChatIdbDisabledError extends Error {
  constructor(dbName: string) {
    super(`IndexedDB disabled for this session: ${dbName}`);
    this.name = "ChatIdbDisabledError";
  }
}

export function disabledChatIdbError(dbName: string): Error {
  return new ChatIdbDisabledError(dbName);
}

export function logChatIdbDisabled(dbName: string, reason: unknown): void {
  L.warn("disableForSession", { dbName, reason });
}

export async function withChatIdbTimeout<T>(
  label: string,
  operation: (operationSignal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const operationTimeoutSignal = AbortSignal.timeout(
    CHAT_IDB_OPERATION_TIMEOUT_MS,
  );
  const operationSignal = signal
    ? AbortSignal.any([signal, operationTimeoutSignal])
    : operationTimeoutSignal;
  const timeoutResult = Symbol("chat-idb-timeout");

  const timeoutDeferred = createDeferredPromise<typeof timeoutResult>(
    AbortSignal.any([]),
  );
  const onOperationAbort = () => {
    if (signal?.aborted) {
      timeoutDeferred.reject(signal.reason);
    } else if (operationTimeoutSignal.aborted) {
      timeoutDeferred.resolve(timeoutResult);
    }
  };
  operationSignal.addEventListener("abort", onOperationAbort, { once: true });
  const operationPromise = (async (): Promise<T> => {
    return await operation(operationSignal);
  })();

  const result = await withCleanup(
    Promise.race([operationPromise, timeoutDeferred.promise]),
    () => {
      operationSignal.removeEventListener("abort", onOperationAbort);
      if (!timeoutDeferred.settled()) {
        timeoutDeferred.resolve(timeoutResult);
      }
    },
  );
  if (result === timeoutResult) {
    throw new ChatIdbTimeoutError(label);
  }
  return result;
}

export async function chatIdbReadOr<T>(
  label: string,
  operation: () => Promise<T>,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  // IDB is an untrusted local cache, so non-abort failures degrade to miss.
  // eslint-disable-next-line no-restricted-syntax
  try {
    return await withChatIdbTimeout(label, operation, signal);
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
    L.debug("read:fallback", { label, error });
    return fallback;
  }
}

export async function chatIdbWriteBestEffort(
  label: string,
  operation: () => Promise<void>,
  signal?: AbortSignal,
): Promise<boolean> {
  // Writes should never block the server-backed chat flow.
  // eslint-disable-next-line no-restricted-syntax
  try {
    await withChatIdbTimeout(label, operation, signal);
    return true;
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
    L.debug("write:ignored", { label, error });
    return false;
  }
}
