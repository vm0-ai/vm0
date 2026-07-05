import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { IconLayoutGrid, IconList } from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";

import {
  allOrgAutomationEntries$,
  allOrgAutomationsLoaded$,
  type OrgAutomationEntry,
} from "../../signals/zero-page/zero-automations.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import {
  automationListTab$,
  setAutomationListTab$,
} from "../../signals/automation-page/automation-list-tab.ts";
import { AutomationCalendarView } from "./automation-calendar-view.tsx";
import { AutomationListView } from "./automation-list-view.tsx";
import { WEEKDAY_LABELS, type CombinedEntry } from "./automation-utils";

export type { CombinedEntry } from "./automation-utils";

export function buildCombinedAutomations(
  entries: OrgAutomationEntry[],
): CombinedEntry[] {
  return entries.map((entry) => {
    return {
      id: entry.id,
      time: entry.time,
      prompt: entry.prompt,
      description: entry.description,
      enabled: entry.enabled,
      name: entry.name,
      intervalSeconds: entry.intervalSeconds,
      agentLabel: entry.displayName ?? entry.agentId,
      agentId: entry.agentId,
      timezone: entry.timezone,
      nextRunAt: entry.nextRunAt,
      lastRunAt: entry.lastRunAt,
      chatThreadId: entry.chatThreadId,
      triggerSummary: entry.triggerSummary,
    };
  });
}

const SKELETON_LIST_KEYS = ["s-0", "s-1", "s-2", "s-3", "s-4"] as const;
const SKELETON_ROW_KEYS = ["r-0", "r-1", "r-2", "r-3"] as const;

function AutomationListSkeleton() {
  return (
    <div
      className="w-full overflow-x-auto"
      data-testid="automation-list-skeleton"
    >
      <table className="w-full text-sm border-collapse [&_tr>:first-child]:pl-5 [&_tr>:last-child]:pr-5">
        <thead>
          <tr className="border-b border-border/40 bg-card text-left text-sm text-muted-foreground">
            <th
              className="py-3 pr-2 w-[5rem] align-middle font-medium"
              scope="col"
            >
              Agent
            </th>
            <th
              className="py-3 pr-4 min-w-0 align-middle font-medium"
              scope="col"
            >
              Instruction
            </th>
            <th
              className="py-3 px-2 min-w-[6.5rem] max-w-[9rem] align-middle font-medium"
              scope="col"
            >
              Runs at
            </th>
          </tr>
        </thead>
        <tbody>
          {SKELETON_LIST_KEYS.map((key) => {
            return (
              <tr key={key} className="border-b border-border/50 last:border-0">
                <td className="py-2.5 pr-2 align-middle w-[5rem]">
                  <Skeleton className="h-4 w-14 rounded-md" />
                </td>
                <td className="py-2.5 pr-4 align-middle min-w-0 max-w-[1px]">
                  <Skeleton className="h-4 w-full max-w-md" />
                </td>
                <td className="py-2.5 px-2 align-middle min-w-[6.5rem] max-w-[9rem] overflow-hidden">
                  <Skeleton className="h-4 w-full max-w-[8rem] rounded-md" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AutomationCalendarSkeleton() {
  return (
    <section
      className="flex flex-col gap-2 p-5"
      data-testid="automation-calendar-skeleton"
    >
      <Skeleton className="h-4 w-20" />
      <div className="rounded-xl zero-border bg-muted/20 overflow-hidden">
        <div className="grid grid-cols-8">
          <div className="bg-muted/50 p-2 border-b border-r border-border/60 h-9" />
          {WEEKDAY_LABELS.map((day) => {
            return (
              <div
                key={day}
                className="bg-muted/50 p-2 border-b border-border/60 flex justify-center"
              >
                <Skeleton className="h-4 w-8" />
              </div>
            );
          })}
          {SKELETON_ROW_KEYS.map((rowKey, row) => {
            return (
              <div key={rowKey} className="contents">
                <div className="bg-muted/30 p-2 border-r border-b border-border/60 flex items-center">
                  <Skeleton className="h-3 w-12" />
                </div>
                {WEEKDAY_LABELS.map((day, col) => {
                  return (
                    <div
                      key={`${rowKey}-${day}`}
                      className="min-h-[52px] p-1.5 border-r border-b border-border/60 flex items-center justify-center"
                    >
                      {(row + col) % 3 === 0 && (
                        <Skeleton className="h-6 w-full rounded" />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export function ZeroAutomationsPage() {
  const entriesLoadable = useLastLoadable(allOrgAutomationEntries$);
  const entries: OrgAutomationEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];
  const loaded = useGet(allOrgAutomationsLoaded$);
  const activeListTab = useGet(automationListTab$);
  const setActiveListTab = useSet(setAutomationListTab$);
  const navigate = useSet(detachedNavigateTo$);
  const combinedAutomations = buildCombinedAutomations(entries);
  const agentOrder = [
    ...new Set(
      combinedAutomations.map((entry) => {
        return entry.agentLabel;
      }),
    ),
  ] as const;

  const openAutomationDetail = (entry: CombinedEntry) => {
    navigate("/automations/:automationId", {
      pathParams: { automationId: entry.id },
    });
  };

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-3 md:pt-10 pb-0 md:pb-3">
        <div className="mx-auto max-w-[900px] flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 hidden md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Automations
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Legacy scheduled automations in your workspace.
            </p>
          </div>
          <Tabs
            value={activeListTab}
            onValueChange={(value) => {
              if (value === "list" || value === "calendar") {
                setActiveListTab(value);
              }
            }}
            className="shrink-0"
          >
            <TabsList className="zero-tabs h-9 gap-1 px-1 py-1">
              <TabsTrigger
                value="calendar"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconLayoutGrid size={14} stroke={1.5} />
                Calendar
              </TabsTrigger>
              <TabsTrigger
                value="list"
                className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
              >
                <IconList size={14} stroke={1.5} />
                List
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-3 pb-8">
        <div className="mx-auto max-w-[900px]">
          <div className="zero-card overflow-hidden pb-3">
            {!loaded ? (
              activeListTab === "calendar" ? (
                <AutomationCalendarSkeleton />
              ) : (
                <AutomationListSkeleton />
              )
            ) : activeListTab === "list" ? (
              <AutomationListView
                entries={combinedAutomations}
                getAgentLabel={(entry) => {
                  return entry.agentLabel;
                }}
                onOpenDetails={openAutomationDetail}
              />
            ) : (
              <AutomationCalendarView
                entries={combinedAutomations}
                agentOrder={agentOrder}
                getAgentLabel={(entry) => {
                  return entry.agentLabel;
                }}
                onEdit={openAutomationDetail}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
