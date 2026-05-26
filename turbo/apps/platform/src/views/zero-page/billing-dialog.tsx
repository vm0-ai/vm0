// TODO(#8609): split AutoRechargeSection to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@vm0/ui/components/ui/dialog";
import { Input, Switch } from "@vm0/ui";
import { IconCheck } from "@tabler/icons-react";
import {
  type BillingTier,
  apiTierToBillingTier,
  billingDialogOpen$,
  billingStatusAsync$,
  setBillingDialogOpen$,
  openDowngradeDialog$,
  saveAutoRecharge$,
  autoRechargeConfig$,
  autoRechargeDirty$,
  discardAutoRecharge$,
  pendingEnabled$,
  setPendingEnabled$,
  formThreshold$,
  formAmount$,
  setFormThreshold$,
  setFormAmount$,
} from "../../signals/zero-page/billing.ts";
import {
  selectedPlanTier$,
  setSelectedPlanTier$,
} from "../../signals/zero-page/billing-dialog-state.ts";
import { SaveAutoRechargeButton } from "./save-auto-recharge-button.tsx";
import { CheckoutButton } from "./checkout-button.tsx";
import { UnsavedBar } from "./components/org-manage/unsaved-bar.tsx";

const PLANS = [
  {
    tier: "free" as const,
    name: "Free",
    price: "$0",
    period: "/month",
    features: ["Existing free credits only", "Community support"],
  },
  {
    tier: "pro" as const,
    name: "Pro",
    price: "$20",
    period: "/month",
    features: ["20,000 credits/month", "Priority support"],
  },
  {
    tier: "team" as const,
    name: "Team",
    price: "$200",
    period: "/month",
    features: ["120,000 credits/month", "Priority support"],
  },
] as const;

const TIER_ORDER = {
  free: 0,
  "pro-suspend": 0,
  pro: 1,
  team: 2,
} as const satisfies Record<BillingTier, number>;

