import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { detach, Reason } from "../../signals/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@vm0/ui/components/ui/dialog";
import { Button } from "@vm0/ui";
import { IconCheck } from "@tabler/icons-react";
import {
  type BillingTier,
  billingDialogOpen$,
  billingDialogLoading$,
  billingStatusAsync$,
  closeBillingDialog$,
  startCheckout$,
  startDowngrade$,
} from "../../signals/zero-page/billing.ts";
import {
  selectedPlanTier$,
  setSelectedPlanTier$,
} from "../../signals/zero-page/billing-dialog-state.ts";

const PLANS = [
  {
    tier: "free" as const,
    name: "Free",
    price: "$0",
    period: "/month",
    features: ["2,000 starter credits", "Community support"],
  },
  {
    tier: "pro" as const,
    name: "Pro",
    price: "$29",
    period: "/month",
    features: ["20,000 credits/month", "Credits rollover", "Priority support"],
  },
  {
    tier: "max" as const,
    name: "Max",
    price: "$99",
    period: "/month",
    features: ["80,000 credits/month", "Credits rollover", "Priority support"],
  },
] as const;

const TIER_ORDER = {
  free: 0,
  pro: 1,
  max: 2,
} as const satisfies Record<BillingTier, number>;

function PlanCard({
  plan,
  isCurrent,
  isSelected,
  onSelect,
}: {
  plan: (typeof PLANS)[number];
  isCurrent: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex flex-col rounded-lg border p-4 text-left transition-colors ${
        isSelected
          ? "border-primary ring-2 ring-primary/20"
          : "border-border hover:border-muted-foreground/30"
      }`}
    >
      <div className="flex items-center justify-between w-full mb-2">
        <span className="text-sm font-semibold text-foreground">
          {plan.name}
        </span>
        {isCurrent && (
          <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
            Current
          </span>
        )}
      </div>
      <div className="mb-3">
        <span className="text-2xl font-light text-foreground">
          {plan.price}
        </span>
        <span className="text-sm text-muted-foreground">{plan.period}</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {plan.features.map((feature) => (
          <li
            key={feature}
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
          >
            <IconCheck size={14} className="shrink-0 text-primary" />
            {feature}
          </li>
        ))}
      </ul>
    </button>
  );
}

export function BillingDialog() {
  const open = useGet(billingDialogOpen$);
  const loading = useGet(billingDialogLoading$);
  const statusLoadable = useLastLoadable(billingStatusAsync$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const close = useSet(closeBillingDialog$);
  const checkout = useSet(startCheckout$);
  const downgrade = useSet(startDowngrade$);
  const selectedTier = useGet(selectedPlanTier$);
  const setSelectedTier = useSet(setSelectedPlanTier$);

  const currentTier: BillingTier = (status?.tier as BillingTier) ?? "free";

  const selectedOrder = TIER_ORDER[selectedTier];
  const currentOrder = TIER_ORDER[currentTier];
  const isUpgrade = selectedOrder > currentOrder;
  const isDowngrade = selectedOrder < currentOrder;

  const handleAction = () => {
    if (isUpgrade) {
      detach(checkout(selectedTier as "pro" | "max"), Reason.DomCallback);
    } else if (isDowngrade) {
      detach(downgrade(), Reason.DomCallback);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Choose your plan</DialogTitle>
          <DialogDescription>
            {status
              ? `You are on the ${currentTier.charAt(0).toUpperCase() + currentTier.slice(1)} plan with ${status.credits.toLocaleString()} credits.`
              : "Select a plan to get started."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 mt-2">
          {PLANS.map((plan) => (
            <PlanCard
              key={plan.tier}
              plan={plan}
              isCurrent={plan.tier === currentTier}
              isSelected={plan.tier === selectedTier}
              onSelect={() => setSelectedTier(plan.tier)}
            />
          ))}
        </div>

        {(isUpgrade || isDowngrade) && (
          <div className="flex justify-end mt-4">
            <Button
              disabled={loading}
              variant={isDowngrade ? "outline" : "default"}
              onClick={handleAction}
            >
              {loading
                ? "Redirecting..."
                : isUpgrade
                  ? `Upgrade to ${selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)}`
                  : "Manage subscription"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
