import { command, state, type Command } from "ccstate";
import type { CSSProperties } from "react";
import { delay } from "signal-timers";
import { IN_VITEST } from "../env.ts";
import { logger } from "./log.ts";

const L = logger("Promise");

export enum Reason {
  DomCallback = "dom_callback",
  Entrance = "entrance",
  Deferred = "deferred",
  Daemon = "daemon",
}

class PromiseTracker {
  collected = new Set<Promise<unknown>>();
  reasons = new Map<Promise<unknown>, Reason>();
  descriptions = new Map<Promise<unknown>, string>();
  handledErrors = new WeakSet<object>();
}

const tracker = new PromiseTracker();

export function markDetachedErrorHandled(error: unknown): unknown {
  if ((typeof error === "object" || typeof error === "function") && error) {
    tracker.handledErrors.add(error);
  }
  return error;
}

function isHandledDetachedError(error: unknown): boolean {
  return (
    (typeof error === "object" || typeof error === "function") &&
    error !== null &&
    tracker.handledErrors.has(error)
  );
}

export function detach<T>(
  promise: T | Promise<T>,
  reason: Reason,
  description?: string,
): void {
  L.debug("Detach promise", reason, description);

  const isPromise = promise instanceof Promise;
  let silencePromise: Promise<void> | undefined;

  if (isPromise) {
    // This instance is necessary because detach itself is a controlled way to generate a floating promise.
    // confirmed by ethan@vm0.ai
    // oxlint-disable-next-line promise/prefer-await-to-then
    silencePromise = Promise.resolve(promise).then(
      () => {},
      (error: unknown) => {
        if (!isAbortError(error) && !isHandledDetachedError(error)) {
          L.error(`Detached promise rejected [${reason}]`, error);
        }
      },
    );
  }

  if (IN_VITEST && silencePromise) {
    tracker.collected.add(silencePromise);
    tracker.reasons.set(silencePromise, reason);
    if (description) {
      tracker.descriptions.set(silencePromise, description);
    }
  }
}

export async function clearAllDetached() {
  if (!IN_VITEST) {
    tracker.collected.clear();
    tracker.reasons.clear();
    tracker.descriptions.clear();
    return [];
  }

  L.debug("Clear all detached promises");

  const settledResult: {
    promise: Promise<unknown>;
    reason: Reason | undefined;
    description: string | undefined;
    result?: unknown;
    error?: unknown;
  }[] = [];

  L.debugGroup("Detached promises");
  for (const promise of tracker.collected) {
    const reason = tracker.reasons.get(promise);
    const description = tracker.descriptions.get(promise);
    L.debug(`Await promise: ${reason ?? "unknown"} ${description ?? ""}`);
    await promise.then(
      (result) => {
        settledResult.push({
          promise,
          reason,
          description: tracker.descriptions.get(promise),
          result,
        });
      },
      (error: unknown) => {
        throwIfNotAbort(error);
        settledResult.push({
          promise,
          reason,
          description: tracker.descriptions.get(promise),
          error,
        });
      },
    );
  }
  L.debugGroupEnd();

  tracker.collected.clear();
  tracker.reasons.clear();
  tracker.descriptions.clear();

  return settledResult;
}

const isAbortError = (error: unknown): boolean => {
  if (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "AbortError"
  ) {
    return true;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason instanceof Error &&
    error.reason.name === "AbortError"
  ) {
    return true;
  }

  return false;
};

function throwIfNotAbort(e: unknown) {
  if (!isAbortError(e)) {
    throw e;
  }
}

export function throwIfAbort(e: unknown) {
  if (isAbortError(e)) {
    throw e;
  }
}

/**
 * Parse JSON with a fallback value for untrusted input (e.g. localStorage).
 * Re-throws abort errors; swallows parse errors and returns `fallback`.
 */
export function jsonParseOr<T>(value: string, fallback: T): T {
  // We must use this approach to silence the exception here. This is because
  // the function itself is designed to help the caller avoid having to handle
  // the try-catch block manually.
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line no-restricted-syntax
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throwIfAbort(error);
    return fallback;
  }
}

