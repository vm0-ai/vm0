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

/**
 * Await `p`, swallowing non-abort rejections. Use for fire-and-forget work
 * where failure is acceptable. AbortError propagates — either from `p`
 * itself or from `signal` if one is passed — so a cancelled request never
 * returns silently as if the work succeeded.
 */
export async function bestEffort(
  p: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .catch replacement
  try {
    await p;
    signal?.throwIfAborted();
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
  }
}

/**
 * Await `p` and invoke `onError` on non-abort rejection. Abort propagates.
 * Replaces `await foo().catch((e) => { L.error("...", e); })` patterns.
 */
export async function tapError<T>(
  p: Promise<T>,
  onError: (error: unknown) => void,
): Promise<T | undefined> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .catch replacement
  try {
    return await p;
  } catch (error) {
    throwIfAbort(error);
    onError(error);
    return undefined;
  }
}

/**
 * Await `p` and invoke `fn` on any rejection (including abort), then re-throw.
 * Replaces `.catch((e) => { cleanup(); throw e; })` cleanup patterns. `fn`
 * runs on abort by design so cleanup (e.g. temp-dir removal) still happens
 * when the request is cancelled — that's why `api/no-catch-abort` is muted
 * here.
 */
export async function onRejection<T>(
  p: Promise<T>,
  fn: (error: unknown) => void,
): Promise<T> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .catch replacement
  try {
    return await p;
    // eslint-disable-next-line api/no-catch-abort -- fn must run before abort propagates so cleanup happens on cancellation
  } catch (error) {
    fn(error);
    throw error;
  }
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Settle `p` into a discriminated union. AbortError propagates (re-throws),
 * either from `p` itself or from `signal` if one is passed — so the returned
 * union is guaranteed to never represent a cancellation. Replaces
 * `await foo().catch(() => fallback)` and `.then(onOk, onErr)` shapes when
 * both outcomes need to be mapped.
 */
export async function settle<T>(
  p: Promise<T>,
  signal?: AbortSignal,
): Promise<Settled<T>> {
  // eslint-disable-next-line no-restricted-syntax -- centralized .then(onOk, onErr) replacement
  try {
    const value = await p;
    signal?.throwIfAborted();
    return { ok: true, value };
  } catch (error) {
    throwIfAbort(error);
    signal?.throwIfAborted();
    return { ok: false, error };
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
