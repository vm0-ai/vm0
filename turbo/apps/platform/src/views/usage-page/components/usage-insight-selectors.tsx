import { useGet, useSet } from "ccstate-react";
import {
  range$,
  setRange$,
  type InsightRange,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";

export function UsageInsightSelectors() {
  const range = useGet(range$);
  const setRange = useSet(setRange$);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        value={range}
        onValueChange={(v) => {
          setRange(v as InsightRange);
        }}
      >
        <SelectTrigger
          aria-label="Date range"
          className="h-8 w-[120px] text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="today">Today</SelectItem>
          <SelectItem value="yesterday">Yesterday</SelectItem>
          <SelectItem value="7d">Last 7 days</SelectItem>
          <SelectItem value="28d">Last 28 days</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
