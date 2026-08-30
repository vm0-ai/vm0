import type {
  PlanPurchasePreviewResponse,
  UsagePackPurchasePreviewResponse,
} from "@okouai/api-contracts/contracts/billing";
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
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  closeSubscriptionPurchasePreview$,
  confirmSubscriptionPurchase$,
  subscriptionPurchasePreview$,
} from "../../../../signals/okou-page/billing.ts";

function formatAmount(amountCents: number, currency: string): string {
  return formatLocalizedNumber(amountCents / 100, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type SubscriptionPurchasePreview =
  | PlanPurchasePreviewResponse
  | UsagePackPurchasePreviewResponse;

function SubscriptionPurchaseSummary({
  preview,
  planName,
}: {
  readonly preview: SubscriptionPurchasePreview;
  readonly planName: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-1">
      <p className="pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.billing.credits.today;
        })}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t-[0.7px] border-border py-3.5">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.concurrency.dueNow;
          })}
        </p>
        <p className="text-right text-3xl font-light tracking-tight tabular-nums text-foreground">
          {formatAmount(preview.immediateAmountCents, preview.currency)}
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t-[0.7px] border-[hsl(var(--gray-100))] py-2.5">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.plans.usagePacks.planStep;
          })}
        </p>
        <p className="text-right text-sm font-medium text-foreground">
          {planName}
        </p>
      </div>
      <p className="pb-0.5 pt-4 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.billing.plans.usagePacks.management.everyMonth;
        })}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t-[0.7px] border-border py-3.5">
        <p className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.billing.concurrency.monthlyTotal;
          })}
        </p>
        <p className="text-right text-3xl font-light tracking-tight tabular-nums text-foreground">
          {formatAmount(preview.nextRecurringAmountCents, preview.currency)}
        </p>
      </div>
    </div>
  );
}

function SubscriptionPurchaseConfirmDialogContent({
  preview,
}: {
  readonly preview: SubscriptionPurchasePreview;
}) {
  const { t } = useTranslation();
  const close = useSet(closeSubscriptionPurchasePreview$);
  const pageSignal = useGet(pageSignal$);
  const [confirmLoadable, confirm] = useLoadableSet(
    confirmSubscriptionPurchase$,
  );
  const confirming = confirmLoadable.state === "loading";
  const error = confirmLoadable.state === "hasError";
  const planName =
    preview.tier === "pro"
      ? t(($) => {
          return $.billing.plans.pro.name;
        })
      : t(($) => {
          return $.billing.plans.team.name;
        });
  const upgradeLabel = t(
    ($) => {
      return $.billing.plans.upgradeTo;
    },
    { plan: planName },
  );
  const confirmLabel =
    preview.purchaseType === "plan"
      ? upgradeLabel
      : t(($) => {
          return $.billing.common.confirm;
        });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !confirming) {
          close();
        }
      }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {preview.purchaseType === "plan"
              ? upgradeLabel
              : t(($) => {
                  return $.billing.plans.usagePacks.orderSummary;
                })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.billing.concurrency.reviewDescription;
            })}
          </DialogDescription>
        </DialogHeader>

        <SubscriptionPurchaseSummary preview={preview} planName={planName} />

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
              : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SubscriptionPurchaseConfirmDialog() {
  const state = useGet(subscriptionPurchasePreview$);

  if (!state) {
    return null;
  }

  return (
    <SubscriptionPurchaseConfirmDialogContent
      key={state.preview.previewToken}
      preview={state.preview}
    />
  );
}
