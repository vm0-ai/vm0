interface SingleFlightTask<TResult> {
  (): Promise<TResult>;
  clear: () => void;
  readonly inFlight: boolean;
}

export function singleFlight<TResult>(
  task: () => Promise<TResult>,
): SingleFlightTask<TResult> {
  let inFlight: Promise<TResult> | null = null;

  const run = (() => {
    if (inFlight) {
      return inFlight;
    }

    let resolve!: (value: TResult | PromiseLike<TResult>) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<TResult>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const current = result.finally(() => {
      if (inFlight === current) {
        inFlight = null;
      }
    });
    // The task's synchronous prefix may notify subscribers that call us again.
    // Publish first, without delaying synchronous authority withdrawal.
    inFlight = current;
    try {
      resolve(task());
    } catch (error) {
      reject(error);
    }
    return current;
  }) as SingleFlightTask<TResult>;

  run.clear = () => {
    inFlight = null;
  };

  Object.defineProperty(run, "inFlight", {
    get() {
      return inFlight !== null;
    },
  });

  return run;
}

export function latestWinsSingleFlight(
  task: () => Promise<void>,
  options: {
    readonly onError?: (error: unknown) => void;
  } = {},
): () => void {
  let running = false;
  let rerunRequested = false;

  const drain = async () => {
    while (true) {
      rerunRequested = false;
      try {
        await task();
      } catch (error) {
        options.onError?.(error);
      }

      if (!rerunRequested) {
        running = false;
        return;
      }
    }
  };

  return () => {
    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;
    void drain();
  };
}

interface LatestWinsToken {
  isCurrent: () => boolean;
}

export function latestWinsGuard(): () => LatestWinsToken {
  let version = 0;

  return () => {
    version += 1;
    const currentVersion = version;
    return {
      isCurrent: () => currentVersion === version,
    };
  };
}
