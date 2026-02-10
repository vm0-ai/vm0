import { useSet, useGet } from "ccstate-react";
import { IconSearch } from "@tabler/icons-react";
import { Input } from "@vm0/ui";
import {
  setSearch$,
  searchQueryValue$,
} from "../../signals/logs-page/logs-signals.ts";

export function LogsSearch() {
  const searchQuery = useGet(searchQueryValue$);
  const setSearchFn = useSet(setSearch$);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      setSearchFn(e.currentTarget.value);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const value = e.currentTarget.value;
    if (value !== searchQuery) {
      setSearchFn(value);
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
