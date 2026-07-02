import { useLastLoadable } from "ccstate-react";
import type {
  ModelProviderResponse,
  ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";

import { personalConfiguredProviders$ } from "../../signals/zero-page/settings/personal-model-providers.ts";

type SubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
type SubscriptionUsageWindow = NonNullable<SubscriptionUsage["fiveHour"]>;

const SUBSCRIPTION_PROVIDERS = [
  { type: "codex-oauth-token", label: "Codex" },
  { type: "claude-code-oauth-token", label: "Claude Code" },
] as const satisfies readonly {
  readonly type: ModelProviderType;
  readonly label: string;
}[];

interface SubscriptionUsageRow {
  readonly type: ModelProviderType;
  readonly label: string;
  readonly usage: SubscriptionUsage;
}

export function useSubscriptionUsageRows() {
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const rows = subscriptionUsageRows(providers);
  const loading = providersLoadable.state === "loading";

  return { loading, rows };
}

export function AccountMenuSubscriptionsPanel({
  loading,
  rows,
}: {
  readonly loading: boolean;
  readonly rows: readonly SubscriptionUsageRow[];
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
      {SUBSCRIPTION_PROVIDERS.map((provider, index) => {
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
  const windows = usageWindows(usage);

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

function subscriptionUsageRows(
  providers: readonly ModelProviderResponse[],
): readonly SubscriptionUsageRow[] {
  return SUBSCRIPTION_PROVIDERS.flatMap((definition) => {
    const provider = providers.find((candidate) => {
      return candidate.type === definition.type;
    });
    if (!provider) {
      return [];
    }
    const usage = fallbackSubscriptionUsage(provider);
    if (!usage || usageWindows(usage).length === 0) {
      return [];
    }
    return [{ ...definition, usage }];
  });
}

function hasUsageWindow(
  window: SubscriptionUsage["fiveHour"],
): window is SubscriptionUsageWindow {
  return (
    window !== null &&
    (window.remainingPercent !== null ||
      window.usedPercent !== null ||
      window.resetAt !== null)
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

function fallbackSubscriptionUsage(
  provider: ModelProviderResponse,
): SubscriptionUsage | null {
  if (usageWindows(provider.subscriptionUsage).length > 0) {
    return provider.subscriptionUsage ?? null;
  }

  const resetAt = provider.subscriptionNextResetAt?.trim();
  if (!resetAt) {
    return null;
  }

  const resetPeriod = provider.subscriptionResetPeriod?.trim().toLowerCase();
  const window = {
    usedPercent: null,
    remainingPercent: null,
    resetAt,
    windowSeconds: resetPeriod?.includes("5") ? 18_000 : 604_800,
  };

  return resetPeriod?.includes("5")
    ? { fiveHour: window, weekly: null }
    : { fiveHour: null, weekly: window };
}

function usageWindows(usage: SubscriptionUsage | null | undefined): readonly {
  readonly label: string;
  readonly window: SubscriptionUsageWindow;
}[] {
  return [
    { label: "5h", window: usage?.fiveHour ?? null },
    { label: "week", window: usage?.weekly ?? null },
  ].filter(
    (item): item is { label: string; window: SubscriptionUsageWindow } => {
      return hasUsageWindow(item.window);
    },
  );
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
