import { Card } from "@vm0/ui/components/ui/card";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@vm0/ui/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@vm0/ui/components/ui/table";
import { AppShell } from "../layout/app-shell.tsx";
import { useGet } from "ccstate-react";
import {
  agentsList$,
  agentsLoading$,
  agentsError$,
  schedules$,
  getAgentScheduleStatus,
} from "../../signals/agents-page/agents-list.ts";
import { Bed, Settings, Clock } from "lucide-react";
import type { ComposeListItem } from "@vm0/core";

export function AgentsPage() {
  return (
    <AppShell
      breadcrumb={["Agents"]}
      title="Agents"
      subtitle="A list of all your active agents"
    >
      <div className="flex flex-col gap-5 px-8 pb-8">
        <AgentsListSection />
      </div>
    </AppShell>
  );
}

function AgentsListSection() {
  const agents = useGet(agentsList$);
  const schedules = useGet(schedules$);
  const loading = useGet(agentsLoading$);
  const error = useGet(agentsError$);

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-8 text-center">
          <p className="text-sm text-muted-foreground">Loading agents...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-8 text-center">
          <p className="text-sm text-destructive">Error: {error}</p>
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No agents found. Create your first agent with the CLI.
          </p>
        </div>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Your agents</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Schedule status</TableHead>
          <TableHead>Last edit</TableHead>
          <TableHead className="w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((agent) => {
          const hasSchedule = getAgentScheduleStatus(agent.name, schedules);
          return (
            <TableRow key={agent.name}>
              <TableCell>
                <span className="font-medium">{agent.name}</span>
              </TableCell>
              <TableCell>
                <span className="text-sm">Claude code</span>
              </TableCell>
              <TableCell>
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
              </TableCell>
              <TableCell>
                <span className="text-sm">
                  {new Date(agent.updatedAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </span>
              </TableCell>
              <TableCell>
                <Dialog>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DialogTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <Settings className="h-4 w-4" />
                          </Button>
                        </DialogTrigger>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Manage in Claude Code</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <DialogContent className="max-w-2xl">
                    <DialogHeader>
                      <DialogTitle>Manage {agent.name}</DialogTitle>
                      <DialogDescription>
                        How to manage this agent in Claude Code
                      </DialogDescription>
                    </DialogHeader>
                    <AgentCommandsSection agent={agent} />
                  </DialogContent>
                </Dialog>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function AgentCommandsSection({ agent }: { agent: ComposeListItem }) {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-medium text-foreground mb-2">
          1. Manage my agent
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          Optimize and modify your agent in Claude Code:
        </p>
        <Card className="flex items-center justify-between p-4 font-mono">
          <code className="text-sm overflow-x-auto text-muted-foreground">
            /vm0-agent manage {agent.name}
          </code>
          <CopyButton text={`/vm0-agent manage ${agent.name}`} />
        </Card>
      </div>
      <div>
        <h2 className="text-base font-medium text-foreground mb-2">
          2. Schedule my agent
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          Configure schedule for your agent:
        </p>
        <Card className="flex items-center justify-between p-4 font-mono">
          <code className="text-sm overflow-x-auto text-muted-foreground">
            /vm0-agent schedule {agent.name}
          </code>
          <CopyButton text={`/vm0-agent schedule ${agent.name}`} />
        </Card>
      </div>
      <div>
        <h2 className="text-base font-medium text-foreground mb-2">
          Troubleshooting
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          If you encounter any issues, run this command in your terminal before
          entering Claude Code to initialize the vm0-agent skill:
        </p>
        <Card className="flex items-center justify-between p-4 font-mono">
          <code className="text-sm overflow-x-auto text-muted-foreground">
            vm0 setup-claude
          </code>
          <CopyButton text="vm0 setup-claude" />
        </Card>
      </div>
    </section>
  );
}
