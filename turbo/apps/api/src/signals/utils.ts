import { env } from "./external/env";
import { logger } from "./external/log";

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

const tracker = new PromiseTracker();

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    error.name === "AbortError"
  );
}

function throwIfAbort(error: unknown): void {
  if (isAbortError(error)) {
    throw error;
  }
}

export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    throwIfAbort(error);
    return undefined;
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
    tracker.collected.add(silenced);
    tracker.mechanisms.set(silenced, mechanism);
    if (description) {
      tracker.descriptions.set(silenced, description);
    }
  }
}

export async function clearAllDetached(): Promise<void> {
  if (!IN_VITEST) {
    tracker.collected.clear();
    tracker.mechanisms.clear();
    tracker.descriptions.clear();
    return;
  }

  for (const promise of tracker.collected) {
    await promise;
  }
  tracker.collected.clear();
  tracker.mechanisms.clear();
  tracker.descriptions.clear();
}
