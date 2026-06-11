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
import { Input, Switch } from "@vm0/ui";
import {
  type BillingTier,
  autoRechargeConfig$,
  autoRechargeDirty$,
  discardAutoRecharge$,
  pendingEnabled$,
  setPendingEnabled$,
  formThreshold$,
  formAmount$,
  setFormThreshold$,
  setFormAmount$,
  saveAutoRecharge$,
} from "../../signals/zero-page/billing.ts";
import { UnsavedBar } from "./components/org-manage/unsaved-bar.tsx";

const CREDITS_PER_DOLLAR = 1000;

const settingsCardBorder = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

export function AutoRechargeSection({
  currentTier,
  loading = false,
}: {
  currentTier: BillingTier;
  loading?: boolean;
}) {
  const pageSignal = useGet(pageSignal$);
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
                    Trigger a purchase when your credit balance goes under this
                    number.
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
