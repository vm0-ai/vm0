import { FeatureSwitchKey } from "@okouai/core";
import { Button } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  closeSubscriptionPurchasePreview$,
  confirmSubscriptionPurchase$,
  subscriptionPurchasePreview$,
} from "../../../../signals/zero-page/billing.ts";

function formatAmount(amountCents: number, currency: string): string {
  return formatLocalizedNumber(amountCents / 100, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function SubscriptionPurchaseConfirmDialog() {
  const { t } = useTranslation();
  const enabled =
    useGet(featureSwitch$)[FeatureSwitchKey.SavedBillingCreditPurchase] ??
    false;
  const state = useGet(subscriptionPurchasePreview$);
  const close = useSet(closeSubscriptionPurchasePreview$);
  const pageSignal = useGet(pageSignal$);
  const [confirmLoadable, confirm] = useLoadableSet(
    confirmSubscriptionPurchase$,
  );
  const confirming = confirmLoadable.state === "loading";
  const error = confirmLoadable.state === "hasError";
  if (!enabled) {
    return null;
  }
  const preview = state?.preview;
  const planName = preview
    ? preview.tier === "pro"
      ? t(($) => {
          return $.billing.plans.pro.name;
        })
      : t(($) => {
          return $.billing.plans.team.name;
        })
    : "";

  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          close();
        }
      }}
    >
      {preview && (
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.billing.plans.usagePacks.orderSummary;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.billing.concurrency.reviewDescription;
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-1 divide-y divide-border/70 border-y border-border/70">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-4">
              <p className="text-sm font-semibold text-foreground">
                {t(($) => {
                  return $.billing.plans.selectedPlan;
                })}
              </p>
              <p className="text-right text-sm font-semibold text-foreground">
                {planName}
              </p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-4">
              <p className="text-sm font-semibold text-foreground">
                {t(($) => {
                  return $.billing.concurrency.dueNow;
                })}
              </p>
              <p className="text-right text-2xl font-semibold tabular-nums tracking-tight text-primary">
                {formatAmount(preview.immediateAmountCents, preview.currency)}
              </p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-4">
              <p className="text-sm font-semibold text-foreground">
                {t(($) => {
                  return $.billing.concurrency.monthlyTotal;
                })}
              </p>
              <p className="text-right text-2xl font-semibold tabular-nums tracking-tight text-primary">
                {formatAmount(
                  preview.nextRecurringAmountCents,
                  preview.currency,
                )}
              </p>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">
              {t(($) => {
                return $.billing.plans.usagePacks.planChangeError;
              })}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={confirming} onClick={close}>
              {t(($) => {
                return $.billing.common.cancel;
              })}
            </Button>
            <Button
              disabled={confirming}
              onClick={() => {
                detach(confirm(pageSignal), Reason.DomCallback);
              }}
            >
              {confirming
                ? t(($) => {
                    return $.billing.common.updating;
                  })
                : t(($) => {
                    return $.billing.common.confirm;
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
