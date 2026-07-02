import { delay } from "signal-timers";
import { throwIfAbort } from "../utils.ts";
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
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const timeoutSignal = signal ?? AbortSignal.any([]);

  const timeoutPromise = (async (): Promise<never> => {
    await delay(CHAT_IDB_OPERATION_TIMEOUT_MS, { signal: timeoutSignal });
    throw new ChatIdbTimeoutError(label);
  })();
  const operationPromise = (async (): Promise<T> => {
    return await operation();
  })();

  return await Promise.race([operationPromise, timeoutPromise]);
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
): Promise<void> {
  // Writes should never block the server-backed chat flow.
  // eslint-disable-next-line no-restricted-syntax
  try {
    await withChatIdbTimeout(label, operation, signal);
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
    L.debug("write:ignored", { label, error });
  }
}
