import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import type { CreditPurchasePreviewResponse } from "@okouai/api-contracts/contracts/billing";
import { Button } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import {
  closeCreditPurchasePreview$,
  confirmCreditPurchase$,
  creditPurchasePreview$,
} from "../../../../signals/okou-page/billing.ts";
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

function CreditPurchaseConfirmDialogContent({
  preview,
}: {
  readonly preview: CreditPurchasePreviewResponse;
}) {
  const { t } = useTranslation();
  const close = useSet(closeCreditPurchasePreview$);
  const pageSignal = useGet(pageSignal$);
  const [confirmLoadable, confirm] = useLoadableSet(confirmCreditPurchase$);
  const confirming = confirmLoadable.state === "loading";
  const error = confirmLoadable.state === "hasError";

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

        <div className="mt-1">
          <p className="pb-0.5 pt-1 text-xs font-medium text-muted-foreground">
            {t(($) => {
              return $.billing.credits.today;
            })}
          </p>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t-[0.7px] border-border py-3.5">
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.billing.credits.dueNow;
              })}
            </p>
            <p className="text-right text-3xl font-light tracking-tight tabular-nums text-foreground">
              {formatCreditPurchaseAmount(
                preview.amountCents,
                preview.currency,
              )}
            </p>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t-[0.7px] border-[hsl(var(--gray-100))] py-2.5">
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.billing.credits.creditsAdded;
              })}
            </p>
            <p className="text-right text-sm font-medium tabular-nums text-foreground">
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
                  return $.billing.credits.payAndAddCredits;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CreditPurchaseConfirmDialog() {
  const preview = useGet(creditPurchasePreview$);

  if (!preview) {
    return null;
  }

  return (
    <CreditPurchaseConfirmDialogContent
      key={preview.previewToken}
      preview={preview}
    />
  );
}
