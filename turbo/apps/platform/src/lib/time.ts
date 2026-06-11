function testOverride<T>(factory: () => T): {
  readonly get: () => T;
  readonly set: (value: T) => void;
  readonly clear: () => void;
} {
  let init = factory();

  return {
    get: () => {
      return init;
    },
    set: (value: T) => {
      init = value;
    },
    clear: () => {
      init = factory();
    },
  };
}

const {
  get: getMockedNow,
  set: setMockedNow,
  clear: clearMockedNow,
} = testOverride<number | undefined>(() => {
  return undefined;
});

export function now(): number {
  return getMockedNow() ?? Date.now();
}

export function nowDate(): Date {
  return new Date(now());
}

export function mockNow(value: Date | number): void {
  setMockedNow(value instanceof Date ? value.getTime() : value);
}

export function clearMockNow(): void {
  clearMockedNow();
}
