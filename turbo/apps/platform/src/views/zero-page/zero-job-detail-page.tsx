import { useGet, useSet, useLoadable } from "ccstate-react";
import { useCCState } from "ccstate-react/experimental";
import {
  IconFileText,
  IconUserCircle,
  IconPlug,
  IconCalendar,
  IconMessageCircle,
  IconUsers,
} from "@tabler/icons-react";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Card,
  CardContent,
} from "@vm0/ui";
import { ZeroScheduleTab } from "./zero-schedule-tab.tsx";
import { ZeroSkillsTab } from "./zero-skills-tab.tsx";
import { ZeroInstructionsTab } from "./zero-instructions-tab.tsx";
import { ZeroSettingsTab } from "./zero-settings-tab.tsx";
import { TONE_OPTIONS, type Tone } from "./zero-tone-constants.ts";
import type { ScheduleEntry } from "./zero-schedule-card.tsx";
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
  zeroJobEditedContent$,
  zeroJobInstructionsDirty$,
  setZeroJobEditedContent$,
  discardZeroJobEdit$,
  buildZeroJobInstructions$,
  zeroJobBuilding$,
  zeroJobBuildError$,
  zeroJobUpdateSettings$,
  zeroJobSettingsSaving$,
  zeroJobAddedSkills$,
  zeroJobSkillsDirty$,
  addZeroJobSkill$,
  removeZeroJobSkill$,
  saveZeroJobSkills$,
  discardZeroJobSkills$,
} from "../../signals/zero-page/zero-job-detail.ts";
import type { AgentDetail } from "../../signals/agent-detail/types.ts";
import { Link } from "../router/link.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { AGENT_AVATARS, useAgentAvatar } from "./zero-sidebar.tsx";
import { setAgentAvatar$ } from "../../signals/zero-page/zero-agent-avatars.ts";

// ---------------------------------------------------------------------------
// Page shell: skeleton, error, header
// ---------------------------------------------------------------------------

interface ZeroJobDetailPageProps {
  agentName: string;
}

