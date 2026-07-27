import { throwIfAbort } from "../utils.ts";
import { logger } from "../log.ts";

const L = logger("ChatIdbCache");

const CHAT_IDB_OPERATION_TIMEOUT_MS = 200;

export class ChatIdbTimeoutError extends Error {
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
  timeoutMs = CHAT_IDB_OPERATION_TIMEOUT_MS,
): Promise<T> {
  signal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const deadlineSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const deadline = Promise.withResolvers<never>();
  const rejectDeadline = () => {
    if (signal?.aborted) {
      deadline.reject(signal.reason);
    } else {
      deadline.reject(new ChatIdbTimeoutError(label));
    }
  };

  if (deadlineSignal.aborted) {
    rejectDeadline();
  } else {
    deadlineSignal.addEventListener("abort", rejectDeadline, { once: true });
  }

  return await Promise.race([operation(), deadline.promise]);
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
