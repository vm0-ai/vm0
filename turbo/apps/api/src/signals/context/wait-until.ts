import { env } from "../../lib/env";
import { currentInvocation } from "../../lib/invocation-context";
import { flushLogs, logger } from "../../lib/log";
import { singleton, testOverride } from "../../lib/singleton";
import { now } from "../../lib/time";
import { detach, isAbortError, Mechanism } from "../utils";

const shouldTrackWaitUntil = env("VITEST") === "true";

class WaitUntilTracker {
  pending = new Set<Promise<unknown>>();
}

const waitUntilTracker = singleton(() => {
  return new WaitUntilTracker();
});

function trackWaitUntilForTest(work: Promise<unknown>): void {
  if (!shouldTrackWaitUntil) {
    return;
  }

  const tracker = waitUntilTracker();
  tracker.pending.add(work);
  void work.then(
    () => {
      tracker.pending.delete(work);
    },
    () => {
      tracker.pending.delete(work);
    },
  );
}

type WaitUntilAdapter = (work: Promise<unknown>) => void;

const { get: getWaitUntilAdapter, set: setWaitUntilAdapter } = testOverride<
  WaitUntilAdapter | undefined
>(() => {
  return undefined;
});

const log = logger("api:wait-until");

export function configureWaitUntilAdapter(adapter: WaitUntilAdapter): void {
  setWaitUntilAdapter(adapter);
}

export function waitUntil(name: string, work: Promise<unknown>): void {
  const invocation = currentInvocation();
  if (invocation) {
    invocation.registerWaitUntil(name, work);
    detach(work, Mechanism.WaitUntil);
    trackWaitUntilForTest(work);
    return;
  }

  const waitUntilAdapter = getWaitUntilAdapter();
  if (!waitUntilAdapter) {
    detach(work, Mechanism.WaitUntil);
    trackWaitUntilForTest(work);
    return;
  }

  const startedAt = now();
  const observed = work.then(
    (value) => {
      log.debug("waitUntil completed", {
        durationMs: Math.max(0, now() - startedAt),
        name,
        outcome: "fulfilled",
      });
      return value;
    },
    (error: unknown) => {
      log.error("waitUntil failed", {
        durationMs: Math.max(0, now() - startedAt),
        error,
        name,
        outcome: "rejected",
      });
      throw error;
    },
  );
  const flush = observed.then(
    () => {
      return flushLogs();
    },
    () => {
      return flushLogs();
    },
  );
  waitUntilAdapter(observed);
  waitUntilAdapter(flush);
  detach(observed, Mechanism.WaitUntil);
  detach(flush, Mechanism.WaitUntil);
  trackWaitUntilForTest(observed);
}

export async function flushWaitUntilForTest(): Promise<void> {
  const errors: unknown[] = [];
  const tracker = waitUntilTracker();

  while (tracker.pending.size > 0) {
    const pending = [...tracker.pending];
    tracker.pending.clear();

    for (const promise of pending) {
      await promise.then(
        () => {},
        (error: unknown) => {
          if (!isAbortError(error)) {
            errors.push(error);
          }
        },
      );
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}
