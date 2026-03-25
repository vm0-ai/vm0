import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@vm0/ui/components/ui/dialog";
import { Button, Input, Switch } from "@vm0/ui";
import { IconCheck } from "@tabler/icons-react";
import {
  type BillingTier,
  apiTierToBillingTier,
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
    features: ["10,000 starter credits", "Community support"],
  },
  {
    tier: "pro" as const,
    name: "Pro",
    price: "$40",
    period: "/month",
    features: ["20,000 credits/month", "Credits rollover", "Priority support"],
  },
  {
    tier: "team" as const,
    name: "Team",
    price: "$200",
    period: "/month",
    features: ["120,000 credits/month", "Credits rollover", "Priority support"],
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

const settingsCardBorder = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

export function AutoRechargeSection({
  currentTier,
  loading,
  variant = "dialog",
}: {
  currentTier: BillingTier;
  loading: boolean;
  /** `settings`: General-tab style section + card (org manage). `dialog`: compact block for billing modal. */
  variant?: "dialog" | "settings";
}) {
  const pageSignal = useGet(pageSignal$);
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
  const amountParsed = Number.isFinite(amountNum) ? amountNum : 0;
  const dollarAmount =
    amountParsed > 0 ? (amountParsed / CREDITS_PER_DOLLAR).toFixed(2) : "0.00";

  const canSave =
    !loading &&
    (!enabled || (Number(threshold) > 0 && amountNum >= CREDITS_PER_DOLLAR));

  const handleSave = () => {
    detach(
      save(
        {
          enabled,
          ...(enabled
            ? { threshold: Number(threshold), amount: amountNum }
            : {}),
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const persistIfValid = () => {
    if (canSave) {
      handleSave();
    }
  };

  const inputRowClass =
    "h-9 w-[200px] shrink-0 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))]";

  if (variant === "settings") {
    return (
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-foreground">Auto-recharge</h3>
        <div
          className="overflow-hidden rounded-xl bg-card"
          style={settingsCardBorder}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                Automatic top-ups
              </p>
              <p className="text-[13px] text-muted-foreground mt-0.5">
                Purchase credits when your balance falls below a threshold.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => {
                setEnabled(v);
                if (!v) {
                  detach(
                    save({ enabled: false }, pageSignal),
                    Reason.DomCallback,
                  );
                  return;
                }
                const t = Number(threshold);
                const a = Number(amount);
                if (!loading && t > 0 && a >= CREDITS_PER_DOLLAR) {
                  detach(
                    save(
                      { enabled: true, threshold: t, amount: a },
                      pageSignal,
                    ),
                    Reason.DomCallback,
                  );
                }
              }}
              disabled={loading}
              className="shrink-0"
              aria-label="Enable auto-recharge"
            />
          </div>
          {enabled && (
            <>
              <div className="h-px bg-border/40 mx-5" />
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">
                    When credits drop below
                  </p>
                  <p className="text-[13px] text-muted-foreground mt-0.5">
                    Trigger a purchase when your credit balance goes under this
                    number.
                  </p>
                </div>
                <Input
                  id="org-auto-recharge-threshold"
                  type="number"
                  min={1}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  onBlur={() => persistIfValid()}
                  placeholder="e.g. 2000"
                  className={inputRowClass}
                  aria-label="Credit threshold for auto-recharge"
                />
              </div>
              <div className="h-px bg-border/40 mx-5" />
              <div className="flex items-center justify-between gap-4 px-5 py-4">
                <div className="min-w-0 flex flex-col gap-1">
                  <span className="text-xl font-semibold tabular-nums tracking-tight text-foreground">
                    ${dollarAmount}
                  </span>
                  <p className="text-[13px] font-normal text-muted-foreground">
                    Recharge amount
                  </p>
                </div>
                <div className="relative w-[200px] shrink-0">
                  <Input
                    id="org-auto-recharge-amount"
                    type="number"
                    min={CREDITS_PER_DOLLAR}
                    step={CREDITS_PER_DOLLAR}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    onBlur={() => persistIfValid()}
                    placeholder="100000"
                    className={`${inputRowClass} pr-[4.25rem] tabular-nums`}
                    aria-label="Auto-recharge credit amount in credits"
                  />
                  <span
                    className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[13px] text-muted-foreground"
                    aria-hidden
                  >
                    credits
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

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
  const pageSignal = useGet(pageSignal$);
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

  const currentTier: BillingTier = apiTierToBillingTier(status?.tier);

  const selectedOrder = TIER_ORDER[selectedTier];
  const currentOrder = TIER_ORDER[currentTier];
  const isUpgrade = selectedOrder > currentOrder;
  const isDowngrade = selectedOrder < currentOrder;

  const handleAction = () => {
    if (isUpgrade && (selectedTier === "pro" || selectedTier === "team")) {
      detach(checkout(selectedTier, pageSignal), Reason.DomCallback);
    } else if (isDowngrade) {
      detach(downgrade(pageSignal), Reason.DomCallback);
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
