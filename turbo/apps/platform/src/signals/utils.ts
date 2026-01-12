import { command, state, type Command } from "ccstate";
import type { CSSProperties } from "react";
import { IN_VITEST } from "../env.ts";
import { logger } from "./log.ts";

const L = logger("Promise");

export enum Reason {
  DomCallback = "dom_callback",
  Entrance = "entrance",
  Deferred = "deferred",
  Daemon = "daemon",
}

// we use dynamic set to collect detached promises in vitest environment
// eslint-disable-next-line ccstate/no-package-variable
const collectedPromise = new Set<Promise<unknown>>();

// we use dynamic set to collect detached promises in vitest environment
// eslint-disable-next-line ccstate/no-package-variable
const promiseReason = new Map<Promise<unknown>, Reason>();

// we use dynamic set to collect detached promises in vitest environment
// eslint-disable-next-line ccstate/no-package-variable
const promiseDescription = new Map<Promise<unknown>, string>();

export function detach<T>(
  promise: T | Promise<T>,
  reason: Reason,
  description?: string,
): void {
  L.debug("Detach promise", reason, description);

  const isPromise = promise instanceof Promise;
  let silencePromise: Promise<void> | undefined;

  if (isPromise) {
    silencePromise = (async () => {
      try {
        await promise;
        // here is an allow case for no-catch-abort because we want to rethrow non-abort errors
        // eslint-disable-next-line ccstate/no-catch-abort
      } catch (error) {
        throwIfNotAbort(error);
      }
    })();
  }

  if (IN_VITEST && silencePromise) {
    collectedPromise.add(silencePromise);
    promiseReason.set(silencePromise, reason);
    if (description) {
      promiseDescription.set(silencePromise, description);
    }
  }
}

export async function clearAllDetached() {
  if (!IN_VITEST) {
    collectedPromise.clear();
    promiseReason.clear();
    promiseDescription.clear();
    return [];
  }

  L.debug("Clear all detached promises");

  const settledResult = [];

  L.debugGroup("Detached promises");
  for (const promise of collectedPromise) {
    const reason = promiseReason.get(promise);
    const description = promiseDescription.get(promise);
    L.debug(`Await promise: ${reason ?? "unknown"} ${description ?? ""}`);
    try {
      const result = await promise;
      settledResult.push({
        promise,
        reason,
        description: promiseDescription.get(promise),
        result,
      });
      // we only want to collect abort abort errors here
      // eslint-disable-next-line ccstate/no-catch-abort
    } catch (error) {
      throwIfNotAbort(error);
      settledResult.push({
        promise,
        reason,
        description: promiseDescription.get(promise),
        error,
      });
    }
  }
  L.debugGroupEnd();

  collectedPromise.clear();
  promiseReason.clear();
  promiseDescription.clear();

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
  let _resolve: ((value: T) => void) | undefined;
  let _reject: ((reason?: unknown) => void) | undefined;
  let settled = false;

  const promise = new Promise<T>((resolve, reject) => {
    _resolve = (value: T) => {
      if (settled) {
        throw new Error("Deferred promise already settled");
      }
      settled = true;
      resolve(value);
    };
    _reject = (reason?: unknown) => {
      if (settled) {
        throw new Error("Deferred promise already settled");
      }
      settled = true;
      reject(reason);
    };
  });

  detach(promise, Reason.Deferred);

  signal.addEventListener("abort", () => {
    if (!settled) {
      _reject?.(signal.reason);
    }
  });

  return {
    promise,
    resolve: _resolve as unknown as (value: T) => void,
    reject: _reject as unknown as (reason?: unknown) => void,
    settled: () => settled,
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
