import { useLoadable, useGet } from "ccstate-react";
import {
  range$,
  metric$,
  usageInsightAsync$,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import { UsageInsightBarChart } from "./usage-insight-bar-chart.tsx";
import { UsageInsightSchedulesTable } from "./usage-insight-schedules-table.tsx";
import { UsageInsightChatsTable } from "./usage-insight-chats-table.tsx";

export function UsageInsightView() {
  const range = useGet(range$);
  const metric = useGet(metric$);
  const loadable = useLoadable(usageInsightAsync$);

  const isLoading = loadable.state === "loading";
  const isError = loadable.state === "hasError";
  const data = loadable.state === "hasData" ? loadable.data : null;

  return (
    <div className="flex flex-col gap-3">
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
        <UsageInsightBarChart data={data} metric={metric} range={range} />
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
