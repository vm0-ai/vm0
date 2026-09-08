export interface ComputerUseLifecycleTimers {
  readonly setTimeout: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: typeof clearTimeout;
}

/** Bounds the caller's wait; the caller still owns and must retire late work. */
export async function withComputerUseDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  timers: ComputerUseLifecycleTimers = { setTimeout, clearTimeout },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = timers.setTimeout(() => {
          reject(
            new Error(
              "Computer Use driver transition timed out; admission remains closed",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    timers.clearTimeout(timer);
  }
}

export function createComputerUseDrain(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
