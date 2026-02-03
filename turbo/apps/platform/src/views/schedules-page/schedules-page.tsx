import { Card } from "@vm0/ui/components/ui/card";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { Button } from "@vm0/ui/components/ui/button";
import { IconExternalLink } from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";

export function SchedulesPage() {
  return (
    <AppShell
      breadcrumb={["Your agents", "Schedule"]}
      title="Manage Agent Schedule"
      subtitle="Commonly used commands for managing scheduled agent runs."
    >
      <div className="flex flex-col gap-8 px-8 pb-8 max-w-3xl">
        <ClaudeCodeSection />
        <ListSchedulesSection />
        <ScheduleStatusSection />
        <DocsLink />
      </div>
    </AppShell>
  );
}

function CommandSection({
  title,
  description,
  commands,
}: {
  title: string;
  description: string;
  commands: string[];
}) {
  const commandText = commands.join("\n");
  return (
    <section>
      <h2 className="text-base font-medium text-foreground mb-2">{title}</h2>
      <p className="text-sm text-muted-foreground mb-3">{description}</p>
      <Card className="flex items-start justify-between p-4 font-mono">
        <code className="text-sm overflow-x-auto text-muted-foreground whitespace-pre-wrap">
          {commands.map((cmd, index) => (
            <div key={`${index}-${cmd}`}>{cmd || "\u00A0"}</div>
          ))}
        </code>
        <CopyButton text={commandText} />
      </Card>
    </section>
  );
}

function ClaudeCodeSection() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-base font-medium text-foreground mb-2">
          Manage with Claude Code
        </h2>
        <p className="text-sm text-muted-foreground mb-3">
          You can manage VM0 agent schedules entirely through Claude Code.
          First, install the VM0 skills plugin:
        </p>
        <Card className="flex items-start justify-between p-4 font-mono">
          <code className="text-sm overflow-x-auto text-muted-foreground whitespace-pre-wrap">
            <div>/plugin marketplace add vm0-ai/vm0-skills</div>
            <div>/plugin install vm0@vm0-skills</div>
          </code>
          <CopyButton
            text={
              "/plugin marketplace add vm0-ai/vm0-skills\n/plugin install vm0@vm0-skills"
            }
          />
        </Card>
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-3">
          After restarting Claude Code, enter the following command in Claude
          Code to manage your agent schedule:
        </p>
        <Card className="flex items-start justify-between p-4 font-mono">
          <code className="text-sm overflow-x-auto text-muted-foreground">
            /vm0-agent manage my agent schedule
          </code>
          <CopyButton text="/vm0-agent manage my agent schedule" />
        </Card>
      </div>
    </section>
  );
}

function ListSchedulesSection() {
  return (
    <CommandSection
      title="List all schedules"
      description="View all your schedules with their trigger, status, and next run time."
      commands={["vm0 schedule list"]}
    />
  );
}

function ScheduleStatusSection() {
  return (
    <CommandSection
      title="View schedule status"
      description="Show detailed status of a schedule including configuration and recent runs."
      commands={["vm0 schedule status <agent-name>"]}
    />
  );
}

function DocsLink() {
  return (
    <Button variant="outline" size="sm" asChild>
      <a
        href="https://docs.vm0.ai/docs/usage/schedule-agent"
        target="_blank"
        rel="noreferrer"
      >
        View full schedule documentation
        <IconExternalLink className="h-4 w-4 ml-2" />
      </a>
    </Button>
  );
}
