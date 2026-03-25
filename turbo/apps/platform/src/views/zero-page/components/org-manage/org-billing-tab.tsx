import { useGet, useSet, useLoadable } from "ccstate-react";
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
  billingDialogLoading$,
  apiTierToBillingTier,
  type BillingTier,
} from "../../../../signals/zero-page/billing.ts";
import { Button } from "@vm0/ui";
import planFreeImg from "./assets/plan-free.webp";
import planProImg from "./assets/plan-pro.webp";
import planTeamImg from "./assets/plan-team.webp";
import { detach, Reason } from "../../../../signals/utils.ts";
import { AutoRechargeSection } from "../../billing-dialog.tsx";
import {
  billingSubPage$,
  setBillingSubPage$,
} from "../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

const sectionCardStyle = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

function tierRank(t: BillingTier): number {
  if (t === "free") {
    return 0;
  }
  if (t === "pro") {
    return 1;
  }
  return 2;
}

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
      "1 active agent",
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
      "2 active agents",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Credits rollover (1 month)",
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
      "5 active agents",
      "Unlimited total agents",
      "Bring your own LLM keys",
      "Credits rollover (3 months)",
      "Priority support",
    ],
  },
] as const;

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
    <div
      className="relative flex flex-col rounded-xl transition-transform duration-200 hover:-translate-y-0.5"
      style={{
        border: "0.7px solid hsl(var(--gray-400))",
        padding: "28px 24px",
      }}
    >
      {"badge" in plan && plan.badge && (
        <span
          className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground"
          style={{
            border: "0.7px solid hsl(var(--gray-400))",
            backgroundColor: "hsl(var(--gray-0))",
          }}
        >
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

      <h3
        className="text-sm font-semibold uppercase tracking-wider"
        style={{ color: "#ed4e01", fontFamily: "var(--font-mono, monospace)" }}
      >
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
        {plan.features.map((feature) => (
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
        ))}
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
          size="sm"
          className="w-full rounded-lg h-9 text-xs"
          style={
            !("primary" in plan && plan.primary) && !isCurrent
              ? sectionCardStyle
              : undefined
          }
          disabled={loading || isCurrent}
          onClick={() => onAction(plan.tier)}
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
  const loading = useGet(billingDialogLoading$);
  const checkout = useSet(startCheckout$);
  const portal = useSet(startDowngrade$);

  const handlePlanAction = (planTier: BillingTier) => {
    if (planTier === currentTier) {
      return;
    }
    if (planTier === "free" || tierRank(planTier) < tierRank(currentTier)) {
      detach(portal(pageSignal), Reason.DomCallback);
      return;
    }
    if (planTier !== "pro" && planTier !== "team") {
      return;
    }
    detach(checkout(planTier, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          aria-label="Back"
        >
          <IconArrowLeft size={16} stroke={1.8} />
        </button>
        <div>
          <h3 className="text-sm font-medium text-foreground">Compare plans</h3>
          <p className="text-[13px] text-muted-foreground">
            Upgrade or downgrade anytime.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {PLANS.map((plan) => (
          <PlanCard
            key={plan.tier}
            plan={plan}
            currentTier={currentTier}
            loading={loading}
            onAction={handlePlanAction}
          />
        ))}
      </div>
    </div>
  );
}

function formatTierLabel(tier: BillingTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

export function OrgBillingTab() {
  const pricingOpen = useGet(billingSubPage$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const setPricingOpen = (v: boolean) => setBillingSubPage(v);
  const pageSignal = useGet(pageSignal$);
  const reloadBilling = useSet(reloadBillingStatus$);
  const portal = useSet(startDowngrade$);
  const statusLoadable = useLoadable(billingStatusAsync$);
  const loading = useGet(billingDialogLoading$);

  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const statusLoading = statusLoadable.state === "loading";
  const statusError = statusLoadable.state === "hasError";

  const currentTier = apiTierToBillingTier(status?.tier);
  const isPaid = currentTier !== "free";
  const periodEnd = status?.currentPeriodEnd;
  const periodLabel =
    periodEnd !== undefined && periodEnd !== null && periodEnd !== ""
      ? `Renews ${new Date(periodEnd).toLocaleDateString()}`
      : null;

  const openPortal = () => {
    detach(portal(pageSignal), Reason.DomCallback);
  };

  if (pricingOpen) {
    return (
      <PricingPage
        currentTier={currentTier}
        onBack={() => setPricingOpen(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Plan</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={sectionCardStyle}
        >
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
                className="rounded-lg"
                style={sectionCardStyle}
                onClick={() => reloadBilling()}
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
                <div className="flex items-center gap-2 shrink-0">
                  {isPaid && currentTier !== "team" && (
                    <Button
                      size="sm"
                      className="rounded-lg h-8 text-xs"
                      disabled={loading}
                      onClick={() => setPricingOpen(true)}
                    >
                      Upgrade
                    </Button>
                  )}
                  {!isPaid && (
                    <Button
                      size="sm"
                      className="rounded-lg h-8 text-xs"
                      disabled={loading}
                      onClick={() => setPricingOpen(true)}
                    >
                      Upgrade
                    </Button>
                  )}
                  {isPaid && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-lg h-8 text-xs"
                      style={sectionCardStyle}
                      disabled={loading}
                      onClick={openPortal}
                    >
                      Downgrade
                    </Button>
                  )}
                </div>
              </div>
              {isPaid && (
                <>
                  <div className="h-px bg-border/40 mx-5" />
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
                      className="shrink-0 rounded-lg h-8 text-xs gap-1.5"
                      style={sectionCardStyle}
                      disabled={loading}
                      onClick={openPortal}
                    >
                      Manage
                      <IconExternalLink size={13} stroke={1.5} />
                    </Button>
                  </div>
                </>
              )}
              <div className="h-px bg-border/40" />
              <button
                type="button"
                className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left transition-colors bg-muted/20 hover:bg-muted/35"
                onClick={() => setPricingOpen(true)}
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
    </div>
  );
}
