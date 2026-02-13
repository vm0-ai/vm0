import { useSet, useLoadable, useGet } from "ccstate-react";
import {
  currentPageLogs$,
  hasPrevPage$,
  goToNextPage$,
  goToPrevPage$,
  goForwardTwoPages$,
  goBackTwoPages$,
  setRowsPerPage$,
  limit$,
  currentPageNumber$,
} from "../../signals/logs-page/logs-signals.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Pagination } from "../components/pagination.tsx";

export function LogsPagination() {
  const logsLoadable = useLoadable(currentPageLogs$);
  const hasPrev = useGet(hasPrevPage$);
  const currentPage = useGet(currentPageNumber$);
  const rowsPerPage = useGet(limit$);
  const goToNext = useSet(goToNextPage$);
  const goToPrev = useSet(goToPrevPage$);
  const goForwardTwo = useSet(goForwardTwoPages$);
  const goBackTwo = useSet(goBackTwoPages$);
  const setRowsPerPageFn = useSet(setRowsPerPage$);

  const hasNext =
    logsLoadable.state === "hasData" && logsLoadable.data.pagination.hasMore;
  const isLoading = logsLoadable.state === "loading";
  const totalPages =
    logsLoadable.state === "hasData"
      ? logsLoadable.data.pagination.totalPages
      : undefined;

  const handleNextPage = () => {
    detach(goToNext(), Reason.DomCallback);
  };

  const handlePrevPage = () => {
    goToPrev();
  };

  const handleForwardTwoPages = () => {
    detach(goForwardTwo(), Reason.DomCallback);
  };

  const handleBackTwoPages = () => {
    goBackTwo();
  };

  const handleRowsPerPageChange = (limit: number) => {
    setRowsPerPageFn(limit);
  };

  return (
    <Pagination
      currentPage={currentPage}
      totalPages={totalPages}
      rowsPerPage={rowsPerPage}
      hasNext={hasNext}
      hasPrev={hasPrev}
      isLoading={isLoading}
      onNextPage={handleNextPage}
      onPrevPage={handlePrevPage}
      onForwardTwoPages={handleForwardTwoPages}
      onBackTwoPages={handleBackTwoPages}
      onRowsPerPageChange={handleRowsPerPageChange}
    />
  );
}
