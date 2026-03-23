import { IconCircleCheck, IconDownload } from "@tabler/icons-react";
import { cn } from "@vm0/ui";

const cardBorder = { border: "0.7px solid hsl(var(--gray-400))" } as const;

const ROW_GRID = "grid grid-cols-[1fr_8rem_6rem_3rem] gap-x-6 items-center";

const MOCK_INVOICES = [
  { id: "INV-2026-003", date: "3/1/2026", amount: "$40.00", status: "Paid" },
  { id: "INV-2026-002", date: "2/1/2026", amount: "$40.00", status: "Paid" },
  { id: "INV-2026-001", date: "1/1/2026", amount: "$40.00", status: "Paid" },
  { id: "INV-2025-012", date: "12/1/2025", amount: "$49.00", status: "Paid" },
  { id: "INV-2025-011", date: "11/1/2025", amount: "$40.00", status: "Paid" },
] as const;

export function OrgInvoicesTab() {
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
        <div className="h-px bg-border/40 mx-4" />

        {MOCK_INVOICES.map((inv, i) => (
          <div key={inv.id}>
            {i > 0 && <div className="h-px bg-border/40 mx-4" />}
            <div className={cn(ROW_GRID, "px-4 py-3")}>
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm font-medium text-foreground truncate">
                  {inv.id}
                </span>
                <span
                  className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  style={{
                    border: "0.7px solid hsl(var(--gray-400))",
                    backgroundColor: "hsl(var(--gray-0))",
                  }}
                >
                  <IconCircleCheck size={12} className="text-green-600" />
                  {inv.status}
                </span>
              </div>
              <div className="text-left text-sm text-muted-foreground tabular-nums">
                {inv.date}
              </div>
              <div className="text-left text-sm text-foreground tabular-nums">
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
