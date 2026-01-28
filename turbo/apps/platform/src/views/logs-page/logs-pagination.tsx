import type { Computed } from "ccstate";
import { useSet, useLoadable, useGet } from "ccstate-react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import type { LogsListResponse } from "../../signals/logs-page/types.ts";
import {
  currentPageLogs$,
  hasPrevPage$,
  goToNextPage$,
  goToPrevPage$,
  goForwardTwoPages$,
  goBackTwoPages$,
  setRowsPerPage$,
  rowsPerPageValue$,
  currentPageNumber$,
} from "../../signals/logs-page/logs-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function LogsPagination() {
  const rowsPerPageOptions = [10, 20, 50, 100] as const;
  const currentPageLoadable = useLoadable(currentPageLogs$);
  const hasPrev = useGet(hasPrevPage$);
  const currentPage = useGet(currentPageNumber$);
  const rowsPerPage = useGet(rowsPerPageValue$);
  const goToNext = useSet(goToNextPage$);
  const goToPrev = useSet(goToPrevPage$);
  const goForwardTwo = useSet(goForwardTwoPages$);
  const goBackTwo = useSet(goBackTwoPages$);
  const setRowsPerPageFn = useSet(setRowsPerPage$);
  const pageSignal = useGet(pageSignal$);

  const handleNextPage = () => {
    detach(goToNext(pageSignal), Reason.DomCallback);
  };

  const handlePrevPage = () => {
    detach(goToPrev(pageSignal), Reason.DomCallback);
  };

  const handleForwardTwoPages = () => {
    detach(goForwardTwo(pageSignal), Reason.DomCallback);
  };

  const handleBackTwoPages = () => {
    detach(goBackTwo(pageSignal), Reason.DomCallback);
  };

  const handleRowsPerPageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const limit = Number.parseInt(e.target.value, 10);
    detach(setRowsPerPageFn({ limit, signal: pageSignal }), Reason.DomCallback);
  };

  // Get the page computed, then load its data
  const pageComputed =
    currentPageLoadable.state === "hasData" ? currentPageLoadable.data : null;

  // Can go back two pages if current page > 1
  const canGoBackTwo = currentPage > 1;

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
          {rowsPerPageOptions.map((option) => (
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
          onClick={handleBackTwoPages}
          disabled={!canGoBackTwo}
        >
          <IconChevronsLeft className="h-4 w-4" />
        </Button>
        {/* Previous page */}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={handlePrevPage}
          disabled={!hasPrev}
        >
          <IconChevronLeft className="h-4 w-4" />
        </Button>
        {/* Next page */}
        {pageComputed ? (
          <NextPageButton
            pageComputed={pageComputed}
            onClick={handleNextPage}
          />
        ) : (
          <Button variant="outline" size="icon" className="h-8 w-8" disabled>
            <IconChevronRight className="h-4 w-4" />
          </Button>
        )}
        {/* Forward two pages */}
        {pageComputed ? (
          <ForwardTwoPagesButton
            pageComputed={pageComputed}
            onClick={handleForwardTwoPages}
          />
        ) : (
          <Button variant="outline" size="icon" className="h-8 w-8" disabled>
            <IconChevronsRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

interface NextPageButtonProps {
  pageComputed: Computed<Promise<LogsListResponse>>;
  onClick: () => void;
}

function NextPageButton({ pageComputed, onClick }: NextPageButtonProps) {
  const dataLoadable = useLoadable(pageComputed);

  const hasNext =
    dataLoadable.state === "hasData" && dataLoadable.data.pagination.hasMore;
  const isLoading = dataLoadable.state === "loading";

  return (
    <Button
      variant="outline"
      size="icon"
      className="h-8 w-8"
      onClick={onClick}
      disabled={!hasNext || isLoading}
    >
      <IconChevronRight className="h-4 w-4" />
    </Button>
  );
}

interface ForwardTwoPagesButtonProps {
  pageComputed: Computed<Promise<LogsListResponse>>;
  onClick: () => void;
}

function ForwardTwoPagesButton({
  pageComputed,
  onClick,
}: ForwardTwoPagesButtonProps) {
  const dataLoadable = useLoadable(pageComputed);

  const hasNext =
    dataLoadable.state === "hasData" && dataLoadable.data.pagination.hasMore;
  const isLoading = dataLoadable.state === "loading";

  return (
    <Button
      variant="outline"
      size="icon"
      className="h-8 w-8"
      onClick={onClick}
      disabled={!hasNext || isLoading}
    >
      <IconChevronsRight className="h-4 w-4" />
    </Button>
  );
}
