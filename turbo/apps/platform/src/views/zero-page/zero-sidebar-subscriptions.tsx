import { useGet, useLoadable } from "ccstate-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";

import {
  ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS,
  accountMenuSubscriptionUsageRowsRefreshPromise$,
  accountMenuSubscriptionUsageRowsCache$,
  accountMenuSubscriptionUsageWindows,
  type AccountMenuSubscriptionUsage,
  type AccountMenuSubscriptionUsageRow,
  type AccountMenuSubscriptionUsageWindow,
  type AccountMenuSubscriptionUsageRowsCacheKey,
} from "../../signals/zero-page/account-menu-subscriptions.ts";

type SubscriptionUsage = AccountMenuSubscriptionUsage;
type SubscriptionUsageWindow = AccountMenuSubscriptionUsageWindow;

export function useSubscriptionUsageRows({
  cacheKey,
}: {
  readonly cacheKey: AccountMenuSubscriptionUsageRowsCacheKey;
}) {
  const rowsCache = useGet(accountMenuSubscriptionUsageRowsCache$);
  const refreshLoadable = useLoadable(
    accountMenuSubscriptionUsageRowsRefreshPromise$,
  );
  const cachedRows =
    cacheKey !== null && rowsCache.key === cacheKey ? rowsCache.rows : null;
  const hasCachedRows = cachedRows !== null;
  const loading = refreshLoadable.state === "loading" && !hasCachedRows;
  const rows = cachedRows ?? [];

  return { loading, rows };
}

export function AccountMenuSubscriptionsPanel({
  loading,
  rows,
}: {
  readonly loading: boolean;
  readonly rows: readonly AccountMenuSubscriptionUsageRow[];
}) {
  return (
    <div data-testid="account-menu-subscriptions" className="px-3 py-2.5">
      {loading && rows.length === 0 ? (
        <AccountMenuSubscriptionsSkeleton />
      ) : (
        <TooltipProvider delayDuration={100}>
          <div className="flex flex-col gap-2.5">
            {rows.map((row, index) => {
              return (
                <AccountMenuSubscriptionProviderSection
                  key={row.type}
                  divided={index > 0}
                  label={row.label}
                  usage={row.usage}
                />
              );
            })}
          </div>
        </TooltipProvider>
      )}
    </div>
  );
}

function AccountMenuSubscriptionsSkeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden="true">
      {ACCOUNT_MENU_SUBSCRIPTION_PROVIDERS.map((provider, index) => {
        return (
          <div key={provider.type} className="flex flex-col gap-1.5">
            {index > 0 && <div className="-mx-3 h-px bg-border" />}
            <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
            {["5h", "week"].map((label) => {
              return (
                <div
                  key={label}
                  className="grid grid-cols-[34px_minmax(0,1fr)_34px] items-center gap-1.5"
                >
                  <div className="h-2.5 animate-pulse rounded bg-muted/60" />
                  <div className="h-1.5 animate-pulse rounded-full bg-muted/60" />
                  <div className="h-2.5 animate-pulse rounded bg-muted/60" />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function AccountMenuSubscriptionProviderSection({
  divided,
  label,
  usage,
}: {
  readonly divided: boolean;
  readonly label: string;
  readonly usage: SubscriptionUsage;
}) {
  const windows = accountMenuSubscriptionUsageWindows(usage);

  return (
    <section className="flex flex-col gap-1.5" aria-label={`${label} usage`}>
      {divided && <div className="-mx-3 h-px bg-border" />}
      <h3 className="truncate text-xs font-medium leading-4 text-foreground">
        {label}
      </h3>
      <div className="flex flex-col gap-1">
        {windows.map(({ label: windowLabel, window }) => {
          return (
            <AccountMenuSubscriptionUsageBar
              key={windowLabel}
              providerLabel={label}
              windowLabel={windowLabel}
              window={window}
            />
          );
        })}
      </div>
    </section>
  );
}

function AccountMenuSubscriptionUsageBar({
  providerLabel,
  windowLabel,
  window,
}: {
  readonly providerLabel: string;
  readonly windowLabel: string;
  readonly window: SubscriptionUsageWindow;
}) {
  const rawRemainingPercent =
    window.remainingPercent ??
    (window.usedPercent === null ? null : 100 - window.usedPercent);
  const remainingPercent =
    rawRemainingPercent !== null && Number.isFinite(rawRemainingPercent)
      ? rawRemainingPercent
      : null;
  const displayPercent = formatUsagePercent(remainingPercent);
  const resetText = formatUsageReset(window.resetAt);
  const tone = usageTone(remainingPercent);
  const width =
    remainingPercent === null
      ? 0
      : Math.min(100, Math.max(0, remainingPercent));

  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)_34px] items-center gap-1.5">
      <span className="truncate text-[10px] font-medium leading-none text-muted-foreground">
        {windowLabel}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="progressbar"
            aria-label={`${providerLabel} ${windowLabel} remaining`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remainingPercent ?? undefined}
            className={`block h-1.5 min-w-0 overflow-hidden rounded-full outline-none ring-offset-1 ring-offset-popover transition-shadow focus-visible:ring-2 focus-visible:ring-ring ${tone.trackClassName}`}
          >
            <span
              className={`block h-full rounded-full transition-[width] ${tone.barClassName}`}
              style={{ width: `${width}%` }}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" align="center">
          <p className="text-xs">{resetText ?? "Reset time unavailable"}</p>
        </TooltipContent>
      </Tooltip>
      <span
        className={`text-right text-[10px] font-medium leading-none ${tone.textClassName}`}
      >
        {displayPercent ?? "--"}
      </span>
    </div>
  );
}

function formatUsagePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatUsageReset(resetAt: string | null): string | null {
  const text = resetAt?.trim();
  if (!text) {
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return `resets ${text}`;
  }
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
  return `resets ${date.toLocaleDateString("en-US", options)}`;
}

function usageTone(remainingPercent: number | null): {
  readonly barClassName: string;
  readonly textClassName: string;
  readonly trackClassName: string;
} {
  if (remainingPercent !== null && remainingPercent < 20) {
    return {
      barClassName: "bg-red-500",
      textClassName: "text-red-600 dark:text-red-400",
      trackClassName: "bg-red-500/15",
    };
  }
  if (remainingPercent !== null && remainingPercent < 50) {
    return {
      barClassName: "bg-amber-500",
      textClassName: "text-amber-600 dark:text-amber-400",
      trackClassName: "bg-amber-500/15",
    };
  }
  return {
    barClassName: "bg-emerald-500",
    textClassName: "text-emerald-600 dark:text-emerald-400",
    trackClassName: "bg-emerald-500/15",
  };
}
