import { useSet, useGet } from "ccstate-react";
import { IconSearch } from "@tabler/icons-react";
import { Input } from "@vm0/ui";
import {
  setSearch$,
  searchQueryValue$,
} from "../../signals/logs-page/logs-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function LogsSearch() {
  const searchQuery = useGet(searchQueryValue$);
  const setSearchFn = useSet(setSearch$);
  const pageSignal = useGet(pageSignal$);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      const value = e.currentTarget.value;
      detach(
        setSearchFn({ search: value, signal: pageSignal }),
        Reason.DomCallback,
      );
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value;
    if (value !== searchQuery) {
      detach(
        setSearchFn({ search: value, signal: pageSignal }),
        Reason.DomCallback,
      );
    }
  };

  return (
    <div className="relative w-full sm:w-64">
      <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        placeholder="Search agents..."
        defaultValue={searchQuery}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className="pl-9"
      />
    </div>
  );
}
