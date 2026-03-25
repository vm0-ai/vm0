import { type ComponentProps, useState } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { IconExternalLink, IconCrown, IconLoader2 } from "@tabler/icons-react";
import {
  billingStatusAsync$,
  billingDialogLoading$,
  startCheckout$,
  startDowngrade$,
} from "../../../../signals/zero-page/billing.ts";
import { Button, Dialog, DialogContent } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import planFreeImg from "./assets/plan-free.webp";
import planProImg from "./assets/plan-pro.webp";
import planTeamImg from "./assets/plan-team.webp";

const cardBorder = { border: "0.7px solid hsl(var(--gray-400))" } as const;

function LoadingButton({
  loading,
  children,
  ...props
}: ComponentProps<typeof Button> & { loading: boolean }) {
  return (
    <Button {...props} disabled={props.disabled || loading}>
      {loading ? (
        <IconLoader2 size={13} stroke={1.5} className="animate-spin" />
      ) : null}
      {children}
    </Button>
  );
}

interface PlanConfig {
  name: string;
  price: string;
  period: string;
  description: string;
  cta: string;
  primary?: boolean;
  badge?: string;
  image?: string;
  features: readonly string[];
  tier?: "pro" | "team";
}

const PLANS = [
  {
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
    name: "Pro",
    price: "$40",
    period: "/month",
    description: "More power and seamless collaboration for your team.",
    cta: "Upgrade to Pro",
    primary: true,
    badge: "Popular",
    image: planProImg,
    tier: "pro",
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
    name: "Team",
    price: "$200",
    period: "/month",
    description: "Scale fast with zero friction and full flexibility.",
    cta: "Upgrade to Team",
    image: planTeamImg,
    tier: "team",
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

function PlanCard({
  plan,
  onSelect,
  loading,
}: {
  plan: Readonly<PlanConfig>;
  onSelect: (tier: "pro" | "team") => void;
  loading: boolean;
}) {
  const isCurrentPlan = plan.cta === "Current plan";

  return (
    <div
      className="relative flex flex-col rounded-xl transition-transform duration-200 hover:-translate-y-0.5"
      style={{
        border: "0.7px solid hsl(var(--gray-400))",
        padding: "28px 24px",
      }}
    >
      {plan.badge && (
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
        {isCurrentPlan ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full rounded-lg h-9 text-xs"
            style={cardBorder}
            disabled
          >
            Current plan
          </Button>
        ) : plan.primary ? (
          <LoadingButton
            size="sm"
            className="w-full rounded-lg h-9 text-xs"
            loading={loading}
            onClick={() => plan.tier && onSelect(plan.tier)}
          >
            {plan.cta}
          </LoadingButton>
        ) : (
          <LoadingButton
            variant="outline"
            size="sm"
            className="w-full rounded-lg h-9 text-xs"
            style={cardBorder}
            loading={loading}
            onClick={() => plan.tier && onSelect(plan.tier)}
          >
            {plan.cta}
          </LoadingButton>
        )}
      </div>
    </div>
  );
}

function PricingDialog({
  open,
  onOpenChange,
  onSelectTier,
  loading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectTier: (tier: "pro" | "team") => void;
  loading: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[820px] p-0 gap-0 overflow-hidden"
        style={{
          border: "0.7px solid hsl(var(--gray-400))",
          borderRadius: "0.75rem",
          backgroundColor: "hsl(var(--card))",
        }}
      >
        <div className="px-6 pt-6 pb-1">
          <h2 className="text-lg font-semibold text-foreground">
            Choose your plan
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Start free and scale when you&apos;re ready. Upgrade or downgrade
            anytime.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4 px-6 py-5">
          {PLANS.map((plan) => (
            <PlanCard
              key={plan.name}
              plan={plan}
              onSelect={onSelectTier}
              loading={loading}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function OrgBillingTab() {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const billingLoading = useGet(billingDialogLoading$);
  const checkout = useSet(startCheckout$);
  const downgrade = useSet(startDowngrade$);
  const [pricingOpen, setPricingOpen] = useState(false);

  if (billingLoadable.state === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">Loading billing...</p>
      </div>
    );
  }

  const isPro =
    billingLoadable.state === "hasData" && billingLoadable.data.tier !== "free";

  const tierLabel =
    billingLoadable.state === "hasData"
      ? `${billingLoadable.data.tier.charAt(0).toUpperCase()}${billingLoadable.data.tier.slice(1)} plan`
      : "Loading...";

  const handleSelectTier = (tier: "pro" | "team") => {
    setPricingOpen(false);
    checkout(tier).catch(() => {
      toast.error("Failed to start checkout. Please try again.");
    });
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Plan</h3>
        <div className="overflow-hidden rounded-xl bg-card" style={cardBorder}>
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground flex items-center gap-2">
                {tierLabel}
              </span>
              <span className="text-[13px] text-muted-foreground">
                Your current plan
              </span>
            </div>
            {isPro ? (
              <LoadingButton
                variant="outline"
                size="sm"
                className="shrink-0 rounded-lg h-8 text-xs gap-1.5"
                style={cardBorder}
                loading={billingLoading}
                onClick={() => {
                  downgrade().catch(() => {
                    toast.error(
                      "Failed to open billing portal. Please try again.",
                    );
                  });
                }}
              >
                Manage billing
                <IconExternalLink size={13} stroke={1.5} />
              </LoadingButton>
            ) : (
              <LoadingButton
                size="sm"
                className="shrink-0 rounded-lg h-8 text-xs"
                loading={billingLoading}
                onClick={() => setPricingOpen(true)}
              >
                Upgrade
              </LoadingButton>
            )}
          </div>
          {isPro && (
            <>
              <div className="h-px bg-border/40 mx-5" />
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium text-foreground">
                    Manage billing
                  </span>
                  <span className="text-[13px] text-muted-foreground">
                    Manage your subscription, payment method, and download
                    invoices on Stripe.
                  </span>
                </div>
                <LoadingButton
                  variant="outline"
                  size="sm"
                  className="shrink-0 rounded-lg h-8 text-xs gap-1.5"
                  style={cardBorder}
                  loading={billingLoading}
                  onClick={() => {
                    downgrade().catch(() => {
                      toast.error(
                        "Failed to open billing portal. Please try again.",
                      );
                    });
                  }}
                >
                  Manage
                  <IconExternalLink size={13} stroke={1.5} />
                </LoadingButton>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Add-ons</h3>
        <div className="overflow-hidden rounded-xl bg-card" style={cardBorder}>
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Active agent
              </span>
              <span className="text-[13px] text-muted-foreground">
                1 concurrent agent · $20/mo, prorated for the current billing
                cycle
              </span>
            </div>
            {isPro ? (
              <LoadingButton
                size="sm"
                className="shrink-0 rounded-lg h-8 text-xs"
                loading={billingLoading}
              >
                Add
              </LoadingButton>
            ) : (
              <LoadingButton
                variant="outline"
                size="sm"
                className="shrink-0 rounded-lg h-8 text-xs"
                style={cardBorder}
                loading={billingLoading}
                onClick={() => setPricingOpen(true)}
              >
                Upgrade
              </LoadingButton>
            )}
          </div>
          <div className="h-px bg-border/40 mx-5" />
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm font-medium text-foreground">
                Credits
              </span>
              <span className="text-[13px] text-muted-foreground">
                1,000 credits · $20/mo, prorated for the current billing cycle
              </span>
            </div>
            {isPro ? (
              <LoadingButton
                size="sm"
                className="shrink-0 rounded-lg h-8 text-xs"
                loading={billingLoading}
              >
                Add
              </LoadingButton>
            ) : (
              <LoadingButton
                variant="outline"
                size="sm"
                className="shrink-0 rounded-lg h-8 text-xs"
                style={cardBorder}
                loading={billingLoading}
                onClick={() => setPricingOpen(true)}
              >
                Upgrade
              </LoadingButton>
            )}
          </div>
        </div>
      </section>

      <PricingDialog
        open={pricingOpen}
        onOpenChange={setPricingOpen}
        onSelectTier={handleSelectTier}
        loading={billingLoading}
      />
    </div>
  );
}
