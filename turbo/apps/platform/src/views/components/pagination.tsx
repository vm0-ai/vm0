import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

const ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;

interface PaginationProps {
  currentPage: number;
  totalPages?: number;
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
  totalPages,
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

  const handleRowsPerPageChange = (value: string) => {
    const limit = Number.parseInt(value, 10);
    onRowsPerPageChange(limit);
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-4 sm:gap-8">
      {/* Rows per page selector */}
      <div className="flex items-center gap-2">
        <span className="pr-2 text-sm font-medium text-foreground whitespace-nowrap">
          Rows per page
        </span>
        <Select
          value={String(rowsPerPage)}
          onValueChange={handleRowsPerPageChange}
        >
          <SelectTrigger className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROWS_PER_PAGE_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Page indicator */}
      <span className="pr-2 text-sm font-medium text-foreground whitespace-nowrap">
        Page {currentPage}
        {totalPages !== undefined ? ` of ${totalPages}` : ""}
      </span>

      {/* Navigation buttons */}
      <div className="flex items-center gap-2">
        {/* Back two pages */}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={onBackTwoPages}
          disabled={!canGoBackTwo}
        >
          <IconChevronsLeft className="size-6" />
        </Button>
        {/* Previous page */}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={onPrevPage}
          disabled={!hasPrev}
        >
          <IconChevronLeft className="size-6" />
        </Button>
        {/* Next page */}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={onNextPage}
          disabled={!hasNext || isLoading}
        >
          <IconChevronRight className="size-6" />
        </Button>
        {/* Forward two pages */}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={onForwardTwoPages}
          disabled={!hasNext || isLoading}
        >
          <IconChevronsRight className="size-6" />
        </Button>
      </div>
    </div>
  );
}