function Breadcrumb({ currentName }: { currentName?: string }) {
  return (
    <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
      <Link
        pathname="/zero/:tab"
        options={{ pathParams: { tab: "team" } }}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
      >
        <IconUsers size={14} stroke={1.5} className="shrink-0" />
        Zero&apos;s team
      </Link>
      <span className="text-muted-foreground/40 select-none">/</span>
      <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate">
        {currentName ?? "Agent"}
      </span>
    </nav>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Breadcrumb />
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
        <div className="mx-auto max-w-[900px]">
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
}: {
  error: string;
  agentName: string;
}) {
  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Breadcrumb />
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card">
            <CardContent className="px-6 py-6 text-center space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <Link
                pathname="/zero/team/:name"
                options={{ pathParams: { name: agentName } }}
                className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
              >
                Retry
              </Link>
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
    tab === "profile" ||
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

function extractAgentFields(detail: AgentDetail | null, fallbackName: string) {
  const agentDef = detail?.content
    ? Object.values(detail.content.agents)[0]
    : null;
  return {
    description: agentDef?.metadata?.description ?? agentDef?.description ?? "",
    framework: agentDef?.framework ?? null,
    sound: agentDef?.metadata?.sound ?? "professional",
    displayName:
      agentDef?.metadata?.displayName ?? detail?.name ?? fallbackName,
  };
}

// ---------------------------------------------------------------------------
// Tab wrappers — resolve signals into shared component props
// ---------------------------------------------------------------------------

function JobSkillsTab() {
  const addedSkills = useGet(zeroJobAddedSkills$);
  const skillsDirty = useGet(zeroJobSkillsDirty$);
  const skillsSaving = useGet(zeroJobSettingsSaving$);
  const addSkill = useSet(addZeroJobSkill$);
  const removeSkill = useSet(removeZeroJobSkill$);
  const saveSkills = useSet(saveZeroJobSkills$);
  const discardSkills = useSet(discardZeroJobSkills$);

  return (
    <ZeroSkillsTab
      addedSkills={addedSkills}
      addedSkillsLoading={false}
      skillsDirty={skillsDirty}
      skillsSaving={skillsSaving}
      onAddSkill={addSkill}
      onRemoveSkill={removeSkill}
      onSaveSkills={() => detach(saveSkills(), Reason.DomCallback)}
      onDiscardSkills={() => discardSkills()}
    />
  );
}

function JobScheduleTab({ agentName }: { agentName: string }) {
  const entriesLoadable = useLoadable(zeroJobScheduleEntries$);
  const scheduleError = useGet(zeroJobScheduleError$);
  const saveSchedule = useSet(saveZeroJobSchedule$);
  const deleteSchedule = useSet(deleteZeroJobSchedule$);
  const toggleEnabled = useSet(toggleZeroJobScheduleEnabled$);

  const entries: ScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  return (
    <ZeroScheduleTab
      agentName={agentName}
      entries={entries}
      scheduleError={scheduleError}
      onSave={saveSchedule}
      onDelete={deleteSchedule}
      onToggleEnabled={toggleEnabled}
    />
  );
}

function JobInstructionsTab() {
  const instructionsLoadable = useLoadable(zeroJobInstructions$);
  const loadingLoadable = useLoadable(zeroJobInstructionsLoading$);
  const instructionsErrorLoadable = useLoadable(zeroJobInstructionsError$);
  const editedLoadable = useLoadable(zeroJobEditedContent$);
  const dirtyLoadable = useLoadable(zeroJobInstructionsDirty$);
  const buildingLoadable = useLoadable(zeroJobBuilding$);
  const buildErrorLoadable = useLoadable(zeroJobBuildError$);

  const instructions =
    instructionsLoadable.state === "hasData" ? instructionsLoadable.data : null;
  const loading =
    loadingLoadable.state === "hasData" && loadingLoadable.data === true;
  const fetchError =
    instructionsErrorLoadable.state === "hasData"
      ? instructionsErrorLoadable.data
      : null;
  const edited =
    editedLoadable.state === "hasData" ? editedLoadable.data : null;
  const isDirty =
    dirtyLoadable.state === "hasData" && dirtyLoadable.data === true;
  const isBuilding =
    buildingLoadable.state === "hasData" && buildingLoadable.data === true;
  const buildError =
    buildErrorLoadable.state === "hasData" ? buildErrorLoadable.data : null;

  const setEdited = useSet(setZeroJobEditedContent$);
  const discard = useSet(discardZeroJobEdit$);
  const build = useSet(buildZeroJobInstructions$);

  return (
    <ZeroInstructionsTab
      instructions={instructions}
      loading={loading}
      fetchError={fetchError}
      editedContent={edited}
      isDirty={isDirty}
      isBuilding={isBuilding}
      buildError={buildError}
      onEdit={setEdited}
      onDiscard={discard}
      onBuild={() => detach(build(), Reason.DomCallback)}
    />
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ZeroJobDetailPage({ agentName }: ZeroJobDetailPageProps) {
  const detail = useGet(zeroJobDetail$);
  const loading = useGet(zeroJobDetailLoading$);
  const error = useGet(zeroJobDetailError$);

  const { description, displayName, sound } = extractAgentFields(
    detail,
    agentName,
  );
  const resolvedSound: Tone = (TONE_OPTIONS as readonly string[]).includes(
    sound,
  )
    ? (sound as Tone)
    : "professional";

  const saving = useGet(zeroJobSettingsSaving$);

  const activeTab$ = useCCState(getInitialTab());
  const activeTab = useGet(activeTab$);
  const rawSetActiveTab = useSet(activeTab$);
  const setActiveTab = (tab: string) => {
    rawSetActiveTab(tab);
    syncTabToUrl(tab);
  };

  const currentAvatar = useAgentAvatar(agentName);
  const setAgentAvatarCmd = useSet(setAgentAvatar$);
  const cycleAvatar = () => {
    const idx = AGENT_AVATARS.indexOf(
      currentAvatar as (typeof AGENT_AVATARS)[number],
    );
    const next = AGENT_AVATARS[(idx + 1) % AGENT_AVATARS.length];
    setAgentAvatarCmd(agentName, next);
  };

  if (loading && !detail) {
    return <DetailSkeleton />;
  }

  if (error) {
    return <DetailError error={error} agentName={agentName} />;
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <Breadcrumb currentName={displayName} />
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={cycleAvatar}
              className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch avatar"
            >
              <img
                src={currentAvatar}
                alt={displayName}
                className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
              />
            </button>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                {displayName}
              </h1>
              <p className="text-sm text-muted-foreground mt-1.5 leading-tight">
                {description || "Your AI teammate, tuned to you"}
              </p>
            </div>
          </div>

          <div className="mt-4 flex h-9 items-center justify-between gap-6">
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="flex-1 min-w-0"
            >
              <TabsList className="zero-tabs h-9 w-full sm:w-auto gap-1 px-1 py-1">
                <TabsTrigger value="connectors" className={TAB_TRIGGER_CLASS}>
                  <IconPlug size={14} stroke={1.5} />
                  Connectors
                </TabsTrigger>
                <TabsTrigger value="schedule" className={TAB_TRIGGER_CLASS}>
                  <IconCalendar size={14} stroke={1.5} />
                  Scheduled
                </TabsTrigger>
                <TabsTrigger value="profile" className={TAB_TRIGGER_CLASS}>
                  <IconUserCircle size={14} stroke={1.5} />
                  Profile
                </TabsTrigger>
                <TabsTrigger value="instructions" className={TAB_TRIGGER_CLASS}>
                  <IconFileText size={14} stroke={1.5} />
                  Instructions
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    pathname="/zero/:tab"
                    options={{ pathParams: { tab: "chat" } }}
                    className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg px-4 transition-colors inline-flex items-center justify-center border text-sm font-medium hover:bg-accent"
                  >
                    <IconMessageCircle size={14} stroke={1.5} />
                    Chat with {displayName}
                  </Link>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="max-w-[220px] text-center"
                >
                  Make updates or assign tasks
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        {activeTab === "connectors" && <JobSkillsTab />}

        {activeTab === "schedule" && <JobScheduleTab agentName={displayName} />}

        {activeTab === "profile" && (
          <ZeroSettingsTab
            agentName={displayName}
            description={description ?? ""}
            sound={resolvedSound}
            saving={saving}
            updateSettings$={zeroJobUpdateSettings$}
            inputId="job-agent-name"
          />
        )}

        {activeTab === "instructions" && <JobInstructionsTab />}
      </main>
    </div>
  );
}