/**
 * Best-effort wrapper: await `p` and swallow non-abort errors.
 * Use for prefetch or fire-and-forget operations where failure is acceptable.
 * AbortError propagates — either from `p` itself or from `signal` if one is
 * passed — so a cancelled request never returns silently as if the work
 * succeeded.
 */
export async function bestEffort(
  p: Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line no-restricted-syntax
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
 * Use as a `.catch(handler)` replacement when the caller needs to surface
 * a side effect (toast, log) on failure but otherwise continue.
 */
export async function tapError<T>(
  p: Promise<T>,
  onError: (error: unknown) => void,
): Promise<T | undefined> {
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line no-restricted-syntax
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
 * Use as a `.catch(handler)` replacement when the caller needs to run a
 * cleanup side effect before the rejection propagates.
 */
export async function onRejection<T>(
  p: Promise<T>,
  fn: (error: unknown) => void,
): Promise<T> {
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line no-restricted-syntax
  try {
    return await p;
  } catch (error) {
    fn(error);
    throw error;
  }
}

type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Settle `p` into a discriminated union. Abort errors propagate (re-throw),
 * either from `p` itself or from `signal` if one is passed — so the returned
 * union is guaranteed to never represent a cancellation. Use as a
 * `.then(onOk, onErr)` replacement when the caller needs to map both
 * branches to a value rather than swallow the error.
 */
export async function settle<T>(
  p: Promise<T>,
  signal?: AbortSignal,
): Promise<Settled<T>> {
  // confirmed by ethan@vm0.ai
  // eslint-disable-next-line no-restricted-syntax
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

export async function withCleanup<T>(
  promise: Promise<T>,
  cleanup: () => void,
): Promise<T> {
  // Centralizes command cleanup that must preserve the original promise result.
  // eslint-disable-next-line no-restricted-syntax -- helper preserves rejection while guaranteeing cleanup
  try {
    return await promise;
  } finally {
    cleanup();
  }
}

export function toVoid<T>(p: Promise<T>): Promise<void> {
  // This helper intentionally discards fulfillment values while preserving rejection semantics.
  // confirmed by ethan@vm0.ai
  // oxlint-disable-next-line promise/prefer-await-to-then
  return p.then(() => {});
}

// ---------------------------------------------------------------------------
// Polling loop with fibonacci backoff
// ---------------------------------------------------------------------------
const FIB_DELAYS_MS = [
  1000, 1000, 2000, 3000, 5000, 8000, 13_000, 21_000, 34_000, 55_000, 60_000,
] as const;

export const MAX_LOOP_COUNT_IN_TEST = 100;
/**
 * Run `loopBody` in a loop with `interval` between iterations.
 * Transient (non-abort) errors trigger fibonacci backoff retries.
 * Resolves when `loopBody` returns `true` (done) or rejects on abort.
 */
export async function setLoop(
  loopBody: (signal: AbortSignal) => Promise<boolean> | boolean,
  interval: number,
  signal: AbortSignal,
): Promise<void> {
  let fibIndex = 0;
  let loopCount = 0;
  while (!signal.aborted) {
    if (IN_VITEST && loopCount++ > MAX_LOOP_COUNT_IN_TEST) {
      throw new Error(
        `setLoop: infinite loop detected — exceeded ${MAX_LOOP_COUNT_IN_TEST} iterations in test`,
      );
    }

    // use try-catch here to implement an automatic retry.
    // confirmed by ethan@vm0.ai
    // eslint-disable-next-line no-restricted-syntax
    try {
      const done = await loopBody(signal);
      if (done) {
        return;
      }
      fibIndex = 0;
      // In VITEST, yield to the macrotask queue via setTimeout so React can
      // flush renders between iterations. Using Promise.resolve() only queues
      // a microtask, which starves React's render cycle. We avoid
      // delay(0, { signal }) because signal-timers' Promise.race leaves an
      // abandoned promiseFromSignal that rejects as an unhandled rejection
      // when the abort signal fires during afterEach cleanup.
      await (IN_VITEST
        ? delay(0, { signal: AbortSignal.any([]) })
        : delay(interval, { signal }));
    } catch (error) {
      throwIfAbort(error);
      const backoff =
        FIB_DELAYS_MS[Math.min(fibIndex, FIB_DELAYS_MS.length - 1)] ?? 60_000;
      L.warn(
        `setLoop: transient error (attempt ${fibIndex + 1}), retrying in ${backoff}ms`,
        error,
      );
      fibIndex++;
      await (IN_VITEST
        ? delay(0, { signal: AbortSignal.any([]) })
        : delay(backoff, { signal }));
    }
  }
}

export function resetSignal(): Command<AbortSignal, AbortSignal[]> {
  const controller$ = state<AbortController | undefined>(undefined);

  return command(({ get, set }, ...signals: AbortSignal[]) => {
    get(controller$)?.abort();
    const controller = new AbortController();
    set(controller$, controller);

    return AbortSignal.any([controller.signal, ...signals]);
  });
}

export function onDomEventFn<T>(callback: (e: T) => void | Promise<void>) {
  return function (e: T) {
    detach(callback(e), Reason.DomCallback);
  };
}

export function onRef<T extends HTMLElement | SVGSVGElement>(
  command$: Command<void | Promise<void>, [T, AbortSignal]>,
) {
  return command(({ set }, el: T | null) => {
    if (!el) {
      return;
    }

    const ctrl = new AbortController();

    detach(set(command$, el, ctrl.signal), Reason.DomCallback, "onRef");

    return () => {
      ctrl.abort();
    };
  });
}

/**
 * Create a deferred promise that can be resolved/rejected externally.
 * The promise is automatically rejected when the abort signal is triggered.
 */
export function createDeferredPromise<T>(signal: AbortSignal): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  settled: () => boolean;
} {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;

  detach(promise, Reason.Deferred);

  const guardedResolve = (value: T) => {
    if (settled) {
      throw new Error("Deferred promise already settled");
    }
    settled = true;
    resolve(value);
  };

  const guardedReject = (reason?: unknown) => {
    if (settled) {
      throw new Error("Deferred promise already settled");
    }
    settled = true;
    reject(reason);
  };

  signal.addEventListener("abort", () => {
    if (!settled) {
      guardedReject(signal.reason);
    }
  });

  return {
    promise,
    resolve: guardedResolve,
    reject: guardedReject,
    settled: () => {
      return settled;
    },
  };
}

type GeometryStyle = Pick<
  CSSProperties,
  | "width"
  | "height"
  | "left"
  | "top"
  | "right"
  | "bottom"
  | "maxWidth"
  | "maxHeight"
  | "minWidth"
  | "minHeight"
  | "transform"
>;

/**
 * Convert numeric geometry values to CSS style object.
 */
export function geometryStyle(geometry: {
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  maxWidth?: number;
  maxHeight?: number;
  minWidth?: number;
  minHeight?: number;
  scale?: number;
}): GeometryStyle {
  const ret: GeometryStyle = {};

  if (geometry.width !== undefined) {
    ret.width = `${String(geometry.width)}px`;
  }
  if (geometry.height !== undefined) {
    ret.height = `${String(geometry.height)}px`;
  }
  if (geometry.left !== undefined) {
    ret.left = `${String(geometry.left)}px`;
  }
  if (geometry.top !== undefined) {
    ret.top = `${String(geometry.top)}px`;
  }
  if (geometry.right !== undefined) {
    ret.right = `${String(geometry.right)}px`;
  }
  if (geometry.bottom !== undefined) {
    ret.bottom = `${String(geometry.bottom)}px`;
  }
  if (geometry.maxWidth !== undefined) {
    ret.maxWidth = `${String(geometry.maxWidth)}px`;
  }
  if (geometry.maxHeight !== undefined) {
    ret.maxHeight = `${String(geometry.maxHeight)}px`;
  }
  if (geometry.minWidth !== undefined) {
    ret.minWidth = `${String(geometry.minWidth)}px`;
  }
  if (geometry.minHeight !== undefined) {
    ret.minHeight = `${String(geometry.minHeight)}px`;
  }
  if (geometry.scale !== undefined) {
    ret.transform = `scale(${String(geometry.scale)})`;
  }

  return ret;
}
