import { useLoadable, useGet, useSet } from "ccstate-react";
import {
  range$,
  setRange$,
  groupBy$,
  setGroupBy$,
  metric$,
  setMetric$,
  usageInsightAsync$,
  type InsightRange,
  type InsightGroupBy,
  type InsightMetric,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui";
import { UsageInsightBarChart } from "./usage-insight-bar-chart.tsx";
import { UsageInsightSchedulesTable } from "./usage-insight-schedules-table.tsx";
import { UsageInsightChatsTable } from "./usage-insight-chats-table.tsx";
import { UsageInsightTotalsBar } from "./usage-insight-totals-bar.tsx";

export function UsageInsightView() {
  const range = useGet(range$);
  const setRange = useSet(setRange$);
  const groupBy = useGet(groupBy$);
  const setGroupBy = useSet(setGroupBy$);
  const metric = useGet(metric$);
  const setMetric = useSet(setMetric$);
  const loadable = useLoadable(usageInsightAsync$);

  const isLoading = loadable.state === "loading";
  const isError = loadable.state === "hasError";
  const data = loadable.state === "hasData" ? loadable.data : null;

  const handleRangeChange = (val: string) => {
    setRange(val as InsightRange);
  };

  const handleGroupByChange = (val: string) => {
    setGroupBy(val as InsightGroupBy);
  };

  const handleMetricChange = (val: string) => {
    setMetric(val as InsightMetric);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap pb-1">
        <h2 className="text-sm font-medium text-foreground">Usage Insights</h2>
        <div className="flex items-center gap-2">
          <Select value={range} onValueChange={handleRangeChange}>
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
          <Select value={groupBy} onValueChange={handleGroupByChange}>
            <SelectTrigger
              aria-label="Group by"
              className="h-8 w-[110px] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="source">By Source</SelectItem>
              <SelectItem value="agent">By Agent</SelectItem>
            </SelectContent>
          </Select>
          <Select value={metric} onValueChange={handleMetricChange}>
            <SelectTrigger
              aria-label="Metric"
              className="h-8 w-[100px] text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="credits">Credits</SelectItem>
              <SelectItem value="tokens">Tokens</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {data && (
        <UsageInsightTotalsBar
          data={data}
          metric={metric}
          groupBy={groupBy}
          range={range}
        />
      )}

      {isLoading && !data && (
        <div className="h-[280px] animate-pulse bg-muted/20 rounded-[20px]" />
      )}
      {isError && (
        <div
          className="rounded-[20px] bg-card px-5 py-8 text-center text-sm text-muted-foreground border border-border/40"
          role="alert"
        >
          Failed to load usage insights. Please try again later.
        </div>
      )}
      {data && (
        <UsageInsightBarChart
          buckets={data.buckets}
          metric={metric}
          groupBy={groupBy}
          range={range}
        />
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <UsageInsightSchedulesTable data={data} metric={metric} />
          <UsageInsightChatsTable data={data} metric={metric} />
        </div>
      )}
    </div>
  );
}
