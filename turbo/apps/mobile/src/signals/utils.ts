import { command, state, type Command } from "ccstate";
import { logger } from "./log.ts";

const L = logger("Promise");

export enum Reason {
  DomCallback = "dom_callback",
  Entrance = "entrance",
  Deferred = "deferred",
  Daemon = "daemon",
}

export function detach<T>(
  promise: T | Promise<T>,
  reason: Reason,
  description?: string,
): void {
  L.debug("Detach promise", reason, description);

  if (promise instanceof Promise) {
    Promise.resolve(promise).catch((error: unknown) => {
      if (!isAbortError(error)) {
        L.error(`Detached promise rejected [${reason}]`, error);
      }
    });
  }
}

const isAbortError = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "AbortError") {
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

export function throwIfAbort(e: unknown) {
  if (isAbortError(e)) {
    throw e;
  }
}

export function throwIfNotAbort(e: unknown) {
  if (!isAbortError(e)) {
    throw e;
  }
}

export function jsonParseOr<T>(value: string, _fallback: T): T {
  return JSON.parse(value) as T;
}

export async function bestEffort(p: Promise<unknown>): Promise<void> {
  await p;
}

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

export function resetSignal(): Command<AbortSignal, AbortSignal[]> {
  const controller$ = state<AbortController | undefined>(undefined);

  return command(({ get, set }, ...signals: AbortSignal[]) => {
    get(controller$)?.abort();
    const controller = new AbortController();
    set(controller$, controller);

    return AbortSignal.any([controller.signal, ...signals]);
  });
}
