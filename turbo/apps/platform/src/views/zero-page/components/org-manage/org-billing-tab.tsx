// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  IconExternalLink,
  IconCrown,
  IconArrowLeft,
  IconChevronRight,
  IconCoins,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX,
  CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN,
  billingStatusAsync$,
  cancelConcurrencySubscription$,
  closeConcurrencyConfirmDialog$,
  closeConcurrencyPurchaseDialog$,
  concurrencyConfirmDialog$,
  concurrencyPurchaseDialogOpen$,
  concurrencySubscriptionQuantity$,
  reloadBillingStatus$,
  openConcurrencyConfirmDialog$,
  openConcurrencyPurchaseDialog$,
  restoreConcurrencySubscription$,
  startCheckout$,
  startConcurrencyCheckout$,
  startDowngrade$,
  setConcurrencySubscriptionQuantity$,
  apiTierToBillingTier,
  openDowngradeDialog$,
  closeDowngradeDialog$,
  confirmDowngrade$,
  downgradeDialogOpen$,
  openRestoreDialog$,
  closeRestoreDialog$,
  restoreDialogOpen$,
  restorePlan$,
  type BillingTier,
} from "../../../../signals/zero-page/billing.ts";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import type { BillingStatusResponse } from "@vm0/api-contracts/contracts/zero-billing";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@vm0/ui/components/ui/dialog";
import { planFreeImg, planProImg, planTeamImg } from "../../platform-assets.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { AutoRechargeSection } from "../../billing-dialog.tsx";
import {
  orgPlanCapabilitiesFromBilling,
  type OrgPlanCapabilities,
} from "../../../../signals/zero-page/org-plan-capabilities.ts";
import { BuyCreditsSection } from "./buy-credits-section.tsx";
import {
  billingSubPage$,
  buyCreditsScrollRef$,
  setBillingSubPage$,
  lockedTarget$,
  selectedTarget$,
  setLockedTarget$,
  setSelectedTarget$,
} from "../../../../signals/zero-page/settings/workspace-settings-state.ts";
import { currentLocale, i18n } from "../../../../i18n/index.ts";
import { formatLocalizedNumber, formatUsd } from "../../../../i18n/format.ts";

const PLANS = [
  {
    tier: "free" as const,
    monthlyPriceUsd: 0,
    image: planFreeImg,
  },
  {
    tier: "pro" as const,
    monthlyPriceUsd: 20,
    primary: true,
    image: planProImg,
  },
  {
    tier: "team" as const,
    monthlyPriceUsd: 200,
    image: planTeamImg,
  },
] as const;

const COMPARE_PLANS = PLANS.filter((plan) => {
  return plan.tier !== "free";
});

type ScheduledBillingChange = BillingStatusResponse["scheduledChange"];
type BillingPlan = (typeof PLANS)[number];

function planName(tier: BillingPlan["tier"] | BillingTier): string {
  if (tier === "pro") {
    return i18n.t(($) => {
      return $.billing.plans.pro.name;
    });
  }
  if (tier === "team") {
    return i18n.t(($) => {
      return $.billing.plans.team.name;
    });
  }
  if (tier === "custom") {
    return i18n.t(($) => {
      return $.billing.plans.custom.name;
    });
  }
  if (tier === "limited-free-1") {
    return i18n.t(($) => {
      return $.billing.plans.limitedFree.name;
    });
  }
  if (tier === "pro-suspend") {
    return i18n.t(($) => {
      return $.billing.plans.noPlan.name;
    });
  }
  return i18n.t(($) => {
    return $.billing.plans.free.name;
  });
}

function planDescription(tier: BillingPlan["tier"]): string {
  if (tier === "pro") {
    return i18n.t(($) => {
      return $.billing.plans.pro.description;
    });
  }
  if (tier === "team") {
    return i18n.t(($) => {
      return $.billing.plans.team.description;
    });
  }
  return i18n.t(($) => {
    return $.billing.plans.free.description;
  });
}

function planFeatures(tier: BillingPlan["tier"]): string[] {
  const unlimitedAgents = i18n.t(($) => {
    return $.billing.plans.features.unlimitedAgents;
  });
  const byok = i18n.t(($) => {
    return $.billing.plans.features.byok;
  });
  const voiceInput = i18n.t(($) => {
    return $.billing.plans.features.voiceInput;
  });
  if (tier === "free") {
    return [
      i18n.t(($) => {
        return $.billing.plans.features.existingCredits;
      }),
      i18n.t(($) => {
        return $.billing.plans.features.oneConcurrentRun;
      }),
      unlimitedAgents,
      byok,
      i18n.t(($) => {
        return $.billing.plans.features.voiceInputLifetime;
      }),
      i18n.t(($) => {
        return $.billing.plans.features.communitySupport;
      }),
    ];
  }
  const credits =
    tier === "pro"
      ? i18n.t(
          ($) => {
            return $.billing.plans.features.monthlyCredits;
          },
          { value: formatLocalizedNumber(20_000) },
        )
      : i18n.t(
          ($) => {
            return $.billing.plans.features.monthlyCredits;
          },
          { value: formatLocalizedNumber(120_000) },
        );
  return [
    credits,
    i18n.t(($) => {
      return $.billing.plans.features.payAsYouGo;
    }),
    tier === "pro"
      ? i18n.t(($) => {
          return $.billing.plans.features.twoConcurrentRuns;
        })
      : i18n.t(($) => {
          return $.billing.plans.features.tenConcurrentRuns;
        }),
    unlimitedAgents,
    byok,
    voiceInput,
    tier === "pro"
      ? i18n.t(($) => {
          return $.billing.plans.features.emailSupport;
        })
      : i18n.t(($) => {
          return $.billing.plans.features.prioritySupport;
        }),
  ];
}

