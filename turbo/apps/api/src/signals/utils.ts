import { env } from "../lib/env";
import { logger } from "../lib/log";
import { singleton } from "../lib/singleton";

export enum Mechanism {
  WaitUntil = "wait_until",
}

const IN_VITEST = env("VITEST") === "true";
const L = logger("Promise");

class PromiseTracker {
  collected = new Set<Promise<unknown>>();
  mechanisms = new Map<Promise<unknown>, Mechanism>();
  descriptions = new Map<Promise<unknown>, string>();
}

const tracker = singleton(() => {
  return new PromiseTracker();
});

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "AbortError"
  );
}

export function throwIfAbort(error: unknown): void {
  if (isAbortError(error)) {
    throw error;
  }
}

export function safeJsonParse(input: string): unknown {
  // eslint-disable-next-line no-restricted-syntax -- this is the centralized guarded JSON.parse
  try {
    return JSON.parse(input);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
  }
}

export function safeUrlParse(input: string): URL | undefined {
  // eslint-disable-next-line no-restricted-syntax -- centralized guarded URL constructor
  try {
    return new URL(input);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
  }
}

export function safeSync<T>(
  fn: () => T,
): { readonly ok: T } | { readonly error: unknown } {
  // eslint-disable-next-line no-restricted-syntax -- centralized guarded sync
  try {
    return { ok: fn() };
  } catch (error) {
    throwIfAbort(error);
    return { error };
  }
}

export function isValidTimeZone(input: string): boolean {
  // eslint-disable-next-line no-restricted-syntax -- centralized guarded Intl timezone validation
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: input });
    return true;
  } catch (error) {
    throwIfAbort(error);
    return false;
  }
}

// Centralized guarded async — wraps a Promise-returning thunk so callers in
// best-effort polling loops (e.g. agent-event-visibility) can branch on the
// outcome without scattering try/catch around. AbortError is re-raised so
// cancellation propagates correctly.
export async function safeAsync<T>(
  fn: () => Promise<T>,
): Promise<{ readonly ok: T } | { readonly error: unknown }> {
  // eslint-disable-next-line no-restricted-syntax -- centralized guarded async
  try {
    return { ok: await fn() };
  } catch (error) {
    throwIfAbort(error);
    return { error };
  }
}

export function detach(
  promise: Promise<unknown>,
  mechanism: Mechanism,
  description?: string,
): void {
  const silenced = promise.then(
    () => {},
    (error: unknown) => {
      if (!isAbortError(error)) {
        L.error(`Detached promise rejected [${mechanism}]`, error);
      }
    },
  );

  if (IN_VITEST) {
    tracker().collected.add(silenced);
    tracker().mechanisms.set(silenced, mechanism);
    if (description) {
      tracker().descriptions.set(silenced, description);
    }
  }
}

export async function clearAllDetached(): Promise<void> {
  if (!IN_VITEST) {
    tracker().collected.clear();
    tracker().mechanisms.clear();
    tracker().descriptions.clear();
    return;
  }

  for (const promise of tracker().collected) {
    await promise;
  }
  tracker().collected.clear();
  tracker().mechanisms.clear();
  tracker().descriptions.clear();
}
