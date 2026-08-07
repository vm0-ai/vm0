import { useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { OrgMember } from "@vm0/api-contracts/contracts/org-members";
import type { BillingStatusResponse } from "@vm0/api-contracts/contracts/zero-billing";
import type { MemberUsage } from "@vm0/api-contracts/contracts/zero-usage";
import { IconChevronRight } from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import { billingStatusAsync$ } from "../../../../signals/zero-page/billing.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import { formatLocalizedNumber } from "../../../../i18n/format.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function displayName(m: OrgMember): string {
  const parts = [m.firstName, m.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "";
}

// ---------------------------------------------------------------------------
// Credit breakdown bar chart
// ---------------------------------------------------------------------------

type CreditSegment = BillingStatusResponse["creditBreakdown"][number];

// Segment swatches map to theme tokens defined in
// `turbo/apps/platform/src/views/css/index.css` under `@theme`. Keep the
// mapping here purely symbolic so branding/dark-mode tweaks happen in CSS.
const CATEGORY_COLORS: Readonly<
  Record<Exclude<CreditSegment["category"], "plan">, string>
> = {
  free: "bg-credit-free",
  promotional: "bg-credit-promotional",
  payAsYouGo: "bg-credit-pay-as-you-go",
};

const PLAN_COLORS: Readonly<
  Record<NonNullable<CreditSegment["tier"]>, string>
> = {
  pro: "bg-credit-plan-pro",
  team: "bg-credit-plan-team",
};

function colorForSegment(seg: CreditSegment): string {
  if (seg.category === "plan") {
    return seg.tier ? PLAN_COLORS[seg.tier] : "bg-credit-plan-pro";
  }
  return CATEGORY_COLORS[seg.category];
}

function segmentKey(seg: CreditSegment): string {
  // `buildCreditBreakdown` keys segments by `category:tier`, so the same
  // composite is stable and unique across the array.
  return seg.tier ? `${seg.category}:${seg.tier}` : seg.category;
}

type CreditGrant = BillingStatusResponse["creditGrants"][number];
type UsageAllowance = NonNullable<BillingStatusResponse["usageAllowance"]>;
type UsageAllowanceWindow = UsageAllowance["windows"][number];

function descriptionForSegment(
  seg: CreditSegment,
  currentTier: string,
): string {
  if (seg.category === "free") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.freeDescription;
    });
  }
  if (seg.category === "promotional") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.promotionalDescription;
    });
  }
  if (seg.category === "payAsYouGo") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.payAsYouGoDescription;
    });
  }
  if (seg.tier === currentTier) {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.currentPlanDescription;
    });
  }
  return i18n.t(($) => {
    return $.billing.usage.breakdown.previousPlanDescription;
  });
}

function labelForSegment(seg: CreditSegment): string {
  if (currentLocale() === "en-US") {
    return seg.label;
  }
  if (seg.category === "plan") {
    return seg.tier === "team"
      ? i18n.t(($) => {
          return $.billing.usage.breakdown.teamPlan;
        })
      : i18n.t(($) => {
          return $.billing.usage.breakdown.proPlan;
        });
  }
  if (seg.category === "free") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.freePlan;
    });
  }
  if (seg.category === "promotional") {
    return i18n.t(($) => {
      return $.billing.usage.breakdown.promotional;
    });
  }
  return i18n.t(($) => {
    return $.billing.usage.breakdown.payAsYouGo;
  });
}

function formatCreditDate(value: string): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function expiresLabel(grant: CreditGrant): string {
  if (grant.source === "auto_recharge") {
    return i18n.t(($) => {
      return $.billing.usage.neverExpires;
    });
  }
  return i18n.t(
    ($) => {
      return $.billing.usage.expires;
    },
    { date: formatCreditDate(grant.expiresAt) },
  );
}