function formatTierLabel(tier: BillingTier): string {
  if (tier === "pro-suspend") {
    return "No plan";
  }
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

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
      aria-pressed={isSelected}
      aria-label={plan.name}
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
          <span
            aria-current="true"
            className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
          >
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
        {plan.features.map((feature) => {
          return (
            <li
              key={feature}
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
            >
              <IconCheck size={14} className="shrink-0 text-primary" />
              {feature}
            </li>
          );
        })}
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
  loading = false,
  variant = "dialog",
}: {
  currentTier: BillingTier;
  loading?: boolean;
  /** `settings`: General-tab style section + card (org manage). `dialog`: compact block for billing modal. */
  variant?: "dialog" | "settings";
}) {
  const pageSignal = useGet(pageSignal$);
  const save = useSet(saveAutoRecharge$);
  const configLoadable = useLastLoadable(autoRechargeConfig$);
  const config =
    configLoadable.state === "hasData"
      ? configLoadable.data
      : { enabled: false, threshold: "", amount: "" };

  const pendingEnabled = useGet(pendingEnabled$);
  const setPendingEnabled = useSet(setPendingEnabled$);

  const thresholdValue = useLastResolved(formThreshold$) ?? config.threshold;
  const amountValue = useLastResolved(formAmount$) ?? config.amount;
  const setThreshold = useSet(setFormThreshold$);
  const setAmount = useSet(setFormAmount$);

  const dirty = useLastResolved(autoRechargeDirty$) ?? false;
  const discard = useSet(discardAutoRecharge$);
  const [saveLoadable, doSave] = useLoadableSet(saveAutoRecharge$);
  const saving = saveLoadable.state === "loading";

  if (currentTier === "free" || currentTier === "pro-suspend") {
    return null;
  }

  const { enabled } = config;
  const displayEnabled = pendingEnabled !== null ? pendingEnabled : enabled;
  const amountNum = Number(amountValue);
  const amountParsed = Number.isFinite(amountNum) ? amountNum : 0;
  const dollarAmount =
    amountParsed > 0 ? (amountParsed / CREDITS_PER_DOLLAR).toFixed(2) : "0.00";

  const parseFormNumbers = () => {
    const tVal = Number(thresholdValue);
    const aVal = Number(amountValue);
    return {
      threshold:
        thresholdValue !== "" && Number.isFinite(tVal)
          ? tVal
          : Number(config.threshold),
      amount: amountValue !== "" && Number.isFinite(aVal) ? aVal : amountNum,
    };
  };

  const saveCurrent = (overrides?: {
    enabled?: boolean;
    threshold?: number;
    amount?: number;
  }) => {
    const e = overrides?.enabled ?? enabled;
    const inputs = parseFormNumbers();
    const t = overrides?.threshold ?? inputs.threshold;
    const a = overrides?.amount ?? inputs.amount;
    detach(
      save(
        { enabled: e, ...(e ? { threshold: t, amount: a } : {}) },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const getFormValues = (): {
    enabled: boolean;
    threshold?: number;
    amount?: number;
  } | null => {
    const { threshold: t, amount: a } = parseFormNumbers();
    if (!loading && (!displayEnabled || (t > 0 && a >= CREDITS_PER_DOLLAR))) {
      return {
        enabled: displayEnabled,
        ...(displayEnabled ? { threshold: t, amount: a } : {}),
      };
    }
    return null;
  };

  const handleSave = () => {
    const values = getFormValues();
    if (!values) {
      return;
    }
    detach(doSave(values, pageSignal), Reason.DomCallback);
  };

  const inputRowClass = "h-9 w-[200px] shrink-0";

  if (variant === "settings") {
    return (
      <>
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
                checked={displayEnabled}
                onCheckedChange={(v) => {
                  setPendingEnabled(v === enabled ? null : v);
                }}
                disabled={loading || saving}
                className="shrink-0"
                aria-label="Enable auto-recharge"
              />
            </div>
            {displayEnabled && (
              <>
                <div className="h-0 zero-border-t mx-5" />
                <div className="flex items-center justify-between gap-4 px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      When credits drop below
                    </p>
                    <p className="text-[13px] text-muted-foreground mt-0.5">
                      Trigger a purchase when your credit balance goes under
                      this number.
                    </p>
                  </div>
                  <Input
                    type="text"
                    inputMode="numeric"
                    value={thresholdValue}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v !== "" && !/^\d+$/.test(v)) {
                        return;
                      }
                      setThreshold(v);
                    }}
                    placeholder="e.g. 2000"
                    className={inputRowClass}
                    aria-label="Credit threshold for auto-recharge"
                  />
                </div>
                <div className="h-0 zero-border-t mx-5" />
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
                      type="text"
                      inputMode="numeric"
                      value={amountValue}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v !== "" && !/^\d+$/.test(v)) {
                          return;
                        }
                        setAmount(v);
                      }}
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
        {dirty && (
          <UnsavedBar
            onDiscard={discard}
            onSave={handleSave}
            saving={saving}
            saveDisabled={getFormValues() === null}
            testId="auto-recharge-unsaved-bar"
          />
        )}
      </>
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
          aria-label="Auto-recharge"
          onClick={() => {
            saveCurrent({ enabled: !enabled });
          }}
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
            <Input
              type="number"
              min={1}
              value={thresholdValue}
              onChange={(e) => {
                setThreshold(e.target.value);
              }}
              placeholder="e.g. 1000"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              Recharge amount
            </span>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={CREDITS_PER_DOLLAR}
                step={CREDITS_PER_DOLLAR}
                value={amountValue}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
                placeholder="e.g. 10000"
                className="flex-1"
              />
              <span
                aria-label={`dollar equivalent: $${dollarAmount}`}
                className="text-xs text-muted-foreground whitespace-nowrap"
              >
                = ${dollarAmount}
              </span>
            </div>
          </label>
        </div>
      )}

      <div className="flex justify-end mt-3">
        <SaveAutoRechargeButton
          getFormValues={getFormValues}
          pageSignal={pageSignal}
        />
      </div>
    </div>
  );
}

export function BillingDialog() {
  const pageSignal = useGet(pageSignal$);
  const open = useGet(billingDialogOpen$);
  const statusLoadable = useLastLoadable(billingStatusAsync$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const close = useSet(setBillingDialogOpen$);
  const openDowngrade = useSet(openDowngradeDialog$);
  const selectedTier = useGet(selectedPlanTier$);
  const setSelectedTier = useSet(setSelectedPlanTier$);

  const currentTier: BillingTier = apiTierToBillingTier(status?.tier);

  const selectedOrder = TIER_ORDER[selectedTier];
  const currentOrder = TIER_ORDER[currentTier];
  const isUpgrade = selectedOrder > currentOrder;
  const isDowngrade = selectedOrder < currentOrder;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        return !v && close(false);
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-[600px] max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Choose your plan</DialogTitle>
          <DialogDescription>
            {status
              ? currentTier === "pro-suspend"
                ? `You do not have an active plan and have ${status.credits.toLocaleString()} credits.`
                : `You are on the ${formatTierLabel(currentTier)} plan with ${status.credits.toLocaleString()} credits.`
              : "Select a plan to get started."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3 mt-2">
          {PLANS.map((plan) => {
            return (
              <PlanCard
                key={plan.tier}
                plan={plan}
                isCurrent={plan.tier === currentTier}
                isSelected={plan.tier === selectedTier}
                onSelect={() => {
                  return setSelectedTier(plan.tier);
                }}
              />
            );
          })}
        </div>

        <CheckoutButton
          selectedTier={selectedTier}
          isUpgrade={isUpgrade}
          isDowngrade={isDowngrade}
          pageSignal={pageSignal}
          openDowngrade={openDowngrade}
        />

        {status && <AutoRechargeSection currentTier={currentTier} />}
      </DialogContent>
    </Dialog>
  );
}
