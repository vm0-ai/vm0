import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui/components/ui/table";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";

export function AgentsListSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="h-10">Your agents</TableHead>
          <TableHead className="h-10">Provider</TableHead>
          <TableHead className="h-10">Schedule status</TableHead>
          <TableHead className="h-10">Last edit</TableHead>
          <TableHead className="h-10 w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 8 }, (_, i) => (
          <TableRow key={`skeleton-${i}`} className="h-[53px]">
            <TableCell className="px-3 py-2">
              <Skeleton className="h-5 w-32" />
            </TableCell>
            <TableCell className="px-3 py-2">
              <Skeleton className="h-4 w-24" />
            </TableCell>
            <TableCell className="px-3 py-2">
              <Skeleton className="h-7 w-28 rounded-lg" />
            </TableCell>
            <TableCell className="px-3 py-2">
              <Skeleton className="h-4 w-28" />
            </TableCell>
            <TableCell className="px-2 py-2">
              <Skeleton className="h-9 w-9 rounded-lg" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
