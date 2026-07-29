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
          return $.shared.pagination.backTwo;
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
          return $.shared.pagination.previous;
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
          return $.shared.pagination.next;
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
          return $.shared.pagination.forwardTwo;
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
  const { i18n, t } = useTranslation();
  const canGoBackTwo = currentPage > 1;
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const formatNumber = (value: number): string => {
    return value.toLocaleString(locale);
  };

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
          {t(($) => {
            return $.shared.pagination.rowsPerPage;
          })}
        </span>
        <Select
          value={String(rowsPerPage)}
          onValueChange={handleRowsPerPageChange}
        >
          <SelectTrigger
            aria-label={t(($) => {
              return $.shared.pagination.rowsPerPage;
            })}
            className="zero-btn-morandi h-8 w-[72px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROWS_PER_PAGE_OPTIONS.map((option) => {
              return (
                <SelectItem key={option} value={String(option)}>
                  {formatNumber(option)}
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
        {totalPages === undefined
          ? t(
              ($) => {
                return $.shared.pagination.page;
              },
              { currentPage: formatNumber(currentPage) },
            )
          : t(
              ($) => {
                return $.shared.pagination.pageOf;
              },
              {
                currentPage: formatNumber(currentPage),
                totalPages: formatNumber(totalPages),
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
