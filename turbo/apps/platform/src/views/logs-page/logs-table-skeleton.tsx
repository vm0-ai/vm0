import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";

function LogsTableHeader() {
  return (
    <TableHeader className="bg-muted">
      <TableRow className="hover:bg-transparent">
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[20%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Run ID</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[20%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Session ID</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[15%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Agent</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[12%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Framework</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[13%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">Status</span>
        </TableHead>
        <TableHead className="h-10 px-3 text-sm font-medium text-foreground w-[15%] min-w-[120px]">
          <span className="block truncate whitespace-nowrap">
            Generate time
          </span>
        </TableHead>
        <TableHead className="h-10 w-[44px] px-2" />
      </TableRow>
    </TableHeader>
  );
}

export function LogsTableSkeleton() {
  return (
    <Table>
      <LogsTableHeader />
      <TableBody>
        {Array.from({ length: 8 }, (_, i) => (
          <TableRow key={`skeleton-${i}`} className="h-[49px]">
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-24" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-28" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-20" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-16" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-6 w-20 rounded-full" />
            </TableCell>
            <TableCell className="px-3 py-2 min-w-[120px]">
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell className="px-2 py-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
