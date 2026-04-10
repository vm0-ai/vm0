import { useLastLoadable } from "ccstate-react";
import { IconCircleCheck, IconDownload } from "@tabler/icons-react";
import {
  cn,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { invoicesAsync$ } from "../../../../signals/zero-page/billing.ts";

const cardBorder = { border: "0.7px solid hsl(var(--gray-400))" } as const;

const ROW_GRID = "grid grid-cols-[1fr_8rem_6rem_3rem] gap-x-6 items-center";

function formatDate(unixTimestamp: number): string {
  return new Date(unixTimestamp * 1000).toLocaleDateString("en-US");
}

function formatAmount(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function OrgInvoicesTab() {
  const invoicesLoadable = useLastLoadable(invoicesAsync$);

  const invoices =
    invoicesLoadable.state === "hasData" ? invoicesLoadable.data.invoices : [];

  if (invoicesLoadable.state === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">Loading invoices...</p>
      </div>
    );
  }

  if (invoices.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">No invoices yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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

        {invoices.map((inv, i) => {
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
                            aria-label="Download invoice"
                          >
                            <IconDownload size={14} stroke={1.5} />
                          </a>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          <p className="text-xs">Download invoice</p>
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
