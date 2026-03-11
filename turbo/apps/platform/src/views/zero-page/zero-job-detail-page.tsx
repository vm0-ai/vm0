import { useGet, useSet } from "ccstate-react";
import {
  IconArrowLeft,
  IconFileText,
  IconSettings,
  IconPlug,
  IconCalendar,
} from "@tabler/icons-react";
import {
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  Card,
  CardContent,
} from "@vm0/ui";
import { useCCState } from "ccstate-react/experimental";
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "../settings-page/connector-icons";
import { Markdown } from "../components/markdown.tsx";
import { ZeroScheduleCard } from "./zero-schedule-card";
import {
  zeroJobDetail$,
  zeroJobDetailLoading$,
  zeroJobDetailError$,
  zeroJobInstructions$,
  zeroJobInstructionsLoading$,
  zeroJobInstructionsError$,
  zeroJobSchedule$,
  zeroJobScheduleError$,
} from "../../signals/zero-page/zero-job-detail.ts";
import { navigateInReact$ } from "../../signals/route.ts";

function getConnectorTypes(): ConnectorType[] {
  return Object.keys(CONNECTOR_TYPES) as ConnectorType[];
}

interface ZeroJobDetailPageProps {
  agentName: string;
  onBack: () => void;
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <div className="mb-3">
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0 -ml-2"
        onClick={onBack}
        aria-label="Back to agents"
      >
        <IconArrowLeft size={20} stroke={1.5} />
      </Button>
    </div>
  );
}

