import { useGet, useSet, useLoadable } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
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
import { CONNECTOR_TYPES, type ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "../settings-page/connector-icons";
import { Markdown } from "../components/markdown.tsx";
import { ZeroScheduleCard, type ScheduleEntry } from "./zero-schedule-card.tsx";
import {
  zeroJobDetail$,
  zeroJobDetailLoading$,
  zeroJobDetailError$,
  zeroJobInstructions$,
  zeroJobInstructionsLoading$,
  zeroJobInstructionsError$,
  zeroJobScheduleEntries$,
  zeroJobScheduleError$,
  saveZeroJobSchedule$,
  deleteZeroJobSchedule$,
  toggleZeroJobScheduleEnabled$,
  type ZeroJobScheduleSaveParams,
} from "../../signals/zero-page/zero-job-detail.ts";
import { notificationPreferences$ } from "../../signals/settings-page/notification-settings.ts";
import { navigateInReact$ } from "../../signals/route.ts";

function getAllConnectorTypes(): readonly ConnectorType[] {
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
    <div className="mx-auto max-w-[900px] px-7 flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">
          Connectors
        </h2>
        <p className="text-sm text-muted-foreground">
          Third-party services this agent can use
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {getAllConnectorTypes().map((type) => {
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

function JobScheduleTab({ agentName }: { agentName: string }) {
  const entriesLoadable = useLoadable(zeroJobScheduleEntries$);
  const scheduleError = useGet(zeroJobScheduleError$);
  const prefsLoadable = useLoadable(notificationPreferences$);
  const userTimezone =
    prefsLoadable.state === "hasData" ? prefsLoadable.data.timezone : null;
  const saveSchedule = useSet(saveZeroJobSchedule$);
  const deleteSchedule = useSet(deleteZeroJobSchedule$);
  const toggleEnabled = useSet(toggleZeroJobScheduleEnabled$);
  const saving$ = useCCState(false);
  const saving = useGet(saving$);
  const setSaving = useSet(saving$);

  const entries: ScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  if (scheduleError) {
    return (
      <div className="mx-auto max-w-[900px] px-7">
        <Card className="zero-card">
          <CardContent className="px-6 py-6 text-center">
            <p className="text-sm text-destructive">{scheduleError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleSave = async (params: ZeroJobScheduleSaveParams) => {
    setSaving(true);
    try {
      await saveSchedule(params);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-[900px] px-7">
      <ZeroScheduleCard
        title={`${agentName} schedule`}
        subtitle={`Set a time and prompt for ${agentName} to run automatically.`}
        initialSchedule={entries}
        onSave={handleSave}
        onDelete={deleteSchedule}
        onToggleEnabled={toggleEnabled}
        saving={saving}
        defaultTimezone={userTimezone ?? undefined}
      />
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
    <div className="mx-auto max-w-[900px] px-7">
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
    </div>
  );
}

function InstructionsTab() {
  const instructions = useGet(zeroJobInstructions$);
  const instructionsLoading = useGet(zeroJobInstructionsLoading$);
  const instructionsError = useGet(zeroJobInstructionsError$);

  return (
    <div className="mx-auto max-w-[900px] px-7">
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
    </div>
  );
}

function DetailSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-3">
        <div className="mx-auto max-w-[900px] px-7">
          <BackButton onBack={onBack} />
          <div className="animate-pulse space-y-3">
            <div className="h-5 w-48 rounded bg-muted" />
            <div className="h-4 w-72 rounded bg-muted" />
            <div className="h-9 w-80 rounded bg-muted mt-4" />
          </div>
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
        <div className="mx-auto max-w-[900px] px-7">
          <BackButton onBack={onBack} />
        </div>
      </header>
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] px-7">
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

const TAB_TRIGGER_CLASS =
  "gap-1.5 text-sm data-[state=active]:bg-background px-3";

function isValidTab(tab: string): boolean {
  return (
    tab === "connectors" ||
    tab === "schedule" ||
    tab === "settings" ||
    tab === "instructions"
  );
}

function getInitialTab(): string {
  if (typeof window === "undefined") {
    return "connectors";
  }
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab") ?? "";
  return isValidTab(tab) ? tab : "connectors";
}

function syncTabToUrl(tab: string) {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (tab === "connectors") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", tab);
  }
  window.history.replaceState(null, "", url.toString());
}

function DetailHeader({
  activeTab,
  onTabChange,
  displayName,
  description,
  onBack,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  displayName: string;
  description: string | null;
  onBack: () => void;
}) {
  return (
    <header className="shrink-0 bg-transparent px-4 pt-4 pb-4 sm:px-6">
      <div className="mx-auto max-w-[900px] px-7">
        <BackButton onBack={onBack} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-foreground leading-tight">
            {displayName}
          </h1>
          {description && (
            <p className="text-sm text-muted-foreground leading-relaxed max-w-[36rem]">
              {description}
            </p>
          )}
        </div>

        <div className="mt-6 flex h-9 items-center">
          <Tabs
            value={activeTab}
            onValueChange={onTabChange}
            className="flex-1 min-w-0"
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
        </div>
      </div>
    </header>
  );
}

export function ZeroJobDetailPage({
  agentName,
  onBack,
}: ZeroJobDetailPageProps) {
  const detail = useGet(zeroJobDetail$);
  const loading = useGet(zeroJobDetailLoading$);
  const error = useGet(zeroJobDetailError$);

  const agentDef = detail?.content
    ? Object.values(detail.content.agents)[0]
    : null;
  const description = agentDef?.description ?? null;
  const framework = agentDef?.framework ?? null;
  const skills = agentDef?.skills ?? [];
  const displayName = detail?.name ?? agentName;

  const activeTab$ = useCCState(getInitialTab());
  const activeTab = useGet(activeTab$);
  const rawSetActiveTab = useSet(activeTab$);
  const setActiveTab = (tab: string) => {
    rawSetActiveTab(tab);
    syncTabToUrl(tab);
  };

  if (loading && !detail) {
    return <DetailSkeleton onBack={onBack} />;
  }

  if (error) {
    return <DetailError error={error} agentName={agentName} onBack={onBack} />;
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <DetailHeader
        activeTab={activeTab}
        onTabChange={setActiveTab}
        displayName={displayName}
        description={description}
        onBack={onBack}
      />

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        {activeTab === "connectors" && <ConnectorsTab />}

        {activeTab === "schedule" && <JobScheduleTab agentName={displayName} />}

        {activeTab === "settings" && (
          <SettingsTab
            name={displayName}
            description={description}
            framework={framework}
            skills={skills}
          />
        )}

        {activeTab === "instructions" && <InstructionsTab />}
      </main>
    </div>
  );
}
