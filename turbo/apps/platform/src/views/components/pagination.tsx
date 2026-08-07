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
import { useTranslation } from "react-i18next";
import { formatAppNumber } from "../../i18n/format.ts";

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

interface PaginationNavigationProps {
  readonly buttonClassName?: string;
  readonly canGoBackTwo: boolean;
  readonly hasNext: boolean;
  readonly hasPrev: boolean;
  readonly isLoading: boolean;
  readonly onBackTwoPages: () => void;
  readonly onForwardTwoPages: () => void;
  readonly onNextPage: () => void;
  readonly onPrevPage: () => void;
}

function PaginationNavigation({
  buttonClassName,
  canGoBackTwo,
  hasNext,
  hasPrev,
  isLoading,
  onBackTwoPages,
  onForwardTwoPages,
  onNextPage,
  onPrevPage,
}: PaginationNavigationProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-2">
      <Button
        aria-label={t(($) => {
          return $.activity.pagination.backTwo;
        })}
        variant="outline"
        size="icon"
        className={cn("h-8 w-8 bg-card", buttonClassName)}
        onClick={onBackTwoPages}
        disabled={!canGoBackTwo}
      >
        <IconChevronsLeft className="size-4" />
      </Button>
      <Button
        aria-label={t(($) => {
          return $.activity.pagination.previous;
        })}
        variant="outline"
        size="icon"
        className={cn("h-8 w-8 bg-card", buttonClassName)}
        onClick={onPrevPage}
        disabled={!hasPrev}
      >
        <IconChevronLeft className="size-4" />
      </Button>
      <Button
        aria-label={t(($) => {
          return $.activity.pagination.next;
        })}
        variant="outline"
        size="icon"
        className={cn("h-8 w-8 bg-card", buttonClassName)}
        onClick={onNextPage}
        disabled={!hasNext || isLoading}
      >
        <IconChevronRight className="size-4" />
      </Button>
      <Button
        aria-label={t(($) => {
          return $.activity.pagination.forwardTwo;
        })}
        variant="outline"
        size="icon"
        className={cn("h-8 w-8 bg-card", buttonClassName)}
        onClick={onForwardTwoPages}
        disabled={!hasNext || isLoading}
      >
        <IconChevronsRight className="size-4" />
      </Button>
    </div>
  );
}

function RowsPerPageSelect({
  rowsPerPage,
  labelClassName,
  onRowsPerPageChange,
}: Pick<
  PaginationProps,
  "rowsPerPage" | "labelClassName" | "onRowsPerPageChange"
>) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.activity.pagination.rowsPerPage;
  });

  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "pr-2 text-sm font-medium text-foreground whitespace-nowrap",
          labelClassName,
        )}
      >
        {label}
      </span>
      <Select
        value={String(rowsPerPage)}
        onValueChange={(value) => {
          onRowsPerPageChange(Number.parseInt(value, 10));
        }}
      >
        <SelectTrigger
          aria-label={label}
          className="zero-btn-morandi h-8 w-[72px]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROWS_PER_PAGE_OPTIONS.map((option) => {
            return (
              <SelectItem key={option} value={String(option)}>
                {formatAppNumber(option)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
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
  const { t } = useTranslation();
  const canGoBackTwo = currentPage > 1;
  const formattedCurrentPage = formatAppNumber(currentPage);
  const formattedTotalPages =
    totalPages === undefined ? undefined : formatAppNumber(totalPages);

  return (
    <div className="flex flex-wrap items-center justify-end gap-4 sm:gap-8">
      <RowsPerPageSelect
        rowsPerPage={rowsPerPage}
        labelClassName={labelClassName}
        onRowsPerPageChange={onRowsPerPageChange}
      />

      {/* Page indicator */}
      <span
        className={cn(
          "pr-2 text-sm font-medium text-foreground whitespace-nowrap",
          labelClassName,
        )}
      >
        {formattedTotalPages === undefined
          ? t(
              ($) => {
                return $.activity.pagination.page;
              },
              { current: formattedCurrentPage },
            )
          : t(
              ($) => {
                return $.activity.pagination.pageOf;
              },
              {
                current: formattedCurrentPage,
                total: formattedTotalPages,
              },
            )}
      </span>

      <PaginationNavigation
        buttonClassName={buttonClassName}
        canGoBackTwo={canGoBackTwo}
        hasNext={hasNext}
        hasPrev={hasPrev}
        isLoading={isLoading}
        onBackTwoPages={onBackTwoPages}
        onForwardTwoPages={onForwardTwoPages}
        onNextPage={onNextPage}
        onPrevPage={onPrevPage}
      />
    </div>
  );
}
