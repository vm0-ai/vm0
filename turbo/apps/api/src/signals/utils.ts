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

function throwIfAbort(error: unknown): void {
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
