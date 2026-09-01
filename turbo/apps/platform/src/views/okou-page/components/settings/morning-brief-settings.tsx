import { Button } from "@okouai/ui/components/ui/button";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Loader2, RotateCcw, Sunrise } from "lucide-react";
import { useTranslation } from "react-i18next";

import { currentLocale } from "../../../../i18n/index.ts";
import {
  morningBriefPreference$,
  morningBriefPreferenceCardRef$,
  retryMorningBriefPreference$,
  updateMorningBriefPreference$,
  type MorningBriefPreferenceState,
} from "../../../../signals/okou-page/settings/preferences-page.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

function nextEmailText(
  state: MorningBriefPreferenceState,
  format: (date: string, timezone: string) => string,
): string | null {
  if (
    state.kind !== "ready" ||
    !state.preference.enabled ||
    !state.preference.nextRunAt ||
    !state.preference.timezone
  ) {
    return null;
  }
  return format(state.preference.nextRunAt, state.preference.timezone);
}

function MorningBriefStatus({
  state,
  loading,
  loadFailed,
  mutationFailed,
}: {
  readonly state: MorningBriefPreferenceState | undefined;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly mutationFailed: boolean;
}) {
  const { t } = useTranslation();
  const unavailable =
    state?.kind === "ready" ? state.preference.unavailableReason : null;
  const conflicted = state?.kind === "error";
  const nextEmail = state
    ? nextEmailText(state, (date, timezone) => {
        const formatted = new Intl.DateTimeFormat(currentLocale(), {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: timezone,
        }).format(new Date(date));
        return t(
          ($) => {
            return $.settings.preferences.morningBrief.nextEmail;
          },
          { date: formatted, timezone },
        );
      })
    : null;

  let status = nextEmail;
  if (loading) {
    status = t(($) => {
      return $.settings.preferences.morningBrief.loading;
    });
  } else if (loadFailed || mutationFailed) {
    status = t(($) => {
      return $.settings.preferences.morningBrief.retryMessage;
    });
  } else if (state?.kind === "error") {
    status =
      state.code === "MORNING_BRIEF_MULTIPLE_INSTALLATIONS"
        ? t(($) => {
            return $.settings.preferences.morningBrief.multipleInstallations;
          })
        : t(($) => {
            return $.settings.preferences.morningBrief.conflict;
          });
  } else if (unavailable === "missing-timezone") {
    status = t(($) => {
      return $.settings.preferences.morningBrief.missingTimezone;
    });
  } else if (unavailable === "missing-default-agent") {
    status = t(($) => {
      return $.settings.preferences.morningBrief.missingDefaultAgent;
    });
  }

  if (!status) {
    return null;
  }
  const showAlert =
    loadFailed || mutationFailed || conflicted || unavailable !== null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {showAlert && <AlertCircle className="size-3.5 shrink-0" />}
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      <span>{status}</span>
    </div>
  );
}

export function MorningBriefSettings() {
  const { t } = useTranslation();
  const preferenceLoadable = useLoadable(morningBriefPreference$);
  const [mutationLoadable, updatePreference] = useLoadableSet(
    updateMorningBriefPreference$,
  );
  const retryPreference = useSet(retryMorningBriefPreference$);
  const cardRef = useSet(morningBriefPreferenceCardRef$);
  const pageSignal = useGet(pageSignal$);
  const state =
    preferenceLoadable.state === "hasData"
      ? preferenceLoadable.data
      : undefined;
  const preference = state?.kind === "ready" ? state.preference : undefined;
  const loading = preferenceLoadable.state === "loading";
  const mutating = mutationLoadable.state === "loading";
  const loadFailed = preferenceLoadable.state === "hasError";
  const mutationFailed = mutationLoadable.state === "hasError";
  const unavailable = preference?.unavailableReason ?? null;
  const conflicted = state?.kind === "error";
  const enabled = preference?.enabled ?? false;

  const handleToggle = (checked: boolean) => {
    detach(updatePreference(checked, pageSignal), Reason.DomCallback);
  };

  const handleRetry = () => {
    if (mutationFailed && preference) {
      detach(
        updatePreference(!preference.enabled, pageSignal),
        Reason.DomCallback,
      );
      return;
    }
    retryPreference();
  };

  const showRetry = loadFailed || mutationFailed || conflicted;

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-testid="morning-brief-preference"
      className="flex flex-col gap-3 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-col gap-3 bg-card p-4 rounded-xl zero-border sm:flex-row sm:items-center sm:gap-4">
        <div className="flex flex-1 items-center gap-4 min-w-0">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Sunrise size={22} className="text-muted-foreground" />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1 min-w-0">
            <div className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.settings.preferences.morningBrief.title;
              })}
            </div>
            <div className="text-sm text-muted-foreground">
              {t(($) => {
                return $.settings.preferences.morningBrief.description;
              })}
            </div>
            <MorningBriefStatus
              state={state}
              loading={loading}
              loadFailed={loadFailed}
              mutationFailed={mutationFailed}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showRetry && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              disabled={loading || mutating}
            >
              <RotateCcw />
              {t(($) => {
                return $.settings.preferences.morningBrief.retry;
              })}
            </Button>
          )}
          <Switch
            aria-label={t(($) => {
              return $.settings.preferences.morningBrief.title;
            })}
            checked={enabled}
            onCheckedChange={handleToggle}
            disabled={
              loading ||
              mutating ||
              loadFailed ||
              conflicted ||
              unavailable !== null ||
              preference === undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
