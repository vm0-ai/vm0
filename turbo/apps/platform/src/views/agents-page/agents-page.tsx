import { Card } from "@vm0/ui/components/ui/card";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { Button } from "@vm0/ui/components/ui/button";
import { IconSparkles, IconExternalLink } from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";

export function AgentsPage() {
  return (
    <AppShell
      breadcrumb={["Your agents", "Agents"]}
      title="Manage Agents"
      subtitle="Commonly used commands for managing your agents."
    >
      <div className="flex flex-col gap-8 px-8 pb-8 max-w-3xl">
        <ListAgentsSection />
        <AgentStatusSection />
        <CloneAgentSection />
        <ProTip />
        <DocsLink />
      </div>
    </AppShell>
  );
}

function CommandSection({
  title,
  description,
  command,
}: {
  title: string;
  description: string;
  command: string;
}) {
  return (
    <section>
      <h2 className="text-base font-medium text-foreground mb-2">{title}</h2>
      <p className="text-sm text-muted-foreground mb-3">{description}</p>
      <Card className="flex items-center justify-between p-4 font-mono">
        <code className="text-sm overflow-x-auto text-muted-foreground">
          {command}
        </code>
        <CopyButton text={command} />
      </Card>
    </section>
  );
}

function ListAgentsSection() {
  return (
    <CommandSection
      title="List all agents"
      description="View all your deployed agents with their version and last updated time."
      command="vm0 agent list"
    />
  );
}

function AgentStatusSection() {
  return (
    <CommandSection
      title="View agent status"
      description="Show detailed status of an agent including configuration, variables, and secrets."
      command="vm0 agent status <agent-name>"
    />
  );
}

function CloneAgentSection() {
  return (
    <CommandSection
      title="Clone an agent"
      description="Clone an agent's configuration to your local directory for modification."
      command="vm0 agent clone <agent-name>"
    />
  );
}

function ProTip() {
  return (
    <Card className="bg-muted/50 border-dashed p-4">
      <div className="flex items-start gap-3">
        <IconSparkles className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-sm">Pro Tip</p>
          <p className="text-sm text-muted-foreground mt-1">
            Install{" "}
            <code className="bg-muted px-1 py-0.5 rounded text-xs">
              vm0-ai/vm0-skills
            </code>{" "}
            from the Claude marketplace to use{" "}
            <code className="bg-muted px-1 py-0.5 rounded text-xs">
              /vm0-agent
            </code>{" "}
            for viewing and modifying agents directly in Claude.
          </p>
        </div>
      </div>
    </Card>
  );
}

function DocsLink() {
  return (
    <Button variant="outline" size="sm" asChild>
      <a
        href="https://docs.vm0.ai/reference/cli"
        target="_blank"
        rel="noreferrer"
      >
        View full CLI documentation
        <IconExternalLink className="h-4 w-4 ml-2" />
      </a>
    </Button>
  );
}