function getPlanPrice(tier: string): string {
  const plan = PLANS.find((p) => {
    return p.tier === tier;
  });
  return plan
    ? i18n.t(
        ($) => {
          return $.billing.plans.pricePerMonth;
        },
        { price: formatUsd(plan.monthlyPriceUsd, 0) },
      )
    : "";
}

function tierRank(t: BillingTier): number {
  if (t === "free" || t === "limited-free-1" || t === "pro-suspend") {
    return 0;
  }
  if (t === "pro") {
    return 1;
  }
  if (t === "team") {
    return 2;
  }
  return 3;
}

function isPaidTier(tier: BillingTier): boolean {
  return tier === "pro" || tier === "team" || tier === "custom";
}

function isCustomTier(tier: BillingTier): boolean {
  return tier === "custom";
}

function isNoActivePlanTier(tier: BillingTier): boolean {
  return tier === "limited-free-1" || tier === "pro-suspend";
}

function formatBillingDate(value: string): string {
  return new Date(value).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function scheduledEffectiveDate(
  scheduledChange: ScheduledBillingChange,
  periodEnd: string | null | undefined,
): string | null {
  return scheduledChange?.effectiveDate ?? periodEnd ?? null;
}

function scheduledTargetLabel(scheduledChange: ScheduledBillingChange): string {
  if (!scheduledChange?.targetTier) {
    return i18n.t(($) => {
      return $.billing.plans.selectedPlan;
    });
  }
  return formatTierLabel(scheduledChange.targetTier);
}

function billingScheduledChange(
  status: BillingStatusResponse | null,
): ScheduledBillingChange {
  if (!status) {
    return null;
  }
  if (status.scheduledChange) {
    return status.scheduledChange;
  }
  if (status.cancelAtPeriodEnd) {
    return {
      type: "cancel",
      targetTier: "limited-free-1",
      effectiveDate: status.currentPeriodEnd,
    };
  }
  return null;
}

type PlanCardAction =
  | "current"
  | "unavailable"
  | "manage-subscription"
  | "upgrade"
  | "manage"
  | "restore"
  | "downgrade-pro";

function planButtonAction(
  plan: BillingPlan,
  currentTier: BillingTier,
): PlanCardAction {
  if (plan.tier === currentTier) {
    return "current";
  }
  if (isCustomTier(currentTier)) {
    return "unavailable";
  }
  if (
    plan.tier === "free" &&
    (currentTier === "limited-free-1" || currentTier === "pro-suspend")
  ) {
    return "unavailable";
  }
  if (plan.tier === "free") {
    return "manage-subscription";
  }
  if (tierRank(plan.tier) > tierRank(currentTier)) {
    return "upgrade";
  }
  return "manage";
}

function isPlanDowngradeTarget(
  plan: BillingPlan,
  scheduledChange: ScheduledBillingChange,
): boolean {
  return (
    scheduledChange?.type === "downgrade" &&
    plan.tier === scheduledChange.targetTier
  );
}

function canReplaceCancellationWithPro(
  plan: BillingPlan,
  currentTier: BillingTier,
  scheduledChange: ScheduledBillingChange,
): boolean {
  return (
    currentTier === "team" &&
    plan.tier === "pro" &&
    scheduledChange?.type === "cancel"
  );
}

function canRestoreCurrentPlan(args: {
  currentTier: BillingTier;
  scheduledChange: ScheduledBillingChange;
  isCurrent: boolean;
}): boolean {
  return (
    isPaidTier(args.currentTier) &&
    args.scheduledChange !== null &&
    args.isCurrent
  );
}

function planCardAction(args: {
  plan: BillingPlan;
  currentTier: BillingTier;
  scheduledChange: ScheduledBillingChange;
  restoreCurrentPlan: boolean;
}): PlanCardAction {
  if (args.restoreCurrentPlan) {
    return "restore";
  }
  if (
    canReplaceCancellationWithPro(
      args.plan,
      args.currentTier,
      args.scheduledChange,
    )
  ) {
    return "downgrade-pro";
  }
  return planButtonAction(args.plan, args.currentTier);
}

function planCardLabel(action: PlanCardAction, plan: BillingPlan): string {
  if (action === "current") {
    return i18n.t(($) => {
      return $.billing.plans.currentPlan;
    });
  }
  if (action === "unavailable") {
    return i18n.t(($) => {
      return $.billing.common.unavailable;
    });
  }
  if (action === "manage-subscription") {
    return i18n.t(($) => {
      return $.billing.plans.manageSubscription;
    });
  }
  if (action === "upgrade") {
    return i18n.t(
      ($) => {
        return $.billing.plans.upgradeTo;
      },
      { plan: planName(plan.tier) },
    );
  }
  if (action === "restore") {
    return i18n.t(($) => {
      return $.billing.plans.restorePlan;
    });
  }
  if (action === "downgrade-pro") {
    return i18n.t(
      ($) => {
        return $.billing.plans.downgradeTo;
      },
      { plan: planName("pro") },
    );
  }
  return i18n.t(($) => {
    return $.billing.common.manage;
  });
}

function planCardButtonVariant(args: {
  plan: BillingPlan;
  isCurrent: boolean;
  action: PlanCardAction;
  restoreCurrentPlan: boolean;
}): React.ComponentProps<typeof Button>["variant"] {
  if (args.restoreCurrentPlan) {
    return "default";
  }
  if (args.isCurrent || args.action === "manage") {
    return "outline";
  }
  if ("primary" in args.plan && args.plan.primary) {
    return "default";
  }
  return "outline";
}

function planCardButtonDisabled(args: {
  loading: boolean;
  action: PlanCardAction;
  isCurrent: boolean;
  restoreCurrentPlan: boolean;
}): boolean {
  if (args.loading) {
    return true;
  }
  if (args.restoreCurrentPlan || args.action === "manage") {
    return false;
  }
  return args.isCurrent || args.action === "unavailable";
}

function PlanScheduleNotice({
  plan,
  isCurrent,
  isDowngradeTarget,
  scheduledChange,
  changeDate,
}: {
  plan: BillingPlan;
  isCurrent: boolean;
  isDowngradeTarget: boolean;
  scheduledChange: ScheduledBillingChange;
  changeDate: string | null;
}) {
  if (!changeDate) {
    return null;
  }
  const noticeClassName =
    "mb-5 rounded-lg border border-amber-200/70 bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300";

  if (scheduledChange?.type === "cancel" && isCurrent) {
    return (
      <p className={noticeClassName}>
        {i18n.t(
          ($) => {
            return $.billing.plans.endsOn;
          },
          { date: formatBillingDate(changeDate) },
        )}
      </p>
    );
  }
  if (scheduledChange?.type === "downgrade" && isCurrent) {
    return (
      <p className={noticeClassName}>
        {i18n.t(
          ($) => {
            return $.billing.plans.downgradesOn;
          },
          {
            plan: scheduledTargetLabel(scheduledChange),
            date: formatBillingDate(changeDate),
          },
        )}
      </p>
    );
  }
  if (isDowngradeTarget) {
    return (
      <p className={noticeClassName}>
        {i18n.t(
          ($) => {
            return $.billing.plans.downgradesOn;
          },
          {
            plan: formatTierLabel(plan.tier),
            date: formatBillingDate(changeDate),
          },
        )}
      </p>
    );
  }
  return null;
}

function PlanCard({
  plan,
  currentTier,
  scheduledChange,
  periodEnd,
  loading,
  onAction,
  onRestore,
}: {
  plan: BillingPlan;
  currentTier: BillingTier;
  scheduledChange: ScheduledBillingChange;
  periodEnd: string | null | undefined;
  loading: boolean;
  onAction: (planTier: BillingTier, e: React.MouseEvent) => void;
  onRestore: () => void;
}) {
  const isCurrent = plan.tier === currentTier;
  const isDowngradeTarget = isPlanDowngradeTarget(plan, scheduledChange);
  const restoreCurrentPlan = canRestoreCurrentPlan({
    currentTier,
    scheduledChange,
    isCurrent,
  });
  const action = planCardAction({
    plan,
    currentTier,
    scheduledChange,
    restoreCurrentPlan,
  });
  const label = planCardLabel(action, plan);
  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);
  const buttonVariant = planCardButtonVariant({
    plan,
    isCurrent,
    action,
    restoreCurrentPlan,
  });
  const buttonDisabled = planCardButtonDisabled({
    loading,
    action,
    isCurrent,
    restoreCurrentPlan,
  });

  return (
    <div className="relative flex flex-col rounded-xl transition-transform duration-200 hover:-translate-y-0.5 zero-border px-6 py-7">
      {plan.tier === "pro" && (
        <span className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconCrown size={12} stroke={1.8} className="text-amber-500" />
          {i18n.t(($) => {
            return $.billing.plans.popular;
          })}
        </span>
      )}

      {plan.image && (
        <img
          src={plan.image}
          alt={planName(plan.tier)}
          loading="lazy"
          className="h-20 w-20 object-contain mb-2"
        />
      )}

      <h3 className="text-sm font-semibold uppercase tracking-wider text-[#D27939] font-mono">
        {planName(plan.tier)}
      </h3>

      <div className="mt-3 mb-1">
        <span className="text-3xl font-light tracking-tight text-foreground">
          {formatUsd(plan.monthlyPriceUsd, 0)}
        </span>
        <span className="ml-1.5 text-sm font-light text-muted-foreground">
          {i18n.t(($) => {
            return $.billing.plans.perMonth;
          })}
        </span>
      </div>

      <p className="text-[13px] font-light text-muted-foreground leading-relaxed mb-5 min-h-[42px]">
        {planDescription(plan.tier)}
      </p>

      <PlanScheduleNotice
        plan={plan}
        isCurrent={isCurrent}
        isDowngradeTarget={isDowngradeTarget}
        scheduledChange={scheduledChange}
        changeDate={changeDate}
      />

      <ul className="mb-6 flex flex-col gap-2.5">
        {planFeatures(plan.tier).map((feature) => {
          return (
            <li key={feature} className="flex items-center gap-2">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0 text-muted-foreground/40"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="16 9 10.5 15 8 12.5" />
              </svg>
              <span className="text-[13px] font-light text-muted-foreground">
                {feature}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto">
        <Button
          variant={buttonVariant}
          size="default"
          className="w-full h-11 text-sm font-medium"
          disabled={buttonDisabled}
          onClick={(e) => {
            if (restoreCurrentPlan) {
              return onRestore();
            }
            return onAction(plan.tier, e);
          }}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}

function PricingPage({
  currentTier,
  scheduledChange,
  periodEnd,
  onBack,
  onRestore,
}: {
  currentTier: BillingTier;
  scheduledChange: ScheduledBillingChange;
  periodEnd: string | null | undefined;
  onBack: () => void;
  onRestore: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const loading = checkoutLoadable.state === "loading";
  const openDowngrade = useSet(openDowngradeDialog$);
  const setLockedTarget = useSet(setLockedTarget$);

  const handlePlanAction = (planTier: BillingTier, e: React.MouseEvent) => {
    if (isCustomTier(currentTier)) {
      return;
    }
    if (planTier === currentTier) {
      return;
    }
    if (
      planTier === "free" &&
      (currentTier === "limited-free-1" || currentTier === "pro-suspend")
    ) {
      return;
    }
    if (
      currentTier === "team" &&
      planTier === "pro" &&
      scheduledChange?.type === "cancel"
    ) {
      setLockedTarget("pro");
      openDowngrade();
      return;
    }
    if (planTier === "free" || tierRank(planTier) < tierRank(currentTier)) {
      openDowngrade();
      return;
    }
    if (planTier !== "pro" && planTier !== "team") {
      return;
    }
    const newTab = e.metaKey || e.ctrlKey;
    detach(
      checkout(planTier, newTab, undefined, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div
      className="flex flex-col gap-5 outline-none"
      role="group"
      tabIndex={-1}
      ref={(el) => {
        el?.focus();
      }}
    >
      <div className="flex items-center gap-3">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onBack}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                aria-label={i18n.t(($) => {
                  return $.billing.common.back;
                })}
              >
                <IconArrowLeft size={16} stroke={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                {i18n.t(($) => {
                  return $.billing.common.back;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {i18n.t(($) => {
              return $.billing.plans.compare;
            })}
          </h3>
          <p className="text-[13px] text-muted-foreground">
            {isCustomTier(currentTier)
              ? i18n.t(($) => {
                  return $.billing.plans.customCheckoutUnavailable;
                })
              : i18n.t(($) => {
                  return $.billing.plans.changeAnytime;
                })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {COMPARE_PLANS.map((plan) => {
          return (
            <PlanCard
              key={plan.tier}
              plan={plan}
              currentTier={currentTier}
              scheduledChange={scheduledChange}
              periodEnd={periodEnd}
              loading={loading}
              onAction={handlePlanAction}
              onRestore={onRestore}
            />
          );
        })}
      </div>
    </div>
  );
}

function formatTierLabel(tier: BillingTier): string {
  return planName(tier);
}

function DowngradeConfirmDialog({ currentTier }: { currentTier: BillingTier }) {
  const pageSignal = useGet(pageSignal$);
  const open = useGet(downgradeDialogOpen$);
  const [downgradeLoadable, confirm] = useLoadableSet(confirmDowngrade$);
  const loading = downgradeLoadable.state === "loading";
  const error =
    downgradeLoadable.state === "hasError"
      ? String(downgradeLoadable.error)
      : null;
  const close = useSet(closeDowngradeDialog$);
  const selectedTarget = useGet(selectedTarget$);
  const lockedTarget = useGet(lockedTarget$);
  const setSelectedTarget = useSet(setSelectedTarget$);
  const setLockedTarget = useSet(setLockedTarget$);

  const isTeam = currentTier === "team";
  const isLockedTarget = lockedTarget !== null;
  const downgradeTarget = isTeam ? selectedTarget : "limited-free-1";
  const targetLabel = formatTierLabel(downgradeTarget);
  const proPlanPrice = getPlanPrice("pro");
  const freePlanPrice = getPlanPrice("free");

  const handleConfirm = () => {
    detach(confirm(downgradeTarget, pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) {
          return;
        }
        setLockedTarget(null);
        close();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.billing.downgrade.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {isTeam && isLockedTarget
              ? i18n.t(
                  ($) => {
                    return $.billing.downgrade.confirmTarget;
                  },
                  { plan: targetLabel },
                )
              : isTeam
                ? i18n.t(($) => {
                    return $.billing.downgrade.chooseTarget;
                  })
                : i18n.t(($) => {
                    return $.billing.downgrade.confirmProCancellation;
                  })}
          </DialogDescription>
        </DialogHeader>

        {isTeam && isLockedTarget && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
            {i18n.t(
              ($) => {
                return $.billing.downgrade.teamWarning;
              },
              { plan: targetLabel },
            )}
          </p>
        )}

        {!isTeam && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
            {i18n.t(($) => {
              return $.billing.downgrade.proWarning;
            })}
          </p>
        )}

        {isTeam && !isLockedTarget && (
          <div className="flex flex-col gap-2 mt-2">
            <button
              type="button"
              onClick={() => {
                return setSelectedTarget("pro");
              }}
              className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                selectedTarget === "pro"
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div>
                <span className="text-sm font-semibold text-foreground">
                  {planName("pro")}
                </span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {proPlanPrice}
                </span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                return setSelectedTarget("limited-free-1");
              }}
              className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                selectedTarget === "limited-free-1" ||
                selectedTarget === "pro-suspend"
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div>
                <span className="text-sm font-semibold text-foreground">
                  {planName("pro-suspend")}
                </span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {freePlanPrice}
                </span>
              </div>
            </button>
          </div>
        )}

        {error && <p className="text-sm text-destructive mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="outline"
            onClick={() => {
              setLockedTarget(null);
              return close();
            }}
            disabled={loading}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading
              ? i18n.t(($) => {
                  return $.billing.downgrade.inProgress;
                })
              : downgradeTarget === "limited-free-1" ||
                  downgradeTarget === "pro-suspend"
                ? i18n.t(($) => {
                    return $.billing.downgrade.cancelSubscription;
                  })
                : i18n.t(
                    ($) => {
                      return $.billing.plans.downgradeTo;
                    },
                    { plan: targetLabel },
                  )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RestorePlanConfirmDialog({
  currentTier,
  periodEnd,
  scheduledChange,
}: {
  currentTier: BillingTier;
  periodEnd: string | null | undefined;
  scheduledChange: ScheduledBillingChange;
}) {
  const pageSignal = useGet(pageSignal$);
  const open = useGet(restoreDialogOpen$);
  const close = useSet(closeRestoreDialog$);
  const [restoreLoadable, restore] = useLoadableSet(restorePlan$);
  const loading = restoreLoadable.state === "loading";
  const error =
    restoreLoadable.state === "hasError" ? String(restoreLoadable.error) : null;
  const planLabel = formatTierLabel(currentTier);
  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);
  const description =
    scheduledChange?.type === "downgrade"
      ? i18n.t(
          ($) => {
            return $.billing.restore.downgradeDescription;
          },
          {
            target: scheduledTargetLabel(scheduledChange),
            plan: planLabel,
          },
        )
      : changeDate
        ? i18n.t(
            ($) => {
              return $.billing.restore.cancellationDescriptionDate;
            },
            { plan: planLabel, date: formatBillingDate(changeDate) },
          )
        : i18n.t(
            ($) => {
              return $.billing.restore.cancellationDescription;
            },
            { plan: planLabel },
          );

  const handleConfirm = () => {
    detach(restore(pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        return !v && close();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(
              ($) => {
                return $.billing.restore.title;
              },
              { plan: planLabel },
            )}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive mt-2">{error}</p>}

        <div className="flex justify-end gap-2 mt-4">
          <Button
            variant="outline"
            onClick={() => {
              return close();
            }}
            disabled={loading}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button onClick={handleConfirm} disabled={loading}>
            {loading
              ? i18n.t(($) => {
                  return $.billing.restore.inProgress;
                })
              : i18n.t(($) => {
                  return $.billing.plans.restorePlan;
                })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PlanActionButtons({
  isPaid,
  hasScheduledChange,
  currentTier,
  loading,
  onUpgrade,
  onDowngrade,
  onRestore,
}: {
  isPaid: boolean;
  hasScheduledChange: boolean;
  currentTier: BillingTier;
  loading: boolean;
  onUpgrade: () => void;
  onDowngrade: () => void;
  onRestore: () => void;
}) {
  const customLocked = isCustomTier(currentTier);
  const showUpgrade =
    !customLocked &&
    ((isPaid && currentTier !== "team" && !hasScheduledChange) || !isPaid);
  const showDowngrade = !customLocked && isPaid && !hasScheduledChange;
  const showRestore = !customLocked && isPaid && hasScheduledChange;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {showRestore && (
        <Button
          size="sm"
          className="rounded-lg h-8 text-xs"
          disabled={loading}
          onClick={onRestore}
        >
          {i18n.t(($) => {
            return $.billing.plans.restorePlan;
          })}
        </Button>
      )}
      {showUpgrade && (
        <Button
          size="sm"
          className="rounded-lg h-8 text-xs"
          disabled={loading}
          onClick={onUpgrade}
        >
          {i18n.t(($) => {
            return $.billing.plans.upgrade;
          })}
        </Button>
      )}
      {showDowngrade && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={loading}
          onClick={onDowngrade}
        >
          {i18n.t(($) => {
            return $.billing.plans.downgrade;
          })}
        </Button>
      )}
    </div>
  );
}

function currentPlanNameLabel(currentTier: BillingTier): string {
  if (isNoActivePlanTier(currentTier)) {
    return i18n.t(($) => {
      return $.billing.plans.noActivePlan;
    });
  }
  return i18n.t(
    ($) => {
      return $.billing.plans.namedPlan;
    },
    { plan: formatTierLabel(currentTier) },
  );
}

function currentPlanStatusLabel(
  currentTier: BillingTier,
  periodLabel: string | null,
): string {
  if (isCustomTier(currentTier)) {
    return i18n.t(
      ($) => {
        return $.billing.plans.customAccess;
      },
      { value: formatLocalizedNumber(10) },
    );
  }
  return (
    periodLabel ??
    i18n.t(($) => {
      return $.billing.plans.noActiveSubscription;
    })
  );
}

function billingPeriodLabel(args: {
  isPaid: boolean;
  scheduledChange: ScheduledBillingChange;
  periodEnd: string | null | undefined;
}): string | null {
  const { isPaid, scheduledChange, periodEnd } = args;
  if (!isPaid) {
    return null;
  }

  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);
  if (!changeDate) {
    return null;
  }

  const date = formatBillingDate(changeDate);
  if (scheduledChange?.type === "cancel") {
    return i18n.t(
      ($) => {
        return $.billing.plans.endsOn;
      },
      { date },
    );
  }
  if (scheduledChange?.type === "downgrade") {
    return i18n.t(
      ($) => {
        return $.billing.plans.downgradesOn;
      },
      { plan: scheduledTargetLabel(scheduledChange), date },
    );
  }
  return i18n.t(
    ($) => {
      return $.billing.plans.renews;
    },
    { date },
  );
}

const HIDDEN_BILLING_CONTROLS = Object.freeze({
  canBuyConcurrency: false,
  canBuyCredits: false,
  autoRechargeAllowed: false,
});

function billingControlCapabilities(
  status: BillingStatusResponse | null,
): Pick<
  OrgPlanCapabilities,
  "canBuyConcurrency" | "canBuyCredits" | "autoRechargeAllowed"
> {
  if (!status) {
    return HIDDEN_BILLING_CONTROLS;
  }
  return orgPlanCapabilitiesFromBilling(status);
}

function cancellationNoticeText(tier: BillingTier, changeDate: string): string {
  const formattedDate = formatBillingDate(changeDate);
  if (tier === "custom") {
    return i18n.t(
      ($) => {
        return $.billing.plans.customCancellationNotice;
      },
      { date: formattedDate },
    );
  }
  return i18n.t(
    ($) => {
      return $.billing.plans.cancellationNotice;
    },
    { plan: formatTierLabel(tier), date: formattedDate },
  );
}

const CONCURRENCY_SLOT_MONTHLY_PRICE_USD = 100;

function slotCountLabel(count: number): string {
  return i18n.t(
    ($) => {
      return $.billing.concurrency.slot;
    },
    { count, value: formatLocalizedNumber(count) },
  );
}

function concurrencyMonthlyPrice(quantity: number): string {
  return i18n.t(
    ($) => {
      return $.billing.plans.pricePerMonth;
    },
    {
      price: formatUsd(quantity * CONCURRENCY_SLOT_MONTHLY_PRICE_USD, 0),
    },
  );
}

type ConcurrencySubscription =
  BillingStatusResponse["concurrencySubscriptions"][number];

function concurrencySubscriptionPeriodLabel(
  subscription: ConcurrencySubscription,
  canceled: boolean,
): string {
  if (!subscription.currentPeriodEnd) {
    return canceled
      ? i18n.t(($) => {
          return $.billing.concurrency.cancellationScheduled;
        })
      : i18n.t(($) => {
          return $.billing.concurrency.billedMonthly;
        });
  }

  const date = formatBillingDate(subscription.currentPeriodEnd);
  return canceled
    ? i18n.t(
        ($) => {
          return $.billing.concurrency.activeUntil;
        },
        { date },
      )
    : i18n.t(
        ($) => {
          return $.billing.plans.renews;
        },
        { date },
      );
}

function ConcurrencyQuantityControl({
  disabled,
  label,
  onQuantityChange,
  quantity,
}: {
  disabled: boolean;
  label: string;
  onQuantityChange: (quantity: number) => void;
  quantity: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <div className="flex h-8 items-center rounded-lg border border-border/70 bg-background">
        <button
          type="button"
          aria-label={i18n.t(($) => {
            return $.billing.concurrency.decreaseAria;
          })}
          disabled={
            quantity <= CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN || disabled
          }
          className="flex h-8 w-8 items-center justify-center rounded-l-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            onQuantityChange(quantity - 1);
          }}
        >
          <IconMinus size={13} stroke={2} />
        </button>
        <span className="flex h-8 w-11 items-center justify-center border-x border-border/70 text-sm font-medium tabular-nums text-foreground">
          {formatLocalizedNumber(quantity)}
        </span>
        <button
          type="button"
          aria-label={i18n.t(($) => {
            return $.billing.concurrency.increaseAria;
          })}
          disabled={
            quantity >= CONCURRENCY_SUBSCRIPTION_QUANTITY_MAX || disabled
          }
          className="flex h-8 w-8 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => {
            onQuantityChange(quantity + 1);
          }}
        >
          <IconPlus size={13} stroke={2} />
        </button>
      </div>
    </div>
  );
}

function ConcurrencySubscriptionRow({
  changing,
  canceled,
  onAction,
  subscription,
}: {
  changing: boolean;
  canceled: boolean;
  onAction: (action: "cancel" | "restore", subscriptionId: string) => void;
  subscription: ConcurrencySubscription;
}) {
  const action = canceled ? "restore" : "cancel";
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">
          {slotCountLabel(subscription.quantity)}
        </p>
        <p
          className={`text-[13px] mt-0.5 ${
            canceled
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          }`}
        >
          {concurrencySubscriptionPeriodLabel(subscription, canceled)}
        </p>
      </div>
      <Button
        variant={canceled ? "default" : "outline"}
        size="sm"
        className="h-8 shrink-0 text-xs"
        disabled={changing}
        onClick={() => {
          onAction(action, subscription.id);
        }}
      >
        {changing
          ? i18n.t(($) => {
              return $.billing.common.updating;
            })
          : canceled
            ? i18n.t(($) => {
                return $.billing.common.restore;
              })
            : i18n.t(($) => {
                return $.billing.common.cancel;
              })}
      </Button>
    </div>
  );
}

function ConcurrencyConfirmDialog() {
  const pageSignal = useGet(pageSignal$);
  const dialog = useGet(concurrencyConfirmDialog$);
  const close = useSet(closeConcurrencyConfirmDialog$);
  const [cancelLoadable, cancelSubscription] = useLoadableSet(
    cancelConcurrencySubscription$,
  );
  const [restoreLoadable, restoreSubscription] = useLoadableSet(
    restoreConcurrencySubscription$,
  );
  const loading =
    cancelLoadable.state === "loading" || restoreLoadable.state === "loading";
  const action = dialog?.action ?? "cancel";
  const title =
    action === "cancel"
      ? i18n.t(($) => {
          return $.billing.concurrency.cancelTitle;
        })
      : i18n.t(($) => {
          return $.billing.concurrency.restoreTitle;
        });
  const description =
    action === "cancel"
      ? i18n.t(($) => {
          return $.billing.concurrency.cancelDescription;
        })
      : i18n.t(($) => {
          return $.billing.concurrency.restoreDescription;
        });

  const handleConfirm = () => {
    if (!dialog) {
      return;
    }
    const command =
      action === "cancel" ? cancelSubscription : restoreSubscription;
    detach(command(dialog.subscriptionId, pageSignal), Reason.DomCallback);
  };

  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(v) => {
        return !v && close();
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => {
              return close();
            }}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            variant={action === "cancel" ? "destructive" : "default"}
            disabled={loading}
            onClick={handleConfirm}
          >
            {loading
              ? i18n.t(($) => {
                  return $.billing.common.updating;
                })
              : action === "cancel"
                ? i18n.t(($) => {
                    return $.billing.downgrade.cancelSubscription;
                  })
                : i18n.t(($) => {
                    return $.billing.concurrency.restoreSubscription;
                  })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConcurrencyPurchaseDialog() {
  const pageSignal = useGet(pageSignal$);
  const open = useGet(concurrencyPurchaseDialogOpen$);
  const close = useSet(closeConcurrencyPurchaseDialog$);
  const quantityOverride = useGet(concurrencySubscriptionQuantity$);
  const setQuantity = useSet(setConcurrencySubscriptionQuantity$);
  const [checkoutLoadable, checkout] = useLoadableSet(
    startConcurrencyCheckout$,
  );
  const checkoutLoading = checkoutLoadable.state === "loading";
  const quantity = quantityOverride ?? CONCURRENCY_SUBSCRIPTION_QUANTITY_MIN;
  const actionLabel = checkoutLoading
    ? i18n.t(($) => {
        return $.billing.common.redirecting;
      })
    : i18n.t(
        ($) => {
          return $.billing.concurrency.buyAmount;
        },
        { amount: concurrencyMonthlyPrice(quantity) },
      );

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        return !v && close();
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {i18n.t(($) => {
              return $.billing.concurrency.buyTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {i18n.t(($) => {
              return $.billing.concurrency.buyDescription;
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-4">
          <ConcurrencyQuantityControl
            disabled={checkoutLoading}
            label={i18n.t(($) => {
              return $.billing.concurrency.slots;
            })}
            onQuantityChange={setQuantity}
            quantity={quantity}
          />
          <p className="text-sm font-medium text-foreground">
            {concurrencyMonthlyPrice(quantity)}
          </p>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={checkoutLoading}
            onClick={() => {
              return close();
            }}
          >
            {i18n.t(($) => {
              return $.billing.common.cancel;
            })}
          </Button>
          <Button
            disabled={checkoutLoading}
            onClick={(e) => {
              detach(
                checkout(quantity, e.metaKey || e.ctrlKey, pageSignal),
                Reason.DomCallback,
              );
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConcurrencyBillingSection({
  status,
}: {
  status: BillingStatusResponse | null;
}) {
  const openPurchaseDialog = useSet(openConcurrencyPurchaseDialog$);
  const openConfirmDialog = useSet(openConcurrencyConfirmDialog$);
  const dialog = useGet(concurrencyConfirmDialog$);
  const subscriptions = status?.concurrencySubscriptions ?? [];
  const concurrencyLimit = status?.concurrencyLimit ?? 0;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-sm font-medium text-foreground">
          {i18n.t(($) => {
            return $.billing.concurrency.title;
          })}
        </h3>
        <p className="text-[13px] text-muted-foreground">
          {i18n.t(
            ($) => {
              return $.billing.concurrency.concurrentRun;
            },
            {
              count: concurrencyLimit,
              value: formatLocalizedNumber(concurrencyLimit),
            },
          )}
        </p>
      </div>
      <div className="overflow-hidden rounded-xl bg-card zero-border">
        {subscriptions.length === 0 ? (
          <div className="px-5 py-4">
            <p className="text-sm font-medium text-foreground">
              {i18n.t(($) => {
                return $.billing.concurrency.emptyTitle;
              })}
            </p>
            <p className="text-[13px] text-muted-foreground mt-0.5">
              {i18n.t(($) => {
                return $.billing.concurrency.emptyDescription;
              })}
            </p>
          </div>
        ) : (
          subscriptions.map((subscription, index) => {
            const canceled = subscription.cancelAtPeriodEnd;
            return (
              <div key={subscription.id}>
                {index > 0 && <div className="h-0 zero-border-t mx-5" />}
                <ConcurrencySubscriptionRow
                  changing={dialog?.subscriptionId === subscription.id}
                  canceled={canceled}
                  onAction={openConfirmDialog}
                  subscription={subscription}
                />
              </div>
            );
          })
        )}
        <div className="h-0 zero-border-t mx-5" />
        <div className="flex justify-end px-5 py-4">
          <Button
            type="button"
            size="sm"
            className="h-9 px-4 text-sm font-medium"
            onClick={openPurchaseDialog}
          >
            {i18n.t(($) => {
              return $.billing.concurrency.buyButton;
            })}
          </Button>
        </div>
      </div>
      <ConcurrencyPurchaseDialog />
      <ConcurrencyConfirmDialog />
    </section>
  );
}
export function OrgBillingTab() {
  const { t } = useTranslation();
  const pricingOpen = useGet(billingSubPage$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const buyCreditsScrollRef = useSet(buyCreditsScrollRef$);
  const setPricingOpen = (v: boolean) => {
    return setBillingSubPage(v);
  };
  const pageSignal = useGet(pageSignal$);
  const reloadBilling = useSet(reloadBillingStatus$);
  const openDowngrade = useSet(openDowngradeDialog$);
  const setLockedTarget = useSet(setLockedTarget$);
  const openRestore = useSet(openRestoreDialog$);
  const [portalLoadable, portal] = useLoadableSet(startDowngrade$);
  const statusLoadable = useLastLoadable(billingStatusAsync$);
  const loading = portalLoadable.state === "loading";

  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const statusLoading = statusLoadable.state === "loading";
  const statusError = statusLoadable.state === "hasError";
  const capabilities = billingControlCapabilities(status);

  const currentTier = apiTierToBillingTier(status?.tier);
  const isPaid = isPaidTier(currentTier);
  const scheduledChange = billingScheduledChange(status);
  const hasScheduledChange = scheduledChange !== null;
  const isCancelling = scheduledChange?.type === "cancel";
  const isDowngrading = scheduledChange?.type === "downgrade";
  const periodEnd = status?.currentPeriodEnd;
  const periodLabel = billingPeriodLabel({
    isPaid,
    scheduledChange,
    periodEnd,
  });
  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);

  const handleDowngrade = () => {
    setLockedTarget(null);
    openDowngrade();
  };
  const handleRestore = () => {
    openRestore();
  };
  const currentPlanLabel = currentPlanNameLabel(currentTier);
  const currentPlanDescription = currentPlanStatusLabel(
    currentTier,
    periodLabel,
  );
  const showBuyCredits = capabilities.canBuyCredits;
  const showConcurrency = capabilities.canBuyConcurrency;
  const canManageBilling = isPaid && status?.hasSubscription === true;
  const openBillingPortal = () => {
    return detach(portal(pageSignal), Reason.DomCallback);
  };

  if (pricingOpen) {
    return (
      <>
        <PricingPage
          currentTier={currentTier}
          scheduledChange={scheduledChange}
          periodEnd={periodEnd}
          onBack={() => {
            return setPricingOpen(false);
          }}
          onRestore={handleRestore}
        />
        <DowngradeConfirmDialog currentTier={currentTier} />
        <RestorePlanConfirmDialog
          currentTier={currentTier}
          periodEnd={periodEnd}
          scheduledChange={scheduledChange}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.plans.sectionTitle;
          })}
        </h3>
        <div className="overflow-hidden rounded-xl bg-card zero-border">
          {statusLoading && !status ? (
            <div className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="h-4 w-28 rounded bg-muted/50 animate-pulse" />
                <div className="h-3 w-48 rounded bg-muted/30 animate-pulse mt-1.5" />
              </div>
              <div className="h-8 w-24 shrink-0 rounded-lg bg-muted/30 animate-pulse" />
            </div>
          ) : statusError ? (
            <div className="px-5 py-6 text-center">
              <p className="text-sm text-muted-foreground mb-3">
                {t(($) => {
                  return $.billing.plans.loadError;
                })}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  return reloadBilling();
                }}
              >
                {t(($) => {
                  return $.billing.common.retry;
                })}
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    {currentPlanLabel}
                  </p>
                  <p className="text-[13px] text-muted-foreground mt-0.5">
                    {currentPlanDescription}
                  </p>
                </div>
                <PlanActionButtons
                  isPaid={isPaid}
                  hasScheduledChange={hasScheduledChange}
                  currentTier={currentTier}
                  loading={loading}
                  onUpgrade={() => {
                    return setPricingOpen(true);
                  }}
                  onDowngrade={handleDowngrade}
                  onRestore={handleRestore}
                />
              </div>
              {isCancelling && changeDate && (
                <>
                  <div className="h-0 zero-border-t mx-5" />
                  <div className="px-5 py-3">
                    <p className="text-[13px] text-amber-600 dark:text-amber-400">
                      {cancellationNoticeText(currentTier, changeDate)}
                    </p>
                  </div>
                </>
              )}
              {isDowngrading && changeDate && (
                <>
                  <div className="h-0 zero-border-t mx-5" />
                  <div className="px-5 py-3">
                    <p className="text-[13px] text-amber-600 dark:text-amber-400">
                      {t(
                        ($) => {
                          return $.billing.plans.downgradeNotice;
                        },
                        {
                          currentPlan: formatTierLabel(currentTier),
                          targetPlan: scheduledTargetLabel(scheduledChange),
                          date: formatBillingDate(changeDate),
                        },
                      )}
                    </p>
                  </div>
                </>
              )}
              {canManageBilling && (
                <>
                  <div className="h-0 zero-border-t mx-5" />
                  <div className="flex items-center justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {t(($) => {
                          return $.billing.manage.title;
                        })}
                      </p>
                      <p className="text-[13px] text-muted-foreground mt-0.5">
                        {t(($) => {
                          return $.billing.manage.description;
                        })}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 h-8 text-xs gap-1.5"
                      disabled={loading}
                      onClick={openBillingPortal}
                    >
                      {t(($) => {
                        return $.billing.common.manage;
                      })}
                      <IconExternalLink size={13} stroke={1.5} />
                    </Button>
                  </div>
                </>
              )}
              <div className="h-0 zero-border-t" />
              <button
                type="button"
                className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left transition-colors bg-muted/20 hover:bg-muted/35"
                onClick={() => {
                  return setPricingOpen(true);
                }}
              >
                <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                  {t(($) => {
                    return $.billing.plans.compareAll;
                  })}
                  <IconCoins
                    size={14}
                    stroke={1.5}
                    className="text-foreground/40"
                  />
                </span>
                <IconChevronRight
                  size={14}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground/50"
                />
              </button>
            </>
          )}
        </div>
      </section>

      {showBuyCredits && (
        <div ref={buyCreditsScrollRef}>
          <BuyCreditsSection />
        </div>
      )}

      {status && (
        <AutoRechargeSection
          allowed={capabilities.autoRechargeAllowed}
          loading={loading}
        />
      )}

      {showConcurrency && <ConcurrencyBillingSection status={status} />}

      <DowngradeConfirmDialog currentTier={currentTier} />
      <RestorePlanConfirmDialog
        currentTier={currentTier}
        periodEnd={periodEnd}
        scheduledChange={scheduledChange}
      />
    </div>
  );
}
