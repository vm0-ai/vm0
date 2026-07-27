import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ChatIdbCache");

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

export async function chatIdbReadOr<T>(
  label: string,
  operation: () => Promise<T>,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  // IDB is an untrusted local cache, so non-abort failures degrade to miss.
  // eslint-disable-next-line no-restricted-syntax
  try {
    signal?.throwIfAborted();
    const result = await operation();
    signal?.throwIfAborted();
    return result;
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
  // IDB is an untrusted local cache, so non-abort write failures are ignored.
  // eslint-disable-next-line no-restricted-syntax
  try {
    signal?.throwIfAborted();
    await operation();
    signal?.throwIfAborted();
    return true;
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
    L.debug("write:ignored", { label, error });
    return false;
  }
}
