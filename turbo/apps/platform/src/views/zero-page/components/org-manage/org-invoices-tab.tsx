import { IconDownload } from "@tabler/icons-react";
import { cn } from "@vm0/ui";

const cardBorder = { border: "0.7px solid hsl(var(--gray-400))" } as const;

const ROW_GRID = "grid grid-cols-[1fr_6.5rem_5rem_2rem] gap-x-4 items-center";

type InvoiceType = "plan" | "top-up";

interface MockInvoice {
  label: string;
  date: string;
  amount: string;
  type: InvoiceType;
}

const MOCK_INVOICES: MockInvoice[] = [
  { label: "Pro plan", date: "Mar 1, 2026", amount: "$40.00", type: "plan" },
  {
    label: "10,000 credits",
    date: "Feb 15, 2026",
    amount: "$20.00",
    type: "top-up",
  },
  { label: "Pro plan", date: "Feb 1, 2026", amount: "$40.00", type: "plan" },
  { label: "Pro plan", date: "Jan 1, 2026", amount: "$40.00", type: "plan" },
  {
    label: "5,000 credits",
    date: "Dec 15, 2025",
    amount: "$9.00",
    type: "top-up",
  },
];

const DOT_CLASS: Record<InvoiceType, string> = {
  plan: "bg-primary",
  "top-up": "bg-emerald-500",
};

export function OrgInvoicesTab() {
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl bg-card" style={cardBorder}>
        <div
          className={cn(
            ROW_GRID,
            "px-5 py-2.5 text-[13px] font-medium text-foreground",
          )}
        >
          <div>Description</div>
          <div>Date</div>
          <div>Amount</div>
          <div />
        </div>
        <div className="h-px bg-border/40 mx-5" />

        {MOCK_INVOICES.map((inv, i) => (
          <div key={`${inv.date}-${inv.label}`}>
            {i > 0 && <div className="h-px bg-border/40 mx-5" />}
            <div className={cn(ROW_GRID, "px-5 py-3.5")}>
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    DOT_CLASS[inv.type],
                  )}
                  aria-hidden
                />
                <p className="text-sm text-foreground truncate">{inv.label}</p>
              </div>
              <div className="text-[13px] text-muted-foreground tabular-nums">
                {inv.date}
              </div>
              <div className="text-[13px] text-foreground tabular-nums">
                {inv.amount}
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                  aria-label="Download invoice"
                >
                  <IconDownload size={14} stroke={1.5} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
