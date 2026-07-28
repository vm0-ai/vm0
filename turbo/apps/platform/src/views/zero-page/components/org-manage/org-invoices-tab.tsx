import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { IconCircleCheck, IconDownload } from "@tabler/icons-react";
import {
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import type { FormEvent } from "react";
import {
  downloadMonthlyReceipts$,
  initializeReceiptDownloadRange$,
  invoicesAsync$,
  receiptDownloadRange$,
  receiptDownloadRangeExceedsLimit$,
  setReceiptDownloadEndMonth$,
  setReceiptDownloadStartMonth$,
} from "../../../../signals/zero-page/billing.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";

const cardBorder = { border: "0.7px solid hsl(var(--gray-400))" } as const;

const ROW_GRID = "grid grid-cols-[1fr_8rem_6rem_3rem] gap-x-6 items-center";

function formatDate(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toLocaleDateString("en-US");
}

function formatAmount(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface InvoiceMonth {
  readonly value: string;
  readonly label: string;
}

function invoiceMonths(invoices: readonly { readonly date: number }[]) {
  const months = new Map<string, InvoiceMonth>();
  for (const invoice of invoices) {
    const date = new Date(invoice.date * 1000);
    const value = `${date.getUTCFullYear()}-${String(
      date.getUTCMonth() + 1,
    ).padStart(2, "0")}`;
    months.set(value, {
      value,
      label: new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(date),
    });
  }
  return [...months.values()].sort((left, right) => {
    return right.value.localeCompare(left.value);
  });
}

function InvoiceRowsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading invoices"
      data-testid="invoice-list-skeleton"
    >
      {[0, 1, 2].map((row) => {
        return (
          <div key={row}>
            {row > 0 && <div className="h-0 zero-border-t mx-4" />}
            <div className={cn(ROW_GRID, "px-4 py-3")}>
              <div className="flex items-center gap-3">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-14 rounded-lg" />
              </div>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-14" />
              <div className="flex justify-end">
                <Skeleton className="h-7 w-7 rounded-lg" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ReceiptMonthSelect({
  id,
  label,
  name,
  value,
  months,
  onValueChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly value: string;
  readonly months: readonly InvoiceMonth[];
  readonly onValueChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-sm" htmlFor={id}>
      <span className="font-medium text-foreground">{label}</span>
      <Select name={name} value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id={id}
          aria-label={`${label} month`}
          className="h-9 w-full"
        >
          <SelectValue placeholder="Select month" />
        </SelectTrigger>
        <SelectContent>
          {months.map((month) => {
            return (
              <SelectItem key={month.value} value={month.value}>
                {month.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </label>
  );
}

function DownloadReceiptsDialog({
  months,
}: {
  readonly months: readonly InvoiceMonth[];
}) {
  const pageSignal = useGet(pageSignal$);
  const [downloadLoadable, downloadReceipts] = useLoadableSet(
    downloadMonthlyReceipts$,
  );
  const range = useGet(receiptDownloadRange$);
  const rangeExceedsLimit = useGet(receiptDownloadRangeExceedsLimit$);
  const initializeRange = useSet(initializeReceiptDownloadRange$);
  const setStartMonth = useSet(setReceiptDownloadStartMonth$);
  const setEndMonth = useSet(setReceiptDownloadEndMonth$);
  const downloading = downloadLoadable.state === "loading";
  const defaultMonth = months[0]?.value;
  const canSubmit =
    !downloading &&
    !rangeExceedsLimit &&
    range.startMonth !== "" &&
    range.endMonth !== "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    const [startMonth, endMonth] =
      range.startMonth <= range.endMonth
        ? [range.startMonth, range.endMonth]
        : [range.endMonth, range.startMonth];
    detach(
      downloadReceipts({ startMonth, endMonth }, pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (open && defaultMonth) {
          initializeRange(defaultMonth);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={downloading}
        >
          <IconDownload size={14} stroke={1.5} />
          {downloading ? "Preparing receipts..." : "Download receipts"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Download receipts</DialogTitle>
            <DialogDescription>
              Choose up to 3 consecutive months. Receipt PDFs in that range will
              be bundled into one ZIP file.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-5">
            <ReceiptMonthSelect
              id="receipt-start-month"
              label="From"
              name="startMonth"
              value={range.startMonth}
              months={months}
              onValueChange={setStartMonth}
            />
            <ReceiptMonthSelect
              id="receipt-end-month"
              label="To"
              name="endMonth"
              value={range.endMonth}
              months={months}
              onValueChange={setEndMonth}
            />
          </div>
          {rangeExceedsLimit && (
            <p role="alert" className="-mt-2 pb-5 text-sm text-destructive">
              Select a range of no more than 3 consecutive months.
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <DialogClose asChild>
              <Button type="submit" disabled={!canSubmit}>
                Download ZIP
              </Button>
            </DialogClose>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OrgInvoicesTab() {
  const invoicesLoadable = useLastLoadable(invoicesAsync$);
  const loading = invoicesLoadable.state === "loading";

  const invoices =
    invoicesLoadable.state === "hasData" ? invoicesLoadable.data.invoices : [];
  const receiptDownloadsSupported =
    invoicesLoadable.state === "hasData" &&
    invoicesLoadable.data.receiptDownloadsSupported === true;
  const months = invoiceMonths(invoices);

  if (!loading && invoices.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">No invoices yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!loading && receiptDownloadsSupported && (
        <div className="flex justify-end">
          <DownloadReceiptsDialog months={months} />
        </div>
      )}
      <div
        className="overflow-hidden rounded-[10px] bg-card"
        style={cardBorder}
      >
        <div
          className={cn(
            ROW_GRID,
            "sticky top-0 z-10 px-4 py-3 text-sm font-medium text-foreground bg-card",
          )}
        >
          <div className="text-left">Invoice</div>
          <div className="text-left">Date</div>
          <div className="text-left">Amount</div>
          <div />
        </div>
        <div className="h-0 zero-border-t mx-4" />

        {loading && <InvoiceRowsSkeleton />}

        {invoices.map((inv, i) => {
          const invoiceMonth = new Intl.DateTimeFormat("en-US", {
            month: "long",
            year: "numeric",
          }).format(new Date(inv.date * 1000));
          return (
            <div key={inv.id}>
              {i > 0 && <div className="h-0 zero-border-t mx-4" />}
              <div className={cn(ROW_GRID, "px-4 py-3")}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-foreground truncate">
                    {inv.number ?? inv.id}
                  </span>
                  {inv.status && (
                    <span className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground zero-badge">
                      <IconCircleCheck size={12} className="text-green-600" />
                      {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                    </span>
                  )}
                </div>
                <div className="text-left text-sm text-muted-foreground tabular-nums">
                  {formatDate(inv.date)}
                </div>
                <div className="text-left text-sm text-foreground tabular-nums">
                  {formatAmount(inv.amount)}
                </div>
                <div className="flex justify-end">
                  {inv.hostedInvoiceUrl ? (
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <a
                            href={inv.hostedInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                            aria-label={`Download ${invoiceMonth} invoice`}
                          >
                            <IconDownload size={14} stroke={1.5} />
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          <p className="text-xs">
                            Download {invoiceMonth} invoice
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center text-muted-foreground/30">
                      <IconDownload size={14} stroke={1.5} />
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
