const EXPLICIT_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/u;

function hasExplicitAtTimeOffset(atTime: string): boolean {
  return EXPLICIT_OFFSET_RE.test(atTime.trim());
}

export function requireTimezoneForLocalAtTime(
  atTime: string,
  timezone: string | undefined,
  flagName: "--at" | "--once",
): void {
  if (timezone || hasExplicitAtTimeOffset(atTime)) {
    return;
  }
  throw new Error(
    `${flagName} without Z or an explicit offset requires --timezone (e.g. ${flagName} "2026-06-10T09:00" --timezone Asia/Shanghai)`,
  );
}
