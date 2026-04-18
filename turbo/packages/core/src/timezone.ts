/**
 * Returns the GMT offset string for an IANA timezone at the current instant
 * (e.g. "GMT+05:30"). Called at render time so DST transitions are reflected
 * correctly without stale cached values.
 */
export function getGmtOffset(iana: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: iana,
    timeZoneName: "longOffset",
  }).formatToParts(new Date());
  return (
    parts.find((p) => {
      return p.type === "timeZoneName";
    })?.value ?? "GMT+00:00"
  );
}
