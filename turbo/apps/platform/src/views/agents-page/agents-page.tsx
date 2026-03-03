import { Button } from "@vm0/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui/components/ui/table";
import { AppShell } from "../layout/app-shell.tsx";
import { AgentsListSkeleton } from "./agents-list-skeleton.tsx";
import { useGet, useLastResolved, useResolved } from "ccstate-react";
import {
  agentsList$,
  agentsLoading$,
  agentsError$,
  schedules$,
  agentsMissingItems$,
  getAgentScheduleStatus,
} from "../../signals/agents-page/agents-list.ts";
import { defaultModelProvider$ } from "../../signals/external/model-providers.ts";
import { useNavigationHandler } from "../router/link.tsx";
import { getUILabel } from "../settings-page/provider-ui-config.ts";
import { Bed, Settings, Clock, AlertTriangle } from "lucide-react";
import type { ComposeListItem } from "@vm0/core";

export function AgentsPage() {
  return (
    <AppShell
      breadcrumb={["Agents"]}
      title="Agents"
      subtitle="Your agents, their schedules, and when they were last updated"
    >
      <div className="flex flex-col gap-5 px-4 sm:px-6 pb-8">
        <AgentsListSection />
      </div>
    </AppShell>
  );
}

function AgentsListSection() {
  const agents = useGet(agentsList$);
  const schedules = useGet(schedules$);
  const missingItems = useLastResolved(agentsMissingItems$);
  const loading = useGet(agentsLoading$);
  const error = useGet(agentsError$);
  const defaultProvider = useResolved(defaultModelProvider$);

  // Create a map for quick lookup
  const missingMap = new Map(missingItems?.map((a) => [a.agentName, a]));

  if (loading) {
    return <AgentsListSkeleton />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-8 text-center">
          <p className="text-sm text-destructive">Whoops! {error}</p>
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-8 text-center space-y-4">
          <p className="text-sm text-muted-foreground">
            No agents yet. Time to create your first one.
          </p>
          <div className="flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">Get started:</p>
            <code className="px-3 py-2 text-xs bg-muted rounded-md font-mono text-foreground">
              npm install -g @vm0/cli && vm0 onboard
            </code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="h-10 px-3 w-[25%] min-w-[120px]">
            <span className="block truncate whitespace-nowrap">
              Your agents
            </span>
          </TableHead>
          <TableHead className="h-10 px-3 w-[25%] min-w-[120px]">
            <span className="block truncate whitespace-nowrap">
              Model provider
            </span>
          </TableHead>
          <TableHead className="h-10 px-3 w-[20%] min-w-[120px]">
            <span className="block truncate whitespace-nowrap">
              Schedule status
            </span>
          </TableHead>
          <TableHead className="h-10 pl-3 pr-6 w-[20%] min-w-[100px]">
            <span className="block truncate whitespace-nowrap">Last edit</span>
          </TableHead>
          <TableHead className="h-10 w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => {
          const hasSchedule = getAgentScheduleStatus(agent.name, schedules);
          const missing = missingMap.get(agent.name);
          const missingCount = missing
            ? missing.missingSecrets.length + missing.missingVariables.length
            : 0;
          return (
            <AgentRow
              key={agent.name}
              agent={agent}
              hasSchedule={hasSchedule}
              missingCount={missingCount}
              modelProviderLabel={
                defaultProvider ? getUILabel(defaultProvider.type) : "N/A"
              }
            />
          );
        })}
      </TableBody>
    </Table>
  );
}

function AgentRow({
  agent,
  hasSchedule,
  missingCount,
  modelProviderLabel,
}: {
  agent: ComposeListItem;
  hasSchedule: boolean;
  missingCount: number;
  modelProviderLabel: string;
}) {
  const { onClick: handleRowClick } = useNavigationHandler("/agents/:name", {
    pathParams: { name: agent.name },
  });

  return (
    <TableRow className="h-[53px]">
      <TableCell
        className="px-3 py-2 cursor-pointer w-[25%] min-w-[120px]"
        onClick={handleRowClick}
      >
        <div className="flex flex-col gap-1">
          <span className="block truncate whitespace-nowrap font-medium">
            {agent.name}
          </span>
          {missingCount > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3 flex-shrink-0" />
              <span className="truncate">
                Missing {missingCount} environment variable
                {missingCount > 1 ? "s" : ""}
              </span>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell
        className="px-3 py-2 cursor-pointer w-[25%] min-w-[120px]"
        onClick={handleRowClick}
      >
        <span className="block truncate whitespace-nowrap text-sm">
          {modelProviderLabel}
        </span>
      </TableCell>
      <TableCell
        className="px-3 py-2 cursor-pointer w-[20%] min-w-[120px]"
        onClick={handleRowClick}
      >
        <div className="truncate whitespace-nowrap">
          {hasSchedule ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
              <Clock className="h-3 w-3 text-sky-600" />
              Scheduled
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground">
              <Bed className="h-3 w-3 text-sky-600" />
              No schedule
            </span>
          )}
        </div>
      </TableCell>
      <TableCell
        className="pl-3 pr-6 py-2 cursor-pointer w-[20%] min-w-[100px]"
        onClick={handleRowClick}
      >
        <span className="block truncate whitespace-nowrap text-sm">
          {new Date(agent.updatedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
        </span>
      </TableCell>
      <TableCell className="pl-0 pr-4 py-2 w-12">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={handleRowClick}>
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>View details</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </TableCell>
    </TableRow>
  );
}
