interface NowOverride {
  readonly value: number;
}

function createNowOverride(): {
  readonly get: () => number | undefined;
  readonly set: (value: number, signal: AbortSignal) => void;
} {
  let current: NowOverride | undefined;

  return {
    get: () => {
      return current?.value;
    },
    set: (value, signal) => {
      signal.throwIfAborted();
      const override = { value };
      current = override;
      signal.addEventListener(
        "abort",
        () => {
          if (current === override) {
            current = undefined;
          }
        },
        { once: true },
      );
    },
  };
}

const { get: getMockedNow, set: setMockedNow } = createNowOverride();

export function now(): number {
  return getMockedNow() ?? Date.now();
}

export function nowDate(): Date {
  return new Date(now());
}

export function mockNow(value: Date | number, signal: AbortSignal): void {
  setMockedNow(value instanceof Date ? value.getTime() : value, signal);
}
