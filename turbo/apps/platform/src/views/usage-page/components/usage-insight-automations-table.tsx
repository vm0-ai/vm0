import { useGet, useSet } from "ccstate-react";
import type { UsageInsightResponse } from "@vm0/api-contracts/contracts/zero-usage-insight";
import {
  hoveredAutomationId$,
  setHoveredAutomationId$,
} from "../../../signals/usage-page/usage-insight-signals.ts";
import { Link } from "../../router/link.tsx";
import { getCardPalette } from "../../../lib/card-palette.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";

function formatValue(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return n.toLocaleString();
}

export function UsageInsightAutomationsTable({
  data,
}: {
  data: UsageInsightResponse;
}) {
  const { automations, automationOtherCount, automationOtherCredits } = data;
  const { accent } = getCardPalette(2);
  const hoveredId = useGet(hoveredAutomationId$);
  const setHoveredId = useSet(setHoveredAutomationId$);

  if (automations.length === 0 && automationOtherCount === 0) {
    return (
      <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-3"
          style={{ color: accent }}
        >
          Automations
        </p>
        <p className="text-sm text-muted-foreground">
          No automations used in this period
        </p>
      </section>
    );
  }

  const totalCount = automations.length + automationOtherCount;
  const totalCredits = automations.reduce((s, r) => {
    return s + r.credits;
  }, automationOtherCredits);
  const maxValue = Math.max(
    1,
    ...automations.map((s) => {
      return s.credits;
    }),
  );

  return (
    <section className="bg-gray-50 rounded-[20px] p-6 border border-border/40 break-inside-avoid">
      <p
        className="text-xs font-semibold uppercase tracking-widest mb-3"
        style={{ color: accent }}
      >
        Automations
      </p>
      <p className="text-5xl font-black leading-none tabular-nums font-serif">
        {totalCount}
      </p>
      <p className="text-sm opacity-60 mt-2">
        {totalCount === 1 ? "automation" : "automations"} used{" "}
        {formatValue(totalCredits)} {totalCredits === 1 ? "credit" : "credits"}
      </p>
      <TooltipProvider delayDuration={300}>
        <ul className="flex flex-col gap-2.5 mt-4">
          {automations.map((row) => {
            const value = row.credits;
            const pct = (value / maxValue) * 100;
            const isActive =
              hoveredId === null || hoveredId === row.automationId;
            const fullName =
              row.automationDescription?.trim() || row.automationName;
            return (
              <li key={row.automationId}>
                <Link
                  pathname="/automations/:scheduleId"
                  options={{ pathParams: { scheduleId: row.automationId } }}
                  className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 rounded-md transition-all duration-150 ${
                    hoveredId === row.automationId ? "bg-foreground/5" : ""
                  } ${isActive ? "opacity-100" : "opacity-30"}`}
                  onMouseEnter={() => {
                    setHoveredId(row.automationId);
                  }}
                  onMouseLeave={() => {
                    setHoveredId(null);
                  }}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="text-sm font-medium truncate decoration-dotted underline decoration-foreground/40 decoration-[1px] underline-offset-2">
                        {fullName}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={4}
                      className="max-w-xs"
                    >
                      <p className="text-xs whitespace-normal break-words">
                        {fullName}
                      </p>
                      <p className="text-[11px] mt-1.5 pt-1.5 border-t border-white/15 opacity-80">
                        Click to open →
                      </p>
                    </TooltipContent>
                  </Tooltip>
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
          {automationOtherCount > 0 && (
            <li
              className={`grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3rem] items-center gap-3 -mx-1.5 px-1.5 py-1 transition-opacity duration-150 ${
                hoveredId === null ? "opacity-100" : "opacity-30"
              }`}
            >
              <span className="text-sm text-muted-foreground truncate col-span-2">
                +{automationOtherCount} more{" "}
                {automationOtherCount === 1 ? "automation" : "automations"}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground text-right">
                {formatValue(automationOtherCredits)}
              </span>
            </li>
          )}
        </ul>
      </TooltipProvider>
    </section>
  );
}
