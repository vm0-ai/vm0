type CompositionPhase = "idle" | "composing" | "settling";

interface CompositionWaiter {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export interface CompositionGate {
  readonly compositionStart: () => void;
  readonly compositionEnd: () => void;
  readonly notifySettled: () => void;
  readonly runWhenSettled: <T>(
    action: () => T,
    signal: AbortSignal,
  ) => Promise<T>;
  readonly cancel: (reason: unknown) => void;
}

export function createCompositionGate(): CompositionGate {
  let phase: CompositionPhase = "idle";
  let settleFrame: number | null = null;
  const waiters = new Set<CompositionWaiter>();

  const cancelSettleFrame = () => {
    if (settleFrame === null) {
      return;
    }
    cancelAnimationFrame(settleFrame);
    settleFrame = null;
  };

  const flush = () => {
    if (phase === "composing") {
      return;
    }
    cancelSettleFrame();
    phase = "idle";
    const pendingWaiters = [...waiters];
    waiters.clear();
    for (const waiter of pendingWaiters) {
      waiter.resolve();
    }
  };

  const compositionStart = () => {
    cancelSettleFrame();
    phase = "composing";
  };

  const compositionEnd = () => {
    if (phase === "idle") {
      return;
    }
    phase = "settling";
    cancelSettleFrame();
    settleFrame = requestAnimationFrame(flush);
  };

  const notifySettled = () => {
    if (phase === "settling") {
      flush();
    }
  };

  const waitUntilSettled = (signal: AbortSignal): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        waiter.reject(signal.reason);
      };
      const cleanup = () => {
        waiters.delete(waiter);
        signal.removeEventListener("abort", onAbort);
      };
      const waiter: CompositionWaiter = {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (reason) => {
          cleanup();
          reject(reason);
        },
      };
      waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const runWhenSettled = async <T>(
    action: () => T,
    signal: AbortSignal,
  ): Promise<T> => {
    signal.throwIfAborted();
    if (phase !== "idle") {
      await waitUntilSettled(signal);
      signal.throwIfAborted();
    }
    return action();
  };

  const cancel = (reason: unknown) => {
    cancelSettleFrame();
    phase = "idle";
    const pendingWaiters = [...waiters];
    waiters.clear();
    for (const waiter of pendingWaiters) {
      waiter.reject(reason);
    }
  };

  return {
    compositionStart,
    compositionEnd,
    notifySettled,
    runWhenSettled,
    cancel,
  };
}
