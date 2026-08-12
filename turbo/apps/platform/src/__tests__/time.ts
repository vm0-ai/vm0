import { vi } from "vitest";

const FIXED_NOW_ISO = "2026-06-11T16:00:00.000Z";

export function dateFromIso(value: string): Date {
  return new Date(value);
}

export function nowDate(): Date {
  return dateFromIso(FIXED_NOW_ISO);
}

function now(): number {
  return nowDate().getTime();
}

function dateFromMs(value: number): Date {
  return new Date(value);
}

export function nowIso(): string {
  return nowDate().toISOString();
}

export function isoFromNowMs(offsetMs: number): string {
  return dateFromMs(now() + offsetMs).toISOString();
}

export function unixSecondsFromIso(value: string): number {
  return dateFromIso(value).getTime() / 1000;
}

export function mockNow(value: Date | number = now()): void {
  vi.spyOn(Date, "now").mockReturnValue(
    value instanceof Date ? value.getTime() : value,
  );
}
