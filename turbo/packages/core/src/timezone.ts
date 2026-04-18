const gmtOffsetCache = new Map<string, string>();

/**
 * Returns the GMT offset string for an IANA timezone (e.g. "GMT+05:30").
 * Result is cached per process lifetime since UTC offsets are stable for a
 * given timezone identifier.
 */
export function getGmtOffset(iana: string): string {
  const cached = gmtOffsetCache.get(iana);
  if (cached !== undefined) return cached;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: iana,
    timeZoneName: "longOffset",
  }).formatToParts(new Date());
  const offset =
    parts.find((p) => {
      return p.type === "timeZoneName";
    })?.value ?? "GMT+00:00";
  gmtOffsetCache.set(iana, offset);
  return offset;
}
