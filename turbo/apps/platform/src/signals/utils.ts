import { command, state, type Command } from "ccstate";

export enum Reason {
  DomCallback = "dom_callback",
  Entrance = "entrance",
  Deferred = "deferred",
  Daemon = "daemon",
}

const IN_VITEST =
  typeof process !== "undefined" && process.env.VITEST === "true";

const collectedPromise = new Set<Promise<unknown>>();
const promiseReason = new Map<Promise<unknown>, Reason>();
const promiseDescription = new Map<Promise<unknown>, string>();

export function detach<T>(
  promise: T | Promise<T>,
  reason: Reason,
  description?: string,
): void {
  const isPromise = promise instanceof Promise;
  let silencePromise: Promise<void> | undefined;

  if (isPromise) {
    silencePromise = (async () => {
      try {
        await promise;
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

  const settledResult = [];

  for (const promise of collectedPromise) {
    const reason = promiseReason.get(promise);
    try {
      const result = await promise;
      settledResult.push({
        promise,
        reason,
        description: promiseDescription.get(promise),
        result,
      });
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
