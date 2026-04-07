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
  cn,
} from "@vm0/ui";

const ROWS_PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;

interface PaginationProps {
  currentPage: number;
  totalPages?: number;
  rowsPerPage: number;
  hasNext: boolean;
  hasPrev: boolean;
  isLoading?: boolean;
  /** Override text/button styling for the label spans. */
  labelClassName?: string;
  /** Override styling for navigation buttons. */
  buttonClassName?: string;
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
  labelClassName,
  buttonClassName,
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
        <span
          className={cn(
            "pr-2 text-sm font-medium text-foreground whitespace-nowrap",
            labelClassName,
          )}
        >
          Rows per page
        </span>
        <Select
          value={String(rowsPerPage)}
          onValueChange={handleRowsPerPageChange}
        >
          <SelectTrigger
            aria-label="Rows per page"
            className="zero-btn-morandi h-8 w-[72px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROWS_PER_PAGE_OPTIONS.map((option) => {
              return (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Page indicator */}
      <span
        className={cn(
          "pr-2 text-sm font-medium text-foreground whitespace-nowrap",
          labelClassName,
        )}
      >
        Page {currentPage}
        {totalPages !== undefined ? ` of ${totalPages}` : ""}
      </span>

      {/* Navigation buttons */}
      <div className="flex items-center gap-2">
        {/* Back two pages */}
        <Button
          aria-label="Back 2 pages"
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 bg-card", buttonClassName)}
          onClick={onBackTwoPages}
          disabled={!canGoBackTwo}
        >
          <IconChevronsLeft className="size-4" />
        </Button>
        {/* Previous page */}
        <Button
          aria-label="Previous page"
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 bg-card", buttonClassName)}
          onClick={onPrevPage}
          disabled={!hasPrev}
        >
          <IconChevronLeft className="size-4" />
        </Button>
        {/* Next page */}
        <Button
          aria-label="Next page"
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 bg-card", buttonClassName)}
          onClick={onNextPage}
          disabled={!hasNext || isLoading}
        >
          <IconChevronRight className="size-4" />
        </Button>
        {/* Forward two pages */}
        <Button
          aria-label="Forward 2 pages"
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 bg-card", buttonClassName)}
          onClick={onForwardTwoPages}
          disabled={!hasNext || isLoading}
        >
          <IconChevronsRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
