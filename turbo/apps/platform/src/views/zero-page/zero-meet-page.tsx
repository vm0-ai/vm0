import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  IconMessageCircle,
  IconUser,
  IconFileText,
  IconPlug,
  IconCalendar,
  IconCrown,
} from "@tabler/icons-react";
import { Button, Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { ZeroScheduleTab } from "./zero-schedule-tab.tsx";
import { ZeroSkillsTab } from "./zero-skills-tab.tsx";
import { ZeroInstructionsTab } from "./zero-instructions-tab.tsx";
import { ZeroSettingsTab } from "./zero-settings-tab.tsx";
import { TONE_OPTIONS, type Tone } from "./zero-tone-constants.ts";
import type { ScheduleEntry } from "./zero-schedule-card.tsx";
import {
  agentDisplayName$,
  defaultAgentMetadata$,
} from "../../signals/zero-page/zero-agent-name.ts";
import {
  fetchZeroSchedules$,
  zeroScheduleEntries$,
  saveZeroSchedule$,
  deleteZeroSchedule$,
  toggleZeroScheduleEnabled$,
} from "../../signals/zero-page/zero-schedule.ts";
import { updatePathname$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  zeroInstructions$,
  zeroInstructionsLoading$,
  zeroEditedContent$,
  zeroInstructionsDirty$,
  zeroBuildingInstructions$,
  zeroBuildError$,
  zeroFetchError$,
  fetchZeroInstructions$,
  setZeroEditedContent$,
  discardZeroEdit$,
  buildZeroInstructions$,
  zeroUpdateSettings$,
  zeroSettingsSaving$,
  zeroAddedSkills$,
  addZeroSkill$,
  removeZeroSkill$,
  zeroSkillsDirty$,
  saveZeroSkills$,
  discardZeroSkills$,
} from "../../signals/zero-page/zero-meet.ts";

// ---------------------------------------------------------------------------
// Tab wrappers — resolve signals into shared component props
// ---------------------------------------------------------------------------

function MeetSkillsTab() {
  const addedSkillsLoadable = useLastLoadable(zeroAddedSkills$);
  const addedSkills =
    addedSkillsLoadable.state === "hasData" ? addedSkillsLoadable.data : [];
  const skillsDirtyLoadable = useLastLoadable(zeroSkillsDirty$);
  const skillsDirty =
    skillsDirtyLoadable.state === "hasData" ? skillsDirtyLoadable.data : false;
  const skillsSaving = useGet(zeroSettingsSaving$);
  const addSkill = useSet(addZeroSkill$);
  const removeSkill = useSet(removeZeroSkill$);
  const saveSkills = useSet(saveZeroSkills$);
  const discardSkills = useSet(discardZeroSkills$);

  return (
    <ZeroSkillsTab
      addedSkills={addedSkills}
      addedSkillsLoading={
        addedSkillsLoadable.state !== "hasData" && addedSkills.length === 0
      }
      skillsDirty={skillsDirty}
      skillsSaving={skillsSaving}
      onAddSkill={(name) => detach(addSkill(name), Reason.DomCallback)}
      onRemoveSkill={(name) => detach(removeSkill(name), Reason.DomCallback)}
      onSaveSkills={() => detach(saveSkills(), Reason.DomCallback)}
      onDiscardSkills={() => discardSkills()}
    />
  );
}

function MeetScheduleTab({ agentName }: { agentName: string }) {
  const entriesLoadable = useLoadable(zeroScheduleEntries$);
  const fetchSchedules = useSet(fetchZeroSchedules$);
  const saveSchedule = useSet(saveZeroSchedule$);
  const deleteSchedule = useSet(deleteZeroSchedule$);
  const toggleEnabled = useSet(toggleZeroScheduleEnabled$);

  // Fetch schedules on mount
  const initialized$ = useCCState(false);
  const initialized = useGet(initialized$);
  const setInitialized = useSet(initialized$);
  if (!initialized) {
    setInitialized(true);
    detach(fetchSchedules(), Reason.DomCallback);
  }

  const entries: ScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  return (
    <ZeroScheduleTab
      agentName={agentName}
      entries={entries}
      onSave={saveSchedule}
      onDelete={deleteSchedule}
      onToggleEnabled={toggleEnabled}
    />
  );
}

function MeetInstructionsTab() {
  const instructionsLoadable = useLoadable(zeroInstructions$);
  const loadingLoadable = useLoadable(zeroInstructionsLoading$);
  const editedLoadable = useLoadable(zeroEditedContent$);
  const dirtyLoadable = useLoadable(zeroInstructionsDirty$);
  const buildingLoadable = useLoadable(zeroBuildingInstructions$);
  const buildErrorLoadable = useLoadable(zeroBuildError$);
  const fetchErrorLoadable = useLoadable(zeroFetchError$);

  const instructions =
    instructionsLoadable.state === "hasData" ? instructionsLoadable.data : null;
  const loading =
    loadingLoadable.state === "hasData" && loadingLoadable.data === true;
  const edited =
    editedLoadable.state === "hasData" ? editedLoadable.data : null;
  const isDirty =
    dirtyLoadable.state === "hasData" && dirtyLoadable.data === true;
  const isBuilding =
    buildingLoadable.state === "hasData" && buildingLoadable.data === true;
  const buildError =
    buildErrorLoadable.state === "hasData" ? buildErrorLoadable.data : null;
  const fetchError =
    fetchErrorLoadable.state === "hasData" ? fetchErrorLoadable.data : null;

  const setEdited = useSet(setZeroEditedContent$);
  const discard = useSet(discardZeroEdit$);
  const build = useSet(buildZeroInstructions$);
  const fetchInstructions = useSet(fetchZeroInstructions$);

  const fetched$ = useCCState(false);
  const fetched = useGet(fetched$);
  const setFetched = useSet(fetched$);
  if (!fetched && !loading) {
    setFetched(true);
    detach(fetchInstructions(), Reason.DomCallback);
  }

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
// Main meet page
// ---------------------------------------------------------------------------

interface ZeroMeetPageProps {
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
}

export function ZeroMeetPage({
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
}: ZeroMeetPageProps) {
  const navigate = useSet(updatePathname$);
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const resolvedAgentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const metadataLoadable = useLoadable(defaultAgentMetadata$);
  const rawSound =
    metadataLoadable.state === "hasData"
      ? (metadataLoadable.data?.sound ?? "professional")
      : "professional";
  const resolvedSound: Tone = (TONE_OPTIONS as readonly string[]).includes(
    rawSound,
  )
    ? (rawSound as Tone)
    : "professional";
  const saving = useGet(zeroSettingsSaving$);
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const validTabs = ["skills", "schedule", "settings", "instructions"];
  const initialTab = validTabs.includes(params.get("tab") ?? "")
    ? params.get("tab")!
    : "skills";
  const activeTab$ = useCCState(initialTab);
  const activeTab = useGet(activeTab$);
  const rawSetActiveTab = useSet(activeTab$);
  const setActiveTab = (tab: string) => {
    rawSetActiveTab(tab);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (tab === "skills") {
        url.searchParams.delete("tab");
      } else {
        url.searchParams.set("tab", tab);
      }
      window.history.replaceState(null, "", url.toString());
    }
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pt-10 pb-4 sm:px-6">
        <div className="mx-auto max-w-[900px] px-7">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onAvatarClick}
              className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch Zero avatar"
            >
              <img
                src={zeroAvatarSrc}
                alt=""
                role="presentation"
                className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
              />
            </button>
            <div className="min-w-0 pt-2 sm:pt-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight text-foreground leading-tight">
                  {resolvedAgentName}
                </h1>
                <span className="zero-pill inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium">
                  <IconCrown
                    size={12}
                    stroke={1.8}
                    className="shrink-0 text-blue-600"
                  />
                  Super agent
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-0.5 leading-tight">
                Your AI teammate, tuned to you
              </p>
            </div>
          </div>

          <div className="mt-6 flex h-9 items-center justify-between gap-6">
            <Tabs
              value={activeTab}
              onValueChange={setActiveTab}
              className="flex-1 min-w-0"
            >
              <TabsList className="zero-tabs h-9 w-full sm:w-auto gap-1 px-1 py-1">
                <TabsTrigger
                  value="skills"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconPlug size={14} stroke={1.5} />
                  Skills
                </TabsTrigger>
                <TabsTrigger
                  value="schedule"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconCalendar size={14} stroke={1.5} />
                  Schedule
                </TabsTrigger>
                <TabsTrigger
                  value="settings"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconUser size={14} stroke={1.5} />
                  Settings
                </TabsTrigger>
                <TabsTrigger
                  value="instructions"
                  className="gap-1.5 text-sm data-[state=active]:bg-background px-3"
                >
                  <IconFileText size={14} stroke={1.5} />
                  Instructions
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <Button
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg border px-4"
              onClick={() => navigate("/zero/chat")}
            >
              <IconMessageCircle size={14} stroke={1.5} />
              Just ask
            </Button>
          </div>
        </div>
      </header>

      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        {activeTab === "skills" && <MeetSkillsTab />}

        {activeTab === "schedule" && (
          <MeetScheduleTab agentName={resolvedAgentName} />
        )}

        {activeTab === "settings" && (
          <ZeroSettingsTab
            agentName={resolvedAgentName}
            sound={resolvedSound}
            saving={saving}
            updateSettings$={zeroUpdateSettings$}
          />
        )}

        {activeTab === "instructions" && <MeetInstructionsTab />}
      </main>
    </div>
  );
}
