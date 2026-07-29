import { now } from "../../lib/time.ts";
import { i18n } from "../../i18n/index.ts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

interface SubscriptionUsageResetFormat {
  readonly absoluteResetText: string;
  readonly absoluteText: string;
  readonly relativeText: string;
  readonly tooltipTitle: string;
}

interface InvalidSubscriptionUsageResetFormat {
  readonly fallbackText: string;
}

type SubscriptionUsageResetDisplay =
  | InvalidSubscriptionUsageResetFormat
  | SubscriptionUsageResetFormat;

export function formatSubscriptionUsageReset(
  resetAt: string | null,
  localized = false,
): SubscriptionUsageResetDisplay | null {
  const text = resetAt?.trim();
  if (!text) {
    return null;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return {
      fallbackText: localized
        ? i18n.t(
            ($) => {
              return $.settings.models.usage.resetsRaw;
            },
            { value: text },
          )
        : `resets ${text}`,
    };
  }

  const absoluteText = formatAbsoluteResetDate(date, localized);
  const relativeText = formatRelativeResetTime(
    date.getTime() - now(),
    localized,
  );

  return {
    absoluteResetText: localized
      ? i18n.t(
          ($) => {
            return $.settings.models.usage.resetsAt;
          },
          { date: absoluteText },
        )
      : `resets ${absoluteText}`,
    absoluteText,
    relativeText,
    tooltipTitle: formatResetTooltipTitle(relativeText, localized),
  };
}

function formatAbsoluteResetDate(date: Date, localized: boolean): string {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  const browserTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (browserTimeZone) {
    options.timeZone = browserTimeZone;
  }
  return date.toLocaleDateString(
    localized ? (i18n.resolvedLanguage ?? i18n.language) : "en-US",
    options,
  );
}

function resetTimePassed(localized: boolean): string {
  return localized
    ? i18n.t(($) => {
        return $.settings.models.usage.resetTimePassed;
      })
    : "reset time passed";
}

function formatResetTooltipTitle(
  relativeText: string,
  localized: boolean,
): string {
  if (!localized) {
    return relativeText === "reset time passed"
      ? "Reset time passed"
      : `Resets ${relativeText}`;
  }
  if (relativeText === resetTimePassed(true)) {
    return i18n.t(($) => {
      return $.settings.models.usage.resetTimePassedTitle;
    });
  }
  return i18n.t(
    ($) => {
      return $.settings.models.usage.resetsRelative;
    },
    { relative: relativeText },
  );
}

function formatRelativeResetTime(
  remainingMs: number,
  localized: boolean,
): string {
  if (remainingMs <= 0) {
    return resetTimePassed(localized);
  }
  if (remainingMs < MINUTE_MS) {
    return localized
      ? i18n.t(($) => {
          return $.settings.models.usage.inLessThanMinute;
        })
      : "in <1m";
  }

  const totalMinutes = Math.floor(remainingMs / MINUTE_MS);
  if (remainingMs < HOUR_MS) {
    return localized
      ? i18n.t(
          ($) => {
            return $.settings.models.usage.inMinutes;
          },
          { minutes: totalMinutes },
        )
      : `in ${totalMinutes}m`;
  }

  const totalHours = Math.floor(remainingMs / HOUR_MS);
  if (remainingMs < DAY_MS) {
    const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
    if (minutes > 0) {
      return localized
        ? i18n.t(
            ($) => {
              return $.settings.models.usage.inHoursMinutes;
            },
            { hours: totalHours, minutes },
          )
        : `in ${totalHours}h ${minutes}m`;
    }
    return localized
      ? i18n.t(
          ($) => {
            return $.settings.models.usage.inHours;
          },
          { hours: totalHours },
        )
      : `in ${totalHours}h`;
  }

  const totalDays = Math.floor(remainingMs / DAY_MS);
  if (remainingMs < WEEK_MS) {
    const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
    if (hours > 0) {
      return localized
        ? i18n.t(
            ($) => {
              return $.settings.models.usage.inDaysHours;
            },
            { days: totalDays, hours },
          )
        : `in ${totalDays}d ${hours}h`;
    }
  }

  return localized
    ? i18n.t(
        ($) => {
          return $.settings.models.usage.inDays;
        },
        { days: totalDays },
      )
    : `in ${totalDays}d`;
}
