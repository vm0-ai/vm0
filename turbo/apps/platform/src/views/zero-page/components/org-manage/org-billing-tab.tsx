// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconExternalLink,
  IconCrown,
  IconArrowLeft,
  IconChevronRight,
  IconCoins,
} from "@tabler/icons-react";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  billingStatusAsync$,
  reloadBillingStatus$,
  startCheckout$,
  startDowngrade$,
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
import planFreeImg from "./assets/plan-free.webp";
import planProImg from "./assets/plan-pro.webp";
import planTeamImg from "./assets/plan-team.webp";
import { detach, Reason } from "../../../../signals/utils.ts";
import { AutoRechargeSection } from "../../billing-dialog.tsx";
import { BuyCreditsSection } from "./buy-credits-section.tsx";
import {
  billingScrollTarget$,
  billingSubPage$,
  setBillingScrollTarget$,
  setBillingSubPage$,
  lockedTarget$,
  selectedTarget$,
  setLockedTarget$,
  setSelectedTarget$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const PLANS = [
  {
    tier: "free" as const,
    name: "Free",
    price: "$0",
    period: "/month",
    description: "Legacy free access for existing workspaces.",
    cta: "Current plan",
    image: planFreeImg,
    features: [
      "Existing free credits only",
      "1 concurrent run",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Voice input (10/month)",
      "Community support",
    ],
  },
  {
    tier: "pro" as const,
    name: "Pro",
    price: "$20",
    period: "/month",
    description: "More power and seamless collaboration for your team.",
    cta: "Upgrade to Pro",
    primary: true,
    badge: "Popular",
    image: planProImg,
    features: [
      "20,000 credits / month",
      "Pay as you go after that",
      "2 concurrent runs",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Voice input",
      "Email support",
    ],
  },
  {
    tier: "team" as const,
    name: "Team",
    price: "$200",
    period: "/month",
    description: "Scale fast with zero friction and full flexibility.",
    cta: "Upgrade to Team",
    image: planTeamImg,
    features: [
      "120,000 credits / month",
      "Pay as you go after that",
      "10 concurrent runs",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Voice input",
      "Priority support",
    ],
  },
] as const;

const COMPARE_PLANS = PLANS.filter((plan) => {
  return plan.tier !== "free";
});

type ScheduledBillingChange = BillingStatusResponse["scheduledChange"];
type BillingPlan = (typeof PLANS)[number];

function getPlanPrice(tier: string): string {
  const plan = PLANS.find((p) => {
    return p.tier === tier;
  });
  return plan ? `${plan.price}${plan.period}` : "";
}

const proPlanPrice = getPlanPrice("pro");
const freePlanPrice = getPlanPrice("free");

function tierRank(t: BillingTier): number {
  if (t === "free" || t === "pro-suspend") {
    return 0;
  }
  if (t === "pro") {
    return 1;
  }
  return 2;
}

function isPaidTier(tier: BillingTier): boolean {
  return tier === "pro" || tier === "team";
}

function formatBillingDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
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
    return "the selected plan";
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
      targetTier: "pro-suspend",
      effectiveDate: status.currentPeriodEnd,
    };
  }
  return null;
}

