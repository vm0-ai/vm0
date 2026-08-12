export function now(): number {
  return Date.now();
}

export function nowDate(): Date {
  return new Date(now());
}
