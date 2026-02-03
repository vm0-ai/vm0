import { Card } from "@vm0/ui/components/ui/card";
import { CopyButton } from "@vm0/ui/components/ui/copy-button";
import { Button } from "@vm0/ui/components/ui/button";
import { IconSparkles, IconExternalLink } from "@tabler/icons-react";
import { AppShell } from "../layout/app-shell.tsx";

export function SchedulesPage() {
  return (
    <AppShell
      breadcrumb={["CLI Reference", "Schedule"]}
      title="Schedule CLI Commands"
      subtitle="Commonly used commands for managing scheduled agent runs."
    >
      <div className="flex flex-col gap-8 px-8 pb-8 max-w-3xl">
        <ListSchedulesSection />
        <ScheduleStatusSection />
        <SetupScheduleSection />
        <ManageScheduleSection />
        <ProTip />
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

function SetupScheduleSection() {
  return (
    <CommandSection
      title="Create a schedule"
      description="Set up a new schedule for an agent. Run interactively or with flags."
      commands={[
        "# Interactive setup",
        "vm0 schedule setup <agent-name>",
        "",
        "# Daily schedule at 9am",
        'vm0 schedule setup <agent-name> --frequency daily --time 09:00 --prompt "run tasks"',
        "",
        "# Weekly schedule on Monday",
        "vm0 schedule setup <agent-name> --frequency weekly --day mon --time 09:00",
      ]}
    />
  );
}

function ManageScheduleSection() {
  return (
    <CommandSection
      title="Manage schedules"
      description="Enable, disable, or delete existing schedules."
      commands={[
        "vm0 schedule enable <agent-name>",
        "vm0 schedule disable <agent-name>",
        "vm0 schedule delete <agent-name>",
      ]}
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
            for viewing and modifying schedules directly in Claude.
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
        href="https://docs.vm0.ai/usage/schedule-agent"
        target="_blank"
        rel="noreferrer"
      >
        View full schedule documentation
        <IconExternalLink className="h-4 w-4 ml-2" />
      </a>
    </Button>
  );
}