function planButtonLabel(plan: BillingPlan, currentTier: BillingTier): string {
  if (plan.tier === currentTier) {
    return "Current plan";
  }
  if (plan.tier === "free" && currentTier === "pro-suspend") {
    return "Unavailable";
  }
  if (plan.tier === "free") {
    return "Manage subscription";
  }
  if (tierRank(plan.tier) > tierRank(currentTier)) {
    return plan.cta;
  }
  return "Manage";
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

function planCardLabel(args: {
  plan: BillingPlan;
  currentTier: BillingTier;
  scheduledChange: ScheduledBillingChange;
  restoreCurrentPlan: boolean;
}): string {
  if (args.restoreCurrentPlan) {
    return "Restore plan";
  }
  if (
    canReplaceCancellationWithPro(
      args.plan,
      args.currentTier,
      args.scheduledChange,
    )
  ) {
    return "Downgrade to Pro";
  }
  return planButtonLabel(args.plan, args.currentTier);
}

function planCardButtonVariant(args: {
  plan: BillingPlan;
  isCurrent: boolean;
  label: string;
  restoreCurrentPlan: boolean;
}): React.ComponentProps<typeof Button>["variant"] {
  if (args.restoreCurrentPlan) {
    return "default";
  }
  if (args.isCurrent || args.label === "Manage") {
    return "outline";
  }
  if ("primary" in args.plan && args.plan.primary) {
    return "default";
  }
  return "outline";
}

function planCardButtonDisabled(args: {
  loading: boolean;
  label: string;
  unavailable: boolean;
  isCurrent: boolean;
  restoreCurrentPlan: boolean;
}): boolean {
  if (args.loading) {
    return true;
  }
  if (args.restoreCurrentPlan || args.label === "Manage") {
    return false;
  }
  return args.isCurrent || args.unavailable;
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
      <p className={noticeClassName}>Ends on {formatBillingDate(changeDate)}</p>
    );
  }
  if (scheduledChange?.type === "downgrade" && isCurrent) {
    return (
      <p className={noticeClassName}>
        Downgrades to {scheduledTargetLabel(scheduledChange)} on{" "}
        {formatBillingDate(changeDate)}
      </p>
    );
  }
  if (isDowngradeTarget) {
    return (
      <p className={noticeClassName}>
        Downgrades to {formatTierLabel(plan.tier)} on{" "}
        {formatBillingDate(changeDate)}
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
  const label = planCardLabel({
    plan,
    currentTier,
    scheduledChange,
    restoreCurrentPlan,
  });
  const unavailable = label === "Unavailable";
  const changeDate = scheduledEffectiveDate(scheduledChange, periodEnd);
  const buttonVariant = planCardButtonVariant({
    plan,
    isCurrent,
    label,
    restoreCurrentPlan,
  });
  const buttonDisabled = planCardButtonDisabled({
    loading,
    label,
    unavailable,
    isCurrent,
    restoreCurrentPlan,
  });

  return (
    <div className="relative flex flex-col rounded-xl transition-transform duration-200 hover:-translate-y-0.5 zero-border px-6 py-7">
      {"badge" in plan && plan.badge && (
        <span className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
          <IconCrown size={12} stroke={1.8} className="text-amber-500" />
          {plan.badge}
        </span>
      )}

      {plan.image && (
        <img
          src={plan.image}
          alt={plan.name}
          loading="lazy"
          className="h-20 w-20 object-contain mb-2"
        />
      )}

      <h3 className="text-sm font-semibold uppercase tracking-wider text-[#D27939] font-mono">
        {plan.name}
      </h3>

      <div className="mt-3 mb-1">
        <span className="text-3xl font-light tracking-tight text-foreground">
          {plan.price}
        </span>
        <span className="ml-1.5 text-sm font-light text-muted-foreground">
          {plan.period}
        </span>
      </div>

      <p className="text-[13px] font-light text-muted-foreground leading-relaxed mb-5 min-h-[42px]">
        {plan.description}
      </p>

      <PlanScheduleNotice
        plan={plan}
        isCurrent={isCurrent}
        isDowngradeTarget={isDowngradeTarget}
        scheduledChange={scheduledChange}
        changeDate={changeDate}
      />

      <ul className="mb-6 flex flex-col gap-2.5">
        {plan.features.map((feature) => {
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
    if (planTier === currentTier) {
      return;
    }
    if (planTier === "free" && currentTier === "pro-suspend") {
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
                aria-label="Back"
              >
                <IconArrowLeft size={16} stroke={1.8} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Back</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div>
          <h3 className="text-sm font-medium text-foreground">Compare plans</h3>
          <p className="text-[13px] text-muted-foreground">
            Upgrade or downgrade anytime.
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
  if (tier === "pro-suspend") {
    return "No plan";
  }
  return tier.charAt(0).toUpperCase() + tier.slice(1);
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
  const downgradeTarget = isTeam ? selectedTarget : "pro-suspend";
  const targetLabel = formatTierLabel(downgradeTarget);

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
          <DialogTitle>Downgrade plan</DialogTitle>
          <DialogDescription>
            {isTeam && isLockedTarget
              ? `Downgrade to ${targetLabel}?`
              : isTeam
                ? "Choose which plan to downgrade to."
                : "Are you sure you want to cancel your Pro plan?"}
          </DialogDescription>
        </DialogHeader>

        {isTeam && isLockedTarget && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
            Your Team access remains active until the current billing period
            ends. After that, this workspace moves to {targetLabel}.
          </p>
        )}

        {!isTeam && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
            Your Pro access remains active until the current billing period
            ends. After that, this workspace moves to No plan and agents cannot
            run until you upgrade again.
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
                  Pro
                </span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {proPlanPrice}
                </span>
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                return setSelectedTarget("pro-suspend");
              }}
              className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                selectedTarget === "pro-suspend"
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div>
                <span className="text-sm font-semibold text-foreground">
                  No plan
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
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading
              ? "Downgrading..."
              : downgradeTarget === "pro-suspend"
                ? "Cancel subscription"
                : `Downgrade to ${targetLabel}`}
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
  const periodText = changeDate
    ? ` It will renew on ${formatBillingDate(changeDate)}.`
    : "";
  const description =
    scheduledChange?.type === "downgrade"
      ? `This will cancel the scheduled downgrade to ${scheduledTargetLabel(
          scheduledChange,
        )}. Your ${planLabel} plan will continue renewing.`
      : `This will undo the scheduled cancellation for your ${planLabel} plan.${periodText}`;

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
          <DialogTitle>Restore {planLabel} plan?</DialogTitle>
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
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={loading}>
            {loading ? "Restoring..." : "Restore plan"}
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
  const showUpgrade =
    (isPaid && currentTier !== "team" && !hasScheduledChange) || !isPaid;
  const showDowngrade = isPaid && !hasScheduledChange;
  const showRestore = isPaid && hasScheduledChange;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {showRestore && (
        <Button
          size="sm"
          className="rounded-lg h-8 text-xs"
          disabled={loading}
          onClick={onRestore}
        >
          Restore plan
        </Button>
      )}
      {showUpgrade && (
        <Button
          size="sm"
          className="rounded-lg h-8 text-xs"
          disabled={loading}
          onClick={onUpgrade}
        >
          Upgrade
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
          Downgrade
        </Button>
      )}
    </div>
  );
}

function shouldShowBuyCreditsSection(
  hasBillingStatus: boolean,
  currentTier: BillingTier,
): boolean {
  return hasBillingStatus && currentTier !== "pro-suspend";
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
    return `Ends on ${date}`;
  }
  if (scheduledChange?.type === "downgrade") {
    return `Downgrades to ${scheduledTargetLabel(scheduledChange)} on ${date}`;
  }
  return `Renews ${date}`;
}

export function OrgBillingTab() {
  const pricingOpen = useGet(billingSubPage$);
  const billingScrollTarget = useGet(billingScrollTarget$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const setBillingScrollTarget = useSet(setBillingScrollTarget$);
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
  const currentPlanLabel =
    currentTier === "pro-suspend"
      ? "No active plan"
      : `${formatTierLabel(currentTier)} plan`;
  const showBuyCredits = shouldShowBuyCreditsSection(
    status !== null,
    currentTier,
  );

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
        <h3 className="text-sm font-medium text-foreground">Plan</h3>
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
                Could not load billing status.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  return reloadBilling();
                }}
              >
                Retry
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
                    {periodLabel ?? "No active subscription"}
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
                      Your {formatTierLabel(currentTier)} plan has been
                      cancelled and will end on {formatBillingDate(changeDate)}.
                    </p>
                  </div>
                </>
              )}
              {isDowngrading && changeDate && (
                <>
                  <div className="h-0 zero-border-t mx-5" />
                  <div className="px-5 py-3">
                    <p className="text-[13px] text-amber-600 dark:text-amber-400">
                      Your {formatTierLabel(currentTier)} plan will downgrade to{" "}
                      {scheduledTargetLabel(scheduledChange)} on{" "}
                      {formatBillingDate(changeDate)}.
                    </p>
                  </div>
                </>
              )}
              {isPaid && (
                <>
                  <div className="h-0 zero-border-t mx-5" />
                  <div className="flex items-center justify-between gap-4 px-5 py-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        Manage billing
                      </p>
                      <p className="text-[13px] text-muted-foreground mt-0.5">
                        Subscription, payment method, and invoices in Stripe.
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 h-8 text-xs gap-1.5"
                      disabled={loading}
                      onClick={() => {
                        return detach(portal(pageSignal), Reason.DomCallback);
                      }}
                    >
                      Manage
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
                  Compare all plans
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
        <div
          ref={(el) => {
            if (el && billingScrollTarget === "buy-credits") {
              window.setTimeout(() => {
                el.scrollIntoView({ block: "start", behavior: "smooth" });
                setBillingScrollTarget(null);
              }, 0);
            }
          }}
        >
          <BuyCreditsSection />
        </div>
      )}

      {status && (
        <AutoRechargeSection
          currentTier={currentTier}
          loading={loading}
          variant="settings"
        />
      )}

      <DowngradeConfirmDialog currentTier={currentTier} />
      <RestorePlanConfirmDialog
        currentTier={currentTier}
        periodEnd={periodEnd}
        scheduledChange={scheduledChange}
      />
    </div>
  );
}
