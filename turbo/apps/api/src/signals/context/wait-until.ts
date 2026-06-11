// oxlint-disable-next-line no-restricted-imports -- this file is the wrapper around @vercel/functions waitUntil, confirmed by ethan@vm0.ai
import { waitUntil as vercelWaitUntil } from "@vercel/functions";

import { env } from "../../lib/env";
import { singleton } from "../../lib/singleton";
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

export function waitUntil(work: Promise<unknown>): void {
  vercelWaitUntil(work);
  detach(work, Mechanism.WaitUntil);
  trackWaitUntilForTest(work);
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
