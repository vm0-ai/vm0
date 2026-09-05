import { mockNow as mockPlatformNow } from "../lib/time.ts";

function dateFromIso(value: string): Date {
  return new Date(value);
}

export function unixSecondsFromIso(value: string): number {
  return dateFromIso(value).getTime() / 1000;
}

export function mockNow(value: Date | number, signal: AbortSignal): void {
  mockPlatformNow(value, signal);
}
