// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLoadable } from "ccstate-react";
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
  type BillingTier,
} from "../../../../signals/zero-page/billing.ts";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
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
import {
  billingSubPage$,
  setBillingSubPage$,
  selectedTarget$,
  setSelectedTarget$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const PLANS = [
  {
    tier: "free" as const,
    name: "Free",
    price: "$0",
    period: "/month",
    description: "Get started with your AI teammate for free.",
    cta: "Current plan",
    image: planFreeImg,
    features: [
      "10,000 starter credits",
      "1 concurrent run",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Community support",
    ],
  },
  {
    tier: "pro" as const,
    name: "Pro",
    price: "$40",
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
      "5 concurrent runs",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Priority support",
    ],
  },
] as const;

function getPlanPrice(tier: string): string {
  const plan = PLANS.find((p) => {
    return p.tier === tier;
  });
  return plan ? `${plan.price}${plan.period}` : "";
}

const proPlanPrice = getPlanPrice("pro");
const freePlanPrice = getPlanPrice("free");

function tierRank(t: BillingTier): number {
  if (t === "free") {
    return 0;
  }
  if (t === "pro") {
    return 1;
  }
  return 2;
}

function planButtonLabel(
  plan: (typeof PLANS)[number],
  currentTier: BillingTier,
): string {
  if (plan.tier === currentTier) {
    return "Current plan";
  }
  if (plan.tier === "free") {
    return "Manage subscription";
  }
  if (tierRank(plan.tier) > tierRank(currentTier)) {
    return plan.cta;
  }
  return "Manage subscription";
}

function PlanCard({
  plan,
  currentTier,
  loading,
  onAction,
}: {
  plan: (typeof PLANS)[number];
  currentTier: BillingTier;
  loading: boolean;
  onAction: (planTier: BillingTier) => void;
}) {
  const isCurrent = plan.tier === currentTier;
  const label = planButtonLabel(plan, currentTier);

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
          className="h-28 w-28 object-contain -mb-1"
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
          variant={
            isCurrent
              ? "outline"
              : "primary" in plan && plan.primary
                ? "default"
                : "outline"
          }
          size="default"
          className="w-full h-11 text-sm font-medium"
          disabled={loading || isCurrent}
          onClick={() => {
            return onAction(plan.tier);
          }}
        >
          {isCurrent ? "Current plan" : label}
        </Button>
      </div>
    </div>
  );
}

function PricingPage({
  currentTier,
  onBack,
}: {
  currentTier: BillingTier;
  onBack: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const loading = checkoutLoadable.state === "loading";
  const openDowngrade = useSet(openDowngradeDialog$);

  const handlePlanAction = (planTier: BillingTier) => {
    if (planTier === currentTier) {
      return;
    }
    if (planTier === "free" || tierRank(planTier) < tierRank(currentTier)) {
      openDowngrade();
      return;
    }
    if (planTier !== "pro" && planTier !== "team") {
      return;
    }
    detach(checkout(planTier, pageSignal), Reason.DomCallback);
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

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {PLANS.map((plan) => {
          return (
            <PlanCard
              key={plan.tier}
              plan={plan}
              currentTier={currentTier}
              loading={loading}
              onAction={handlePlanAction}
            />
          );
        })}
      </div>
    </div>
  );
}

function formatTierLabel(tier: BillingTier): string {
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
  const setSelectedTarget = useSet(setSelectedTarget$);

  const isTeam = currentTier === "team";

  const handleConfirm = () => {
    detach(confirm(selectedTarget, pageSignal), Reason.DomCallback);
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
          <DialogTitle>Downgrade plan</DialogTitle>
          <DialogDescription>
            {isTeam
              ? "Choose which plan to downgrade to."
              : "Are you sure you want to downgrade to Free?"}
          </DialogDescription>
        </DialogHeader>

        {isTeam && (
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
                return setSelectedTarget("free");
              }}
              className={`flex items-center justify-between rounded-lg border p-3 text-left transition-colors ${
                selectedTarget === "free"
                  ? "border-primary ring-2 ring-primary/20"
                  : "border-border hover:border-muted-foreground/30"
              }`}
            >
              <div>
                <span className="text-sm font-semibold text-foreground">
                  Free
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
              : `Downgrade to ${formatTierLabel(selectedTarget)}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PlanActionButtons({
  isPaid,
  isCancelling,
  currentTier,
  loading,
  onUpgrade,
  onDowngrade,
}: {
  isPaid: boolean;
  isCancelling: boolean;
  currentTier: BillingTier;
  loading: boolean;
  onUpgrade: () => void;
  onDowngrade: () => void;
}) {
  const showUpgrade =
    (isPaid && currentTier !== "team" && !isCancelling) || !isPaid;
  const showDowngrade = isPaid && !isCancelling;

  return (
    <div className="flex items-center gap-2 shrink-0">
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

export function OrgBillingTab() {
  const pricingOpen = useGet(billingSubPage$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const setPricingOpen = (v: boolean) => {
    return setBillingSubPage(v);
  };
  const pageSignal = useGet(pageSignal$);
  const reloadBilling = useSet(reloadBillingStatus$);
  const openDowngrade = useSet(openDowngradeDialog$);
  const [portalLoadable, portal] = useLoadableSet(startDowngrade$);
  const statusLoadable = useLoadable(billingStatusAsync$);
  const loading = portalLoadable.state === "loading";

  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const statusLoading = statusLoadable.state === "loading";
  const statusError = statusLoadable.state === "hasError";

  const currentTier = apiTierToBillingTier(status?.tier);
  const isPaid = currentTier !== "free";
  const isCancelling = status?.cancelAtPeriodEnd === true;
  const periodEnd = status?.currentPeriodEnd;
  const periodLabel =
    periodEnd !== undefined && periodEnd !== null && periodEnd !== ""
      ? isCancelling
        ? `Ends on ${new Date(periodEnd).toLocaleDateString()}`
        : `Renews ${new Date(periodEnd).toLocaleDateString()}`
      : null;

  const handleDowngrade = () => {
    openDowngrade();
  };

  if (pricingOpen) {
    return (
      <>
        <PricingPage
          currentTier={currentTier}
          onBack={() => {
            return setPricingOpen(false);
          }}
        />
        <DowngradeConfirmDialog currentTier={currentTier} />
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
                    {formatTierLabel(currentTier)} plan
                  </p>
                  <p className="text-[13px] text-muted-foreground mt-0.5">
                    {periodLabel ?? "No active subscription"}
                  </p>
                </div>
                <PlanActionButtons
                  isPaid={isPaid}
                  isCancelling={isCancelling}
                  currentTier={currentTier}
                  loading={loading}
                  onUpgrade={() => {
                    return setPricingOpen(true);
                  }}
                  onDowngrade={handleDowngrade}
                />
              </div>
              {isCancelling && periodEnd && (
                <>
                  <div className="h-0 zero-border-t mx-5" />
                  <div className="px-5 py-3">
                    <p className="text-[13px] text-amber-600 dark:text-amber-400">
                      Your {formatTierLabel(currentTier)} plan has been
                      cancelled and will end on{" "}
                      {new Date(periodEnd).toLocaleDateString()}.
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

      {status && (
        <AutoRechargeSection
          currentTier={currentTier}
          loading={loading}
          variant="settings"
        />
      )}

      <DowngradeConfirmDialog currentTier={currentTier} />
    </div>
  );
}
