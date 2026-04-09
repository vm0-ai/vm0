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

class PromiseTracker {
  collected = new Set<Promise<unknown>>();
  reasons = new Map<Promise<unknown>, Reason>();
  descriptions = new Map<Promise<unknown>, string>();
}

const tracker = new PromiseTracker();

export function detach<T>(
  promise: T | Promise<T>,
  reason: Reason,
  description?: string,
): void {
  L.debug("Detach promise", reason, description);

  const isPromise = promise instanceof Promise;
  let silencePromise: Promise<void> | undefined;

  if (isPromise) {
    silencePromise = Promise.resolve(promise).then(
      () => {},
      (error: unknown) => {
        throwIfNotAbort(error);
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

export function throwIfNotAbort(e: unknown) {
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
