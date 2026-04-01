// ---------------------------------------------------------------------------
// Shared schedule types and calendar utilities
// ---------------------------------------------------------------------------

export const WEEKDAY_LABELS = [
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
  "Sun",
] as const;

const CALENDAR_TIME_SLOTS = [
  "6:00 AM",
  "9:00 AM",
  "12:00 PM",
  "6:00 PM",
] as const;

export interface ScheduleEntry {
  id: string;
  time: string;
  prompt: string;
  description?: string | null;
  /** Schedule name used for API operations (edit/delete). */
  name?: string;
  enabled?: boolean;
  /** IANA timezone from the server (not derivable from `time` alone). */
  timezone?: string;
  /** Raw interval in seconds for loop schedules */
  intervalSeconds?: number | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseScheduleTime(timeStr: string): {
  dayIndices: number[];
  timeLabel: string;
} {
  if (timeStr.match(/Every \d+ (minutes?|seconds?)/) || timeStr === "Now") {
    return { dayIndices: [], timeLabel: "" };
  }
  const match = timeStr.match(/at (\d{1,2}:\d{2} (?:AM|PM))$/);
  const timeLabel = match ? match[1] : "9:00 AM";
  if (timeStr.startsWith("Every day") && !timeStr.startsWith("Every weekday")) {
    return { dayIndices: [0, 1, 2, 3, 4, 5, 6], timeLabel };
  }
  if (timeStr.startsWith("Every weekday")) {
    return { dayIndices: [0, 1, 2, 3, 4], timeLabel };
  }
  const dayMap: Record<string, number> = {
    Monday: 0,
    Tuesday: 1,
    Wednesday: 2,
    Thursday: 3,
    Friday: 4,
    Saturday: 5,
    Sunday: 6,
  };
  const onMatch = timeStr.match(
    /on ((?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:,\s*)?)+) at/,
  );
  if (onMatch) {
    const names = onMatch[1].split(/,\s*/);
    const indices = names
      .map((n) => {
        return dayMap[n] ?? -1;
      })
      .filter((i) => {
        return i >= 0;
      });
    if (indices.length > 0) {
      return { dayIndices: indices, timeLabel };
    }
  }
  if (timeStr.startsWith("Every week")) {
    return { dayIndices: [0, 1, 2, 3, 4, 5, 6], timeLabel };
  }
  if (timeStr.startsWith("Every month")) {
    return { dayIndices: [], timeLabel: "" };
  }
  return { dayIndices: [], timeLabel };
}

/**
 * Convert a time label like "9:00 AM" to minutes since midnight.
 */
function timeLabelToMinutes(label: string): number {
  const match = label.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!match) {
    return 0;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const ampm = match[3];
  if (ampm === "PM" && hour !== 12) {
    hour += 12;
  }
  if (ampm === "AM" && hour === 12) {
    hour = 0;
  }
  return hour * 60 + minute;
}

// ---------------------------------------------------------------------------
// Exported calendar utilities
// ---------------------------------------------------------------------------

/**
 * Build the calendar time slots by merging default slots with entry-specific times,
 * sorted chronologically.
 */
export function buildCalendarTimeSlots(
  scheduleList: readonly Readonly<ScheduleEntry>[],
): string[] {
  const slotSet = new Set<string>(CALENDAR_TIME_SLOTS);
  for (const entry of scheduleList) {
    if (entry.enabled === false) {
      continue;
    }
    const { timeLabel } = parseScheduleTime(entry.time);
    if (timeLabel) {
      slotSet.add(timeLabel);
    }
  }
  return [...slotSet].sort((a, b) => {
    return timeLabelToMinutes(a) - timeLabelToMinutes(b);
  });
}

export function getEntriesInCell(
  scheduleList: ScheduleEntry[],
  dayIndex: number,
  timeLabel: string,
): ScheduleEntry[] {
  return scheduleList.filter((entry) => {
    if (entry.enabled === false) {
      return false;
    }
    const { dayIndices, timeLabel: t } = parseScheduleTime(entry.time);
    return t === timeLabel && dayIndices.includes(dayIndex);
  });
}
