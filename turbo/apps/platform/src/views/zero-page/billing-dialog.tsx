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
  saveAutoRecharge$,
} from "../../signals/zero-page/billing.ts";
import {
  selectedPlanTier$,
  setSelectedPlanTier$,
  autoRechargeEnabled$,
  autoRechargeThreshold$,
  autoRechargeAmount$,
  setAutoRechargeEnabled$,
  setAutoRechargeThreshold$,
  setAutoRechargeAmount$,
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
    tier: "team" as const,
    name: "Team",
    price: "$99",
    period: "/month",
    features: ["80,000 credits/month", "Credits rollover", "Priority support"],
  },
] as const;

const TIER_ORDER = {
  free: 0,
  pro: 1,
  team: 2,
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

const CREDITS_PER_DOLLAR = 1000;

function AutoRechargeSection({
  currentTier,
  loading,
}: {
  currentTier: BillingTier;
  loading: boolean;
}) {
  const save = useSet(saveAutoRecharge$);
  const enabled = useGet(autoRechargeEnabled$);
  const threshold = useGet(autoRechargeThreshold$);
  const amount = useGet(autoRechargeAmount$);
  const setEnabled = useSet(setAutoRechargeEnabled$);
  const setThreshold = useSet(setAutoRechargeThreshold$);
  const setAmount = useSet(setAutoRechargeAmount$);

  if (currentTier === "free") {
    return null;
  }

  const amountNum = Number(amount);
  const dollarAmount =
    amountNum > 0 ? (amountNum / CREDITS_PER_DOLLAR).toFixed(2) : "0.00";

  const canSave =
    !loading &&
    (!enabled || (Number(threshold) > 0 && amountNum >= CREDITS_PER_DOLLAR));

  const handleSave = () => {
    detach(
      save({
        enabled,
        ...(enabled ? { threshold: Number(threshold), amount: amountNum } : {}),
      }),
      Reason.DomCallback,
    );
  };

  return (
    <div className="border-t border-border pt-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold text-foreground">
          Auto-recharge
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
            enabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
              enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {enabled && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              When credits drop below
            </span>
            <input
              type="number"
              min={1}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              placeholder="e.g. 1000"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Recharge amount
            </span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={CREDITS_PER_DOLLAR}
                step={CREDITS_PER_DOLLAR}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 10000"
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground flex-1"
              />
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                = ${dollarAmount}
              </span>
            </div>
          </label>
        </div>
      )}

      <div className="flex justify-end mt-3">
        <Button
          size="sm"
          variant="outline"
          disabled={!canSave}
          onClick={handleSave}
        >
          {loading ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
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
      detach(checkout(selectedTier as "pro" | "team"), Reason.DomCallback);
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

        {status && (
          <AutoRechargeSection currentTier={currentTier} loading={loading} />
        )}
      </DialogContent>
    </Dialog>
  );
}
