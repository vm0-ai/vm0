export { mockNow } from "../lib/time.ts";

export function unixSecondsFromIso(value: string): number {
  return new Date(value).getTime() / 1000;
}
