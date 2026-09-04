import { mockNow as mockPlatformNow } from "../lib/time.ts";

export function dateFromIso(value: string): Date {
  return new Date(value);
}

export function isoFromOffset(value: Date | number, offsetMs: number): string {
  const timestamp = value instanceof Date ? value.getTime() : value;
  return new Date(timestamp + offsetMs).toISOString();
}

export function unixSecondsFromIso(value: string): number {
  return dateFromIso(value).getTime() / 1000;
}

export function mockNow(value: Date | number, signal: AbortSignal): void {
  mockPlatformNow(value, signal);
}
