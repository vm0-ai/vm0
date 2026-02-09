import { Card } from "@vm0/ui/components/ui/card";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@vm0/ui/components/ui/alert";
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
import { AgentsListSkeleton } from "./agents-list-skeleton.tsx";
import { SecretDialog } from "../settings-page/secret-dialog.tsx";
import { useGet, useResolved, useSet } from "ccstate-react";
import {
  agentsList$,
  agentsLoading$,
  agentsError$,
  schedules$,
  agentsWithMissingSecrets$,
  getAgentScheduleStatus,
} from "../../signals/agents-page/agents-list.ts";
import { openAddSecretDialog$ } from "../../signals/settings-page/secrets.ts";
import { defaultModelProvider$ } from "../../signals/external/model-providers.ts";
import { getUILabel } from "../settings-page/provider-ui-config.ts";
import { Bed, Settings, Clock, AlertTriangle, Plus } from "lucide-react";
import type { ComposeListItem } from "@vm0/core";
import { detach, Reason } from "../../signals/utils.ts";

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
      <SecretDialog />
    </AppShell>
  );
}

function AgentsListSection() {
  const agents = useGet(agentsList$);
  const schedules = useGet(schedules$);
  const agentsWithMissingSecrets = useGet(agentsWithMissingSecrets$);
  const loading = useGet(agentsLoading$);
  const error = useGet(agentsError$);
  const defaultProvider = useResolved(defaultModelProvider$);

  // Create a map for quick lookup of missing secrets
  const missingSecretsMap = new Map(
    agentsWithMissingSecrets.map((a) => [a.agentName, a.missingSecrets]),
  );

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
          const missingSecrets = missingSecretsMap.get(agent.name);
          return (
            <AgentRow
              key={agent.name}
              agent={agent}
              hasSchedule={hasSchedule}
              missingSecrets={missingSecrets}
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
  missingSecrets,
  modelProviderLabel,
}: {
  agent: ComposeListItem;
  hasSchedule: boolean;
  missingSecrets?: string[];
  modelProviderLabel: string;
}) {
  const openAddDialog = useSet(openAddSecretDialog$);

  const handleAddSecret = (secretName: string) => {
    detach(openAddDialog(secretName), Reason.DomCallback);
  };

  return (
    <Dialog>
      <TableRow className="h-[53px]">
        <DialogTrigger asChild>
          <TableCell className="px-3 py-2 cursor-pointer w-[25%] min-w-[120px]">
            <div className="flex flex-col gap-1">
              <span className="block truncate whitespace-nowrap font-medium">
                {agent.name}
              </span>
              {missingSecrets && missingSecrets.length > 0 && (
                <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                  <AlertTriangle className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">
                    Missing {missingSecrets.length} secret
                    {missingSecrets.length > 1 ? "s" : ""}
                  </span>
                </span>
              )}
            </div>
          </TableCell>
        </DialogTrigger>
        <DialogTrigger asChild>
          <TableCell className="px-3 py-2 cursor-pointer w-[25%] min-w-[120px]">
            <span className="block truncate whitespace-nowrap text-sm">
              {modelProviderLabel}
            </span>
          </TableCell>
        </DialogTrigger>
        <DialogTrigger asChild>
          <TableCell className="px-3 py-2 cursor-pointer w-[20%] min-w-[120px]">
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
        </DialogTrigger>
        <DialogTrigger asChild>
          <TableCell className="pl-3 pr-6 py-2 cursor-pointer w-[20%] min-w-[100px]">
            <span className="block truncate whitespace-nowrap text-sm">
              {new Date(agent.updatedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
          </TableCell>
        </DialogTrigger>
        <TableCell className="pl-0 pr-4 py-2 w-12">
          <TooltipProvider>
            <Tooltip>
              <DialogTrigger asChild>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm">
                    <Settings className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
              </DialogTrigger>
              <TooltipContent>
                <p>Manage in Claude Code</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
      </TableRow>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage {agent.name}</DialogTitle>
          <DialogDescription>
            How to manage this agent in Claude Code
          </DialogDescription>
        </DialogHeader>
        {missingSecrets && missingSecrets.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Missing required secrets</AlertTitle>
            <AlertDescription>
              <p className="mb-3">
                This agent requires {missingSecrets.length} secret
                {missingSecrets.length > 1 ? "s" : ""} to run. Click to add:
              </p>
              <div className="flex flex-wrap gap-2">
                {missingSecrets.map((secret) => (
                  <Button
                    key={secret}
                    variant="outline"
                    size="sm"
                    onClick={() => handleAddSecret(secret)}
                    className="h-auto py-1.5 px-2.5 text-xs border-destructive text-destructive hover:bg-destructive/10"
                  >
                    <Plus className="h-3 w-3" />
                    <code className="font-mono">{secret}</code>
                  </Button>
                ))}
              </div>
            </AlertDescription>
          </Alert>
        )}
        <AgentCommandsSection agent={agent} />
      </DialogContent>
    </Dialog>
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
