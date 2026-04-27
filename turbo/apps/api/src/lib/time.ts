let mockedNow: number | undefined;

export function now(): number {
  return mockedNow ?? Date.now();
}

export function nowDate(): Date {
  return new Date(now());
}

export function mockNow(value: Date | number): void {
  mockedNow = value instanceof Date ? value.getTime() : value;
}

export function clearMockNow(): void {
  mockedNow = undefined;
}
