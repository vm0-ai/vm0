import type { Computed } from "ccstate";
import { useSet, useLoadable, useGet } from "ccstate-react";
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
import { Pagination } from "../components/pagination.tsx";

export function LogsPagination() {
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

  const handleRowsPerPageChange = (limit: number) => {
    detach(setRowsPerPageFn({ limit, signal: pageSignal }), Reason.DomCallback);
  };

  // Get the page computed, then load its data
  const pageComputed =
    currentPageLoadable.state === "hasData" ? currentPageLoadable.data : null;

  if (!pageComputed) {
    return (
      <Pagination
        currentPage={currentPage}
        rowsPerPage={rowsPerPage}
        hasNext={false}
        hasPrev={hasPrev}
        isLoading
        onNextPage={handleNextPage}
        onPrevPage={handlePrevPage}
        onForwardTwoPages={handleForwardTwoPages}
        onBackTwoPages={handleBackTwoPages}
        onRowsPerPageChange={handleRowsPerPageChange}
      />
    );
  }

  return (
    <LogsPaginationWithData
      pageComputed={pageComputed}
      currentPage={currentPage}
      rowsPerPage={rowsPerPage}
      hasPrev={hasPrev}
      onNextPage={handleNextPage}
      onPrevPage={handlePrevPage}
      onForwardTwoPages={handleForwardTwoPages}
      onBackTwoPages={handleBackTwoPages}
      onRowsPerPageChange={handleRowsPerPageChange}
    />
  );
}

interface LogsPaginationWithDataProps {
  pageComputed: Computed<Promise<LogsListResponse>>;
  currentPage: number;
  rowsPerPage: number;
  hasPrev: boolean;
  onNextPage: () => void;
  onPrevPage: () => void;
  onForwardTwoPages: () => void;
  onBackTwoPages: () => void;
  onRowsPerPageChange: (limit: number) => void;
}

function LogsPaginationWithData({
  pageComputed,
  currentPage,
  rowsPerPage,
  hasPrev,
  onNextPage,
  onPrevPage,
  onForwardTwoPages,
  onBackTwoPages,
  onRowsPerPageChange,
}: LogsPaginationWithDataProps) {
  const dataLoadable = useLoadable(pageComputed);

  const hasNext =
    dataLoadable.state === "hasData" && dataLoadable.data.pagination.hasMore;
  const isLoading = dataLoadable.state === "loading";

  return (
    <Pagination
      currentPage={currentPage}
      rowsPerPage={rowsPerPage}
      hasNext={hasNext}
      hasPrev={hasPrev}
      isLoading={isLoading}
      onNextPage={onNextPage}
      onPrevPage={onPrevPage}
      onForwardTwoPages={onForwardTwoPages}
      onBackTwoPages={onBackTwoPages}
      onRowsPerPageChange={onRowsPerPageChange}
    />
  );
}
