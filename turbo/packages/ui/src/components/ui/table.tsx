import * as React from "react";

import { cn } from "../../lib/utils";

const Table = React.forwardRef<
  HTMLTableElement,
  React.HTMLAttributes<HTMLTableElement>
>(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-hidden rounded-lg border border-border bg-card">
    <style
      dangerouslySetInnerHTML={{
        __html: `
        .table-wrapper tbody tr:last-child {
          border-bottom: 0 !important;
        }
        .table-wrapper thead {
          border-bottom: 1px solid hsl(var(--border)) !important;
        }
        .table-wrapper thead tr {
          border-bottom: 0 !important;
        }
        .table-wrapper {
          scrollbar-width: thin;
          scrollbar-color: hsl(var(--muted-foreground) / 0.2) transparent;
        }
        .table-wrapper::-webkit-scrollbar {
          height: 6px;
        }
        .table-wrapper::-webkit-scrollbar-track {
          background: transparent;
        }
        .table-wrapper::-webkit-scrollbar-thumb {
          background-color: hsl(var(--muted-foreground) / 0.2);
          border-radius: 3px;
        }
        .table-wrapper::-webkit-scrollbar-thumb:hover {
          background-color: hsl(var(--muted-foreground) / 0.3);
        }
      `,
      }}
    />
    <div className="table-wrapper overflow-x-auto">
      <table
        ref={ref}
        className={cn(
          "w-full min-w-[764px] caption-bottom text-sm table-fixed",
          className,
        )}
        {...props}
      />
    </div>
  </div>
));
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("bg-muted", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b border-border last:!border-b-0 transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
      className,
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.HTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-10 px-4 text-left align-middle text-sm font-medium [&:has([role=checkbox])]:pr-0",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.HTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn("p-4 align-middle [&:has([role=checkbox])]:pr-0", className)}
    {...props}
  />
));
TableCell.displayName = "TableCell";

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
