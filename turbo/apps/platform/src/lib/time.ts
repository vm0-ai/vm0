type NowValue = number | (() => number);

interface NowOverride {
  readonly value: NowValue;
}

function createNowOverride(): {
  readonly get: () => number | undefined;
  readonly set: (value: NowValue, signal: AbortSignal) => void;
} {
  let current: NowOverride | undefined;

  return {
    get: () => {
      const value = current?.value;
      return typeof value === "function" ? value() : value;
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

export function mockNow(value: Date | NowValue, signal: AbortSignal): void {
  setMockedNow(value instanceof Date ? value.getTime() : value, signal);
}
