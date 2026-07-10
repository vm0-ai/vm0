import { testOverride } from "./singleton";

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

export function timestampWithoutTimeZone(value: Date): string {
  // Raw SQL Date params compare as timestamptz; project timestamp columns store
  // UTC wall-clock values without timezone metadata.
  return value.toISOString().replace("T", " ").replace("Z", "");
}

export function mockNow(value: Date | number): void {
  setMockedNow(value instanceof Date ? value.getTime() : value);
}

export function clearMockNow(): void {
  clearMockedNow();
}
