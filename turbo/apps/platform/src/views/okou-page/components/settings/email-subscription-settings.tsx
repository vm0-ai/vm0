import { Button } from "@okouai/ui/components/ui/button";
import { Switch } from "@okouai/ui/components/ui/switch";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { AlertCircle, Loader2, Mail, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  emailSubscription$,
  retryEmailSubscription$,
  updateEmailSubscription$,
} from "../../../../signals/okou-page/settings/email-subscription.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { PreferenceCardRow } from "./preference-card-row.tsx";

export function EmailSubscriptionSettings() {
  const { t } = useTranslation();
  const loadable = useLoadable(emailSubscription$);
  const preference = useLastResolved(emailSubscription$);
  const [mutation, update] = useLoadableSet(updateEmailSubscription$);
  const reload = useSet(retryEmailSubscription$);
  const pageSignal = useGet(pageSignal$);
  const loading = loadable.state === "loading";
  const saving = mutation.state === "loading";
  const loadFailed = loadable.state === "hasError";
  const saveFailed = mutation.state === "hasError";
  const deliveryUnavailable = preference?.deliveryStatus !== "available";

  let status = preference?.subscribed
    ? t(($) => {
        return $.settings.preferences.emailSubscription.subscribed;
      })
    : t(($) => {
        return $.settings.preferences.emailSubscription.unsubscribed;
      });
  if (loading) {
    status = t(($) => {
      return $.settings.preferences.emailSubscription.loading;
    });
  } else if (saving) {
    status = t(($) => {
      return $.settings.preferences.emailSubscription.saving;
    });
  } else if (loadFailed || saveFailed) {
    status = t(($) => {
      return $.settings.preferences.emailSubscription.retryMessage;
    });
  } else if (deliveryUnavailable) {
    status = t(($) => {
      return $.settings.preferences.emailSubscription.unavailable;
    });
  }

  const handleToggle = (subscribed: boolean) => {
    detach(update(subscribed, pageSignal), Reason.DomCallback);
  };
  const handleRetry = () => {
    if (saveFailed && preference && !loadFailed) {
      handleToggle(!preference.subscribed);
    } else {
      reload();
    }
  };

  return (
    <PreferenceCardRow
      icon={Mail}
      title={t(($) => {
        return $.settings.preferences.emailSubscription.title;
      })}
      description={t(($) => {
        return $.settings.preferences.emailSubscription.description;
      })}
      status={
        <div
          className="flex flex-col gap-1 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {preference?.email && (
            <span className="break-all">{preference.email}</span>
          )}
          <div className="flex items-center gap-1.5">
            {(loading || saving) && (
              <Loader2 className="size-3.5 animate-spin" />
            )}
            {(loadFailed ||
              saveFailed ||
              (preference && deliveryUnavailable)) && (
              <AlertCircle className="size-3.5 shrink-0" />
            )}
            <span>{status}</span>
          </div>
          {!loading && !loadFailed && deliveryUnavailable && preference && (
            <span>
              {t(($) => {
                return $.settings.preferences.emailSubscription
                  .unavailableDescription;
              })}
            </span>
          )}
        </div>
      }
    >
      <div className="flex shrink-0 items-center gap-2">
        {(loadFailed || saveFailed) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRetry}
            disabled={loading || saving}
          >
            <RotateCcw />
            {t(($) => {
              return $.settings.preferences.morningBrief.retry;
            })}
          </Button>
        )}
        {preference ? (
          <Switch
            aria-label={t(($) => {
              return $.settings.preferences.emailSubscription.title;
            })}
            checked={preference.subscribed}
            disabled={loading || saving || loadFailed}
            onCheckedChange={handleToggle}
          />
        ) : (
          <div className="h-6 w-11 rounded-full bg-muted" aria-hidden="true" />
        )}
      </div>
    </PreferenceCardRow>
  );
}