function ConnectorsTab() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          Connectors
        </h2>
        <p className="text-sm text-muted-foreground">
          Third-party services this agent can use
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {getConnectorTypes().map((type) => {
          const config = CONNECTOR_TYPES[type];
          return (
            <li key={type}>
              <Card className="zero-card">
                <CardContent className="flex items-center gap-4 px-4 py-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted overflow-hidden">
                    <ConnectorIcon type={type} size={24} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {config.label}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {config.helpText}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0 rounded-lg px-3 zero-btn-morandi border"
                  >
                    Connect
                  </Button>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SettingsTab({
  name,
  description,
  framework,
  skills,
}: {
  name: string;
  description: string | null;
  framework: string | null;
  skills: string[];
}) {
  return (
    <Card className="zero-card">
      <CardContent className="px-7 py-7 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Name
          </span>
          <p className="text-sm text-foreground">{name}</p>
        </div>
        {description && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Description
            </span>
            <p className="text-sm text-foreground">{description}</p>
          </div>
        )}
        {framework && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Framework
            </span>
            <p className="text-sm text-foreground">{framework}</p>
          </div>
        )}
        {skills.length > 0 && (
          <div className="flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Skills
            </span>
            <ul className="flex flex-wrap gap-2" role="list">
              {skills.map((skill) => (
                <li key={skill}>
                  <span className="zero-chip inline-flex items-center gap-2 rounded-2xl border px-3 py-2.5 text-sm text-foreground">
                    <span className="min-w-0 truncate font-medium">
                      {skill}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function InstructionsTab() {
  const instructions = useGet(zeroJobInstructions$);
  const instructionsLoading = useGet(zeroJobInstructionsLoading$);
  const instructionsError = useGet(zeroJobInstructionsError$);

  return (
    <Card className="zero-card-white">
      <CardContent className="px-7 py-7">
        {instructionsLoading && (
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-3/4 rounded bg-muted" />
            <div className="h-4 w-1/2 rounded bg-muted" />
            <div className="h-4 w-5/6 rounded bg-muted" />
          </div>
        )}
        {!instructionsLoading && instructionsError && (
          <p className="text-sm text-destructive">{instructionsError}</p>
        )}
        {!instructionsLoading &&
          !instructionsError &&
          instructions?.content && <Markdown source={instructions.content} />}
        {!instructionsLoading &&
          !instructionsError &&
          !instructions?.content && (
            <p className="text-sm text-muted-foreground">
              No instructions configured for this agent.
            </p>
          )}
      </CardContent>
    </Card>
  );
}

function DetailSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-3">
        <BackButton onBack={onBack} />
        <div className="mx-auto max-w-[900px] animate-pulse space-y-3">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-4 w-72 rounded bg-muted" />
          <div className="h-9 w-80 rounded bg-muted mt-4" />
        </div>
      </header>
    </div>
  );
}

function DetailError({
  error,
  agentName,
  onBack,
}: {
  error: string;
  agentName: string;
  onBack: () => void;
}) {
  const navigate = useSet(navigateInReact$);
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-3">
        <BackButton onBack={onBack} />
      </header>
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card">
            <CardContent className="px-6 py-6 text-center space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                className="zero-btn-morandi"
                onClick={() =>
                  navigate("/zero/job/:name", {
                    pathParams: { name: agentName },
                  })
                }
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

function ScheduleTab({ agentName }: { agentName: string }) {
  const detail = useGet(zeroJobDetail$);
  const schedules = useGet(zeroJobSchedule$);
  const scheduleError = useGet(zeroJobScheduleError$);

  if (scheduleError) {
    return (
      <Card className="zero-card">
        <CardContent className="px-6 py-6 text-center">
          <p className="text-sm text-destructive">{scheduleError}</p>
        </CardContent>
      </Card>
    );
  }

  const scheduleEntries = schedules.map((s) => ({
    id: s.id,
    time: s.cronExpression
      ? `Cron: ${s.cronExpression} (${s.timezone})`
      : s.atTime
        ? `Once at ${new Date(s.atTime).toLocaleString()}`
        : "Unknown schedule",
    prompt: s.prompt,
  }));

  return (
    <ZeroScheduleCard
      title={`${detail?.name ?? agentName} schedule`}
      subtitle="Set a time and prompt for this agent to run automatically."
      initialSchedule={scheduleEntries}
    />
  );
}

const TAB_TRIGGER_CLASS =
  "gap-1.5 text-sm data-[state=active]:bg-background px-3";

function DetailTabs({
  activeTab,
  onValueChange,
}: {
  activeTab: string;
  onValueChange: (v: string) => void;
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={onValueChange}
      className="mt-4 w-full"
    >
      <TabsList className="zero-tabs h-9 w-full sm:w-auto gap-1 px-1 py-1">
        <TabsTrigger value="connectors" className={TAB_TRIGGER_CLASS}>
          <IconPlug size={14} stroke={1.5} />
          Connectors
        </TabsTrigger>
        <TabsTrigger value="schedule" className={TAB_TRIGGER_CLASS}>
          <IconCalendar size={14} stroke={1.5} />
          Schedule
        </TabsTrigger>
        <TabsTrigger value="settings" className={TAB_TRIGGER_CLASS}>
          <IconSettings size={14} stroke={1.5} />
          Settings
        </TabsTrigger>
        <TabsTrigger value="instructions" className={TAB_TRIGGER_CLASS}>
          <IconFileText size={14} stroke={1.5} />
          Instructions
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function TabContent({
  activeTab,
  agentName,
  displayName,
  description,
  framework,
  skills,
}: {
  activeTab: string;
  agentName: string;
  displayName: string;
  description: string | null;
  framework: string | null;
  skills: string[];
}) {
  if (activeTab === "connectors") {
    return <ConnectorsTab />;
  }
  if (activeTab === "schedule") {
    return <ScheduleTab agentName={agentName} />;
  }
  if (activeTab === "settings") {
    return (
      <SettingsTab
        name={displayName}
        description={description}
        framework={framework}
        skills={skills}
      />
    );
  }
  if (activeTab === "instructions") {
    return <InstructionsTab />;
  }
  return null;
}

export function ZeroJobDetailPage({
  agentName,
  onBack,
}: ZeroJobDetailPageProps) {
  const activeTab$ = useCCState("connectors");
  const activeTab = useGet(activeTab$);
  const setActiveTab = useSet(activeTab$);

  const detail = useGet(zeroJobDetail$);
  const loading = useGet(zeroJobDetailLoading$);
  const error = useGet(zeroJobDetailError$);

  const agentDef = detail?.content
    ? Object.values(detail.content.agents)[0]
    : null;
  const description = agentDef?.description ?? null;
  const framework = agentDef?.framework ?? null;
  const skills = agentDef?.skills ?? [];

  if (loading && !detail) {
    return <DetailSkeleton onBack={onBack} />;
  }

  if (error) {
    return <DetailError error={error} agentName={agentName} onBack={onBack} />;
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-3">
        <BackButton onBack={onBack} />
        <div className="mx-auto max-w-[900px]">
          <div className="min-w-0 flex-1 space-y-1.5">
            <h1 className="text-base font-semibold tracking-tight text-foreground">
              {detail?.name ?? agentName}
            </h1>
            {description && (
              <p className="text-sm text-muted-foreground leading-relaxed max-w-[36rem]">
                {description}
              </p>
            )}
          </div>
          <DetailTabs activeTab={activeTab} onValueChange={setActiveTab} />
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <TabContent
            activeTab={activeTab}
            agentName={agentName}
            displayName={detail?.name ?? agentName}
            description={description}
            framework={framework}
            skills={skills}
          />
        </div>
      </main>
    </div>
  );
}
