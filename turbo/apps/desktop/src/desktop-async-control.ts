export interface SingleFlightTask<TResult> {
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

    const current = (async () => task())().finally(() => {
      if (inFlight === current) {
        inFlight = null;
      }
    });
    inFlight = current;
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

export interface LatestWinsToken {
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