function allowanceRemainingPercent(window: UsageAllowanceWindow): number {
  if (window.unitLimit <= 0) {
    return 0;
  }
  return (window.remainingUnits / window.unitLimit) * 100;
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

function formatAllowanceWindowLabel(window: UsageAllowanceWindow): string {
  if (window.kind === "weekly" || window.windowSeconds % 604_800 === 0) {
    const weeks = Math.max(1, window.windowSeconds / 604_800);
    return i18n.t(
      ($) => {
        return $.billing.usage.allowance.week;
      },
      { value: formatLocalizedNumber(weeks) },
    );
  }
  if (window.windowSeconds % 86_400 === 0) {
    return i18n.t(
      ($) => {
        return $.billing.usage.allowance.day;
      },
      { value: formatLocalizedNumber(window.windowSeconds / 86_400) },
    );
  }
  if (window.windowSeconds % 3600 === 0) {
    return i18n.t(
      ($) => {
        return $.billing.usage.allowance.hour;
      },
      { value: formatLocalizedNumber(window.windowSeconds / 3600) },
    );
  }
  if (window.windowSeconds % 60 === 0) {
    return i18n.t(
      ($) => {
        return $.billing.usage.allowance.minute;
      },
      { value: formatLocalizedNumber(window.windowSeconds / 60) },
    );
  }
  return window.kind;
}

function formatAllowanceReset(window: UsageAllowanceWindow): string {
  const text = window.expiresAt?.trim();
  if (!text) {
    return "";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return i18n.t(
      ($) => {
        return $.billing.usage.allowance.resetsRaw;
      },
      { value: text },
    );
  }
  const formatted = new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
  return i18n.t(
    ($) => {
      return $.billing.usage.allowance.resets;
    },
    { date: formatted },
  );
}

function UsageAllowanceWindowRow({ window }: { window: UsageAllowanceWindow }) {
  const { t } = useTranslation();
  const remainingPercent = allowanceRemainingPercent(window);
  const tone = usageTone(remainingPercent);
  const label = formatAllowanceWindowLabel(window);
  const width = Math.min(100, Math.max(0, remainingPercent));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {formatAllowanceReset(window)}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs font-medium tabular-nums text-muted-foreground">
          {t(
            ($) => {
              return $.billing.usage.allowance.remaining;
            },
            {
              remaining: formatLocalizedNumber(window.remainingUnits),
              total: formatLocalizedNumber(window.unitLimit),
            },
          )}
        </div>
      </div>
      <div
        role="progressbar"
        aria-label={t(
          ($) => {
            return $.billing.usage.allowance.remainingAria;
          },
          { label },
        )}
        aria-valuemin={0}
        aria-valuemax={window.unitLimit}
        aria-valuenow={window.remainingUnits}
        className={`h-2.5 overflow-hidden rounded-full ${tone.trackClassName}`}
      >
        <span
          className={`block h-full rounded-full transition-[width] ${tone.barClassName}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function UsageAllowanceCard({
  allowance,
}: {
  allowance: UsageAllowance | null | undefined;
}) {
  const { t } = useTranslation();
  const windows = allowance?.windows.filter((window) => {
    return window.unitLimit > 0;
  });
  if (!windows || windows.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="usage-allowance-section"
      className="overflow-hidden rounded-xl bg-card px-5 py-4 zero-border"
    >
      <p className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.billing.usage.allowance.title;
        })}
      </p>
      <div className="mt-3 flex flex-col gap-4">
        {windows.map((window) => {
          return <UsageAllowanceWindowRow key={window.kind} window={window} />;
        })}
      </div>
    </div>
  );
}

function CreditGrantRow({ grant }: { grant: CreditGrant }) {
  const { t } = useTranslation();
  const hasPartialBalance = grant.remaining !== grant.amount;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          tabIndex={0}
          data-testid={`credit-grant-${grant.id}`}
          className="flex min-w-0 cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">
              {grant.label}
            </div>
            <div className="text-xs text-muted-foreground">
              {t(
                ($) => {
                  return $.billing.usage.added;
                },
                { date: formatCreditDate(grant.createdAt) },
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[13px] font-medium tabular-nums text-foreground">
              {formatLocalizedNumber(grant.amount)}
            </div>
            {hasPartialBalance ? (
              <div className="text-xs tabular-nums text-muted-foreground">
                {t(
                  ($) => {
                    return $.billing.usage.left;
                  },
                  { value: formatLocalizedNumber(grant.remaining) },
                )}
              </div>
            ) : null}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        style={{
          backgroundColor: "hsl(var(--popover))",
          color: "hsl(var(--popover-foreground))",
        }}
        className="border shadow-md"
      >
        <div className="font-medium text-foreground">{expiresLabel(grant)}</div>
        <div className="mt-0.5 text-muted-foreground">
          {t(
            ($) => {
              return $.billing.usage.creditsRemaining;
            },
            {
              count: grant.remaining,
              value: formatLocalizedNumber(grant.remaining),
            },
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function CreditGrantList({ grants }: { grants: CreditGrant[] }) {
  const { t } = useTranslation();
  if (grants.length === 0) {
    return null;
  }

  return (
    <details
      data-testid="credit-grants-section"
      className="group mt-4 border-t border-border/50 pt-3"
    >
      <summary
        data-testid="credit-grants-toggle"
        className="mb-1 cursor-pointer list-none px-2"
      >
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <IconChevronRight
            size={13}
            stroke={2}
            className="shrink-0 transition-transform group-open:rotate-90"
          />
          <span>
            {t(($) => {
              return $.billing.usage.creditAdditions;
            })}
          </span>
          <span className="tabular-nums">({grants.length})</span>
        </div>
      </summary>
      <TooltipProvider delayDuration={100}>
        <div className="flex flex-col">
          {grants.map((grant) => {
            return <CreditGrantRow key={grant.id} grant={grant} />;
          })}
        </div>
      </TooltipProvider>
    </details>
  );
}

function CreditBalanceChart({
  billing,
  onComparePlans,
}: {
  billing: BillingStatusResponse;
  onComparePlans: () => void;
}) {
  const { t } = useTranslation();
  const segments = billing.creditBreakdown.filter((s) => {
    return s.credits > 0;
  });
  const total = billing.credits;
  const showFreeEmptyPrompt =
    (billing.tier === "free" ||
      billing.tier === "limited-free-1" ||
      billing.tier === "pro-suspend") &&
    total <= 0;
  return (
    <div className="px-5 py-4" data-testid="credit-balance-info">
      <p className="text-sm font-medium tabular-nums text-foreground">
        {formatLocalizedNumber(total)}
      </p>

      {showFreeEmptyPrompt ? (
        <div
          className="mt-3 rounded-lg border border-border/60 bg-muted/30 px-3 py-3"
          data-testid="free-empty-credit-prompt"
        >
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.billing.usage.upgradeTitle;
            })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => {
              return $.billing.usage.upgradeDescription;
            })}
          </p>
          <button
            type="button"
            className="mt-3 inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={() => {
              onComparePlans();
            }}
          >
            {t(($) => {
              return $.billing.plans.compare;
            })}
          </button>
        </div>
      ) : null}

      {total > 0 && segments.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {/* Bar */}
          <TooltipProvider delayDuration={100}>
            <div className="flex h-2.5 w-full rounded-full bg-muted/40">
              {segments.map((s) => {
                const color = colorForSegment(s);
                const desc = descriptionForSegment(s, billing.tier);
                return (
                  <Tooltip key={segmentKey(s)}>
                    <TooltipTrigger asChild>
                      <div
                        data-testid={`credit-balance-segment-${segmentKey(s)}`}
                        className={`h-2.5 ${color} cursor-default first:rounded-l-full last:rounded-r-full ring-0 hover:ring-2 hover:ring-foreground/30 hover:z-10 transition-shadow`}
                        style={{
                          width: `${(s.credits / total) * 100}%`,
                        }}
                      />
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={8}
                      style={{
                        backgroundColor: "hsl(var(--popover))",
                        color: "hsl(var(--popover-foreground))",
                      }}
                      className="border shadow-md"
                    >
                      <div className="font-medium text-foreground">
                        {labelForSegment(s)} —{" "}
                        {formatLocalizedNumber(s.credits)}
                      </div>
                      <div className="text-muted-foreground mt-0.5">{desc}</div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {segments.map((s) => {
              const color = colorForSegment(s);
              return (
                <div
                  key={segmentKey(s)}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`}
                  />
                  <span>{labelForSegment(s)}</span>
                  <span className="tabular-nums">
                    {formatLocalizedNumber(s.credits)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <CreditGrantList grants={billing.creditGrants} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credit balance card
// ---------------------------------------------------------------------------

/**
 * The org credit balance summary card (total, breakdown bar, grants). Lives at
 * the top of the Credit balance section — above the Mine/Team tabs — so it stays
 * visible regardless of the active tab.
 */
export function CreditBalanceCard({
  onComparePlans,
}: {
  onComparePlans: () => void;
}) {
  const { t } = useTranslation();
  const billingLoadable = useLoadable(billingStatusAsync$);
  const billing =
    billingLoadable.state === "hasData" ? billingLoadable.data : null;
  const billingLoading = billingLoadable.state === "loading";

  return (
    <div className="flex flex-col gap-3">
      {billing ? (
        <UsageAllowanceCard allowance={billing.usageAllowance} />
      ) : null}
      <div className="overflow-hidden rounded-xl bg-card zero-border">
        {billingLoading && !billing ? (
          <div className="px-5 py-4 space-y-2">
            <div className="h-4 w-48 rounded bg-muted/50 animate-pulse" />
            <div className="h-1.5 w-full rounded-full bg-muted/40 animate-pulse" />
          </div>
        ) : billing ? (
          <CreditBalanceChart
            billing={billing}
            onComparePlans={onComparePlans}
          />
        ) : (
          <div className="px-5 py-4">
            <p className="text-sm text-muted-foreground">
              {t(($) => {
                return $.billing.usage.unavailable;
              })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MemberAvatar({
  imageUrl,
  initial,
  name,
}: {
  imageUrl: string;
  initial: string;
  name: string;
}) {
  if (imageUrl) {
    return (
      <div className="h-8 w-8 shrink-0 rounded-lg overflow-hidden">
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-xs font-medium text-muted-foreground">
      {initial}
    </div>
  );
}

export function MemberUsageTable({
  members,
  memberMap,
}: {
  members: MemberUsage[];
  memberMap: Map<string, OrgMember>;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-xl bg-card zero-border">
      {/* Header */}
      <div className="grid grid-cols-[1fr_7rem] gap-x-4 items-center px-5 py-2.5 text-[13px] font-medium text-foreground">
        <span>
          {t(($) => {
            return $.billing.usage.member;
          })}
        </span>
        <span>
          {t(($) => {
            return $.billing.usage.used;
          })}
        </span>
      </div>
      {members.map((member) => {
        const orgMember = memberMap.get(member.userId);
        const name = orgMember ? displayName(orgMember) : "";
        const label = name || member.email;
        const initial = label.charAt(0).toUpperCase();

        return (
          <div key={member.userId}>
            <div className="h-0 zero-border-t mx-5" />
            <div className="grid grid-cols-[1fr_7rem] gap-x-4 items-center px-5 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <MemberAvatar
                  imageUrl={orgMember?.imageUrl ?? ""}
                  initial={initial}
                  name={label}
                />
                <div className="min-w-0">
                  {name ? (
                    <>
                      <p className="truncate text-sm font-medium text-foreground">
                        {name}
                      </p>
                      <p className="truncate text-[13px] text-muted-foreground">
                        {member.email}
                      </p>
                    </>
                  ) : (
                    <p className="truncate text-sm font-medium text-foreground">
                      {member.email}
                    </p>
                  )}
                </div>
              </div>
              <span className="text-[13px] tabular-nums text-foreground whitespace-nowrap">
                {formatLocalizedNumber(member.creditsCharged)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
