import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";

const ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;

interface PaginationProps {
  currentPage: number;
  rowsPerPage: number;
  hasNext: boolean;
  hasPrev: boolean;
  isLoading?: boolean;
  onNextPage: () => void;
  onPrevPage: () => void;
  onForwardTwoPages: () => void;
  onBackTwoPages: () => void;
  onRowsPerPageChange: (limit: number) => void;
}

export function Pagination({
  currentPage,
  rowsPerPage,
  hasNext,
  hasPrev,
  isLoading = false,
  onNextPage,
  onPrevPage,
  onForwardTwoPages,
  onBackTwoPages,
  onRowsPerPageChange,
}: PaginationProps) {
  const canGoBackTwo = currentPage > 1;

  const handleRowsPerPageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const limit = Number.parseInt(e.target.value, 10);
    onRowsPerPageChange(limit);
  };

  return (
    <div className="flex items-center justify-end gap-6 py-4">
      {/* Rows per page selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Rows per page</span>
        <select
          value={rowsPerPage}
          onChange={handleRowsPerPageChange}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {ROWS_PER_PAGE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      {/* Page indicator */}
      <span className="text-sm text-muted-foreground">Page {currentPage}</span>

      {/* Navigation buttons */}
      <div className="flex items-center gap-1">
        {/* Back two pages */}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={onBackTwoPages}
          disabled={!canGoBackTwo}
        >
          <IconChevronsLeft className="h-4 w-4" />
        </Button>
        {/* Previous page */}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={onPrevPage}
          disabled={!hasPrev}
        >
          <IconChevronLeft className="h-4 w-4" />
        </Button>
        {/* Next page */}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={onNextPage}
          disabled={!hasNext || isLoading}
        >
          <IconChevronRight className="h-4 w-4" />
        </Button>
        {/* Forward two pages */}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={onForwardTwoPages}
          disabled={!hasNext || isLoading}
        >
          <IconChevronsRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
