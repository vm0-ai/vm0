import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeCreditPurchasePreview$,
  confirmCreditPurchase$,
  creditPurchasePreview$,
} from "../../../../signals/zero-page/billing.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

function formatCreditPurchaseAmount(
  amountCents: number,
  currency: string,
): string {
  return formatLocalizedNumber(amountCents / 100, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CreditPurchaseConfirmDialog() {
  const { t } = useTranslation();
  const preview = useGet(creditPurchasePreview$);
  const close = useSet(closeCreditPurchasePreview$);
  const pageSignal = useGet(pageSignal$);
  const [confirmLoadable, confirm] = useLoadableSet(confirmCreditPurchase$);
  const confirming = confirmLoadable.state === "loading";
  const error = confirmLoadable.state === "hasError";

  return (
    <Dialog
      open={preview !== null}
      onOpenChange={(open) => {
        if (!open && !confirming) {
          close();
        }
      }}
    >
      {preview && (
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.billing.credits.reviewTitle;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.billing.credits.reviewDescription;
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-1 divide-y divide-border/70 border-y border-border/70">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-4">
              <p className="text-sm font-semibold text-foreground">
                {t(($) => {
                  return $.billing.concurrency.dueNow;
                })}
              </p>
              <p className="text-right text-2xl font-semibold tabular-nums tracking-tight text-primary">
                {formatCreditPurchaseAmount(
                  preview.amountCents,
                  preview.currency,
                )}
              </p>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-4">
              <p className="text-sm font-semibold text-foreground">
                {t(($) => {
                  return $.billing.common.credits;
                })}
              </p>
              <p className="text-right text-2xl font-semibold tabular-nums tracking-tight text-primary">
                +{formatLocalizedNumber(preview.credits)}
              </p>
            </div>
          </div>

          {error && (
            <p className="text-sm text-destructive">
              {t(($) => {
                return $.billing.credits.reviewError;
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
