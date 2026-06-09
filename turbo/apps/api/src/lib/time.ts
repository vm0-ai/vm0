import { testOverride } from "./singleton";

const { get: getMockedNow, clear: clearMockedNow } = testOverride<
  number | undefined
>(() => {
  return undefined;
});

export function now(): number {
  return getMockedNow() ?? Date.now();
}

export function nowDate(): Date {
  return new Date(now());
}

export function clearMockNow(): void {
  clearMockedNow();
}
