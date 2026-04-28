import { useGet, useSet } from "ccstate-react";
import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  hoveredScheduleId$,
  setHoveredScheduleId$,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import { Link } from "../../router/link.tsx";
import { getCardPalette } from "../../../lib/card-palette.ts";

function formatValue(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export function UsageInsightSchedulesTable({
  data,
}: {
  data: UsageInsightResponse;
}) {
  const { schedules, scheduleOtherCount, scheduleOtherCredits } = data;
  const { accent } = getCardPalette(2);
  const hoveredId = useGet(hoveredScheduleId$);
  const setHoveredId = useSet(setHoveredScheduleId$);

  if (schedules.length === 0 && scheduleOtherCount === 0) {
    return (
      <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{ color: accent }}
        >
          Schedules
        </p>
        <p className="text-sm text-muted-foreground">
          No schedules used in this period
        </p>
      </section>
    );
  }

  const totalCount = schedules.length + scheduleOtherCount;
  const maxValue = Math.max(
    1,
    ...schedules.map((s) => {
      return s.credits;
    }),
  );

  return (
    <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Schedules
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalCount}
      </p>
      <ul className="flex flex-col gap-2.5 mt-4">
        {schedules.map((row) => {
          const value = row.credits;
          const pct = (value / maxValue) * 100;
          const isActive = hoveredId === null || hoveredId === row.scheduleId;
          return (
            <li key={row.scheduleId}>
              <Link
                pathname="/schedules/:scheduleId"
                options={{ pathParams: { scheduleId: row.scheduleId } }}
                className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 rounded-md transition-all duration-150 ${
                  hoveredId === row.scheduleId ? "bg-foreground/5" : ""
                } ${isActive ? "opacity-100" : "opacity-30"}`}
                onMouseEnter={() => {
                  setHoveredId(row.scheduleId);
                }}
                onMouseLeave={() => {
                  setHoveredId(null);
                }}
              >
                <span className="text-sm font-medium truncate decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-2">
                  {row.scheduleDescription?.trim() || row.scheduleName}
                </span>
                <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, backgroundColor: accent }}
                  />
                </div>
                <span className="text-xs tabular-nums opacity-70 text-right">
                  {formatValue(value)}
                </span>
              </Link>
            </li>
          );
        })}
        {scheduleOtherCount > 0 && (
          <li
            className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 transition-opacity duration-150 ${
              hoveredId === null ? "opacity-100" : "opacity-30"
            }`}
          >
            <span className="text-sm text-muted-foreground truncate col-span-2">
              +{scheduleOtherCount} more{" "}
              {scheduleOtherCount === 1 ? "schedule" : "schedules"}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground text-right">
              {formatValue(scheduleOtherCredits)}
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}
