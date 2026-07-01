import { useLastLoadable, useLastResolved, useSet } from "ccstate-react";
import { IconRefresh } from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
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

import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { reloadPersonalModelProviders$ } from "../../signals/external/personal-model-providers.ts";
import { personalConfiguredProviders$ } from "../../signals/zero-page/settings/personal-model-providers.ts";
import { detach, Reason } from "../../signals/utils.ts";

type SubscriptionUsage = NonNullable<
  ModelProviderResponse["subscriptionUsage"]
>;
type SubscriptionUsageWindow = NonNullable<SubscriptionUsage["fiveHour"]>;

const SIDEBAR_SUBSCRIPTION_PROVIDERS = [
  { type: "codex-oauth-token", label: "Codex" },
  { type: "claude-code-oauth-token", label: "Claude Code" },
] as const satisfies readonly {
  readonly type: ModelProviderType;
  readonly label: string;
}[];

export function SidebarSubscriptionsGate() {
  const features = useLastResolved(featureSwitch$);

  if (!features?.[FeatureSwitchKey.SidebarSubscriptionUsage]) {
    return null;
  }

  return <SidebarSubscriptionsPanel />;
}

function SidebarSubscriptionsPanel() {
  const providersLoadable = useLastLoadable(personalConfiguredProviders$);
  const refreshSubscriptions = useSet(reloadPersonalModelProviders$);
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  const rows = sidebarSubscriptionRows(providers);
  const loading = providersLoadable.state === "loading";

  if (!loading && rows.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="sidebar-subscriptions"
      className="mt-1 rounded-xl border border-border/60 bg-sidebar-accent/25 px-2.5 py-2"
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h3 className="truncate text-[11px] font-semibold leading-4 text-sidebar-foreground/70">
          Subscriptions
        </h3>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:cursor-default disabled:opacity-60"
                aria-label="Refresh subscriptions"
                disabled={loading}
                onClick={() => {
                  detach(
                    refreshSubscriptions(),
                    Reason.DomCallback,
                    "refresh sidebar subscriptions",
                  );
                }}
              >
                <IconRefresh
                  size={13}
                  className={loading ? "animate-spin" : undefined}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p className="text-xs">Refresh subscriptions</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {loading && rows.length === 0 ? (
        <SidebarSubscriptionsSkeleton />
      ) : (
        <TooltipProvider delayDuration={100}>
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => {
              return (
                <SidebarSubscriptionProviderRow
                  key={row.type}
                  label={row.label}
                  usage={row.usage}
                />
              );
            })}
          </div>
        </TooltipProvider>
      )}
    </section>
  );
}

function SidebarSubscriptionsSkeleton() {
  return (
    <div className="flex flex-col gap-1.5" aria-hidden="true">
      {SIDEBAR_SUBSCRIPTION_PROVIDERS.map((provider) => {
        return (
          <div
            key={provider.type}
            className="rounded-lg border border-border/35 bg-background/55 px-2 py-1.5"
          >
            <div className="h-3 w-20 animate-pulse rounded bg-sidebar-foreground/10" />
            <div className="mt-2 space-y-1.5">
              <div className="h-1.5 animate-pulse rounded-full bg-sidebar-foreground/10" />
              <div className="h-1.5 animate-pulse rounded-full bg-sidebar-foreground/10" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SidebarSubscriptionProviderRow({
  label,
  usage,
}: {
  readonly label: string;
  readonly usage: SubscriptionUsage;
}) {
  const windows = usageWindows(usage);

  return (
    <div className="rounded-lg border border-border/40 bg-background/65 px-2 py-1.5">
      <div className="mb-1.5 truncate text-[12px] font-medium leading-4 text-sidebar-foreground">
        {label}
      </div>
      <div className="flex flex-col gap-1.5">
        {windows.map(({ label: windowLabel, window }) => {
          return (
            <SidebarSubscriptionUsageBar
              key={windowLabel}
              providerLabel={label}
              label={windowLabel}
              window={window}
            />
          );
        })}
      </div>
    </div>
  );
}

function SidebarSubscriptionUsageBar({
  providerLabel,
  label,
  window,
}: {
  readonly providerLabel: string;
  readonly label: string;
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
    <div className="grid grid-cols-[28px_minmax(0,1fr)_34px] items-center gap-1.5">
      <span className="text-[10px] font-medium leading-none text-sidebar-foreground/55">
        {label}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            role="progressbar"
            aria-label={`${providerLabel} ${label} remaining`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={remainingPercent ?? undefined}
            className={`block h-1.5 min-w-0 overflow-hidden rounded-full outline-none ring-offset-1 ring-offset-sidebar transition-shadow focus-visible:ring-2 focus-visible:ring-ring ${tone.trackClassName}`}
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

function sidebarSubscriptionRows(providers: readonly ModelProviderResponse[]) {
  return SIDEBAR_SUBSCRIPTION_PROVIDERS.flatMap((definition) => {
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
    { label: "Week", window: usage?.weekly ?? null },
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
