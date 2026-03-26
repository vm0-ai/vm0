import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
import { ZeroConnectorsTab } from "./zero-connectors-tab.tsx";
import { ZeroInstructionsTab } from "./zero-instructions-tab.tsx";
import { ZeroSettingsTab } from "./zero-settings-tab.tsx";

import { TONE_OPTIONS, type Tone } from "./zero-tone-constants.ts";
import type { ScheduleEntry } from "./zero-schedule-card.tsx";
import {
  zeroJobDetail$,
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
  deleteZeroJobAgent$,
  zeroJobAddedConnectors$,
  zeroJobConnectorsDirty$,
  addZeroJobConnector$,
  removeZeroJobConnector$,
  saveZeroJobConnectors$,
  discardZeroJobConnectors$,
  zeroJobActiveTab$,
  setZeroJobActiveTab$,
  zeroJobFirewallPolicies$,
  setZeroJobFirewallPolicies$,
} from "../../signals/zero-page/zero-job-detail.ts";
import type { AgentDetail } from "../../signals/zero-page/agent-types.ts";
import { runScheduleNow$ } from "../../signals/zero-page/zero-schedule.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import { Link } from "../router/link.tsx";
import { navigateTo$ } from "../../signals/route.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AGENT_AVATARS, useAgentAvatar } from "./zero-sidebar.tsx";
import { setAgentAvatar$ } from "../../signals/zero-page/zero-agent-avatars.ts";
import { agentsList$ } from "../../signals/zero-page/agents-list.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { ZeroNoPermissionIllustration } from "./components/zero-no-permission-illustration.tsx";

// ---------------------------------------------------------------------------
// Page shell: skeleton, error, header
// ---------------------------------------------------------------------------

interface ZeroJobDetailPageProps {
  agentId: string;
  /** When set, this is the default agent — use this avatar instead of agent avatar. */
  zeroAvatarSrc?: string;
  /** Cycle the default agent's avatar. */
  onCycleAvatar?: () => void;
}

function Breadcrumb({ currentName }: { currentName?: string }) {
  return (
    <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
      <Link
        pathname="/team"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
      >
        <IconUsers size={14} stroke={1.5} className="shrink-0" />
        Agents
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

function isNotFoundError(error: string): boolean {
  return /not found|404|no(t| )exist/i.test(error);
}

function DetailError({ error, agentId }: { error: string; agentId: string }) {
  if (isNotFoundError(error)) {
    return (
      <div className="flex flex-1 flex-col min-h-0">
        <Breadcrumb />
        <main className="flex-1 flex items-center justify-center px-4 sm:px-6 pb-16">
          <div className="flex flex-col items-center text-center gap-4 max-w-sm">
            <ZeroNoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain opacity-90" />
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-foreground">
                Agent not found
              </h2>
              <p className="text-sm text-muted-foreground">
                The agent &quot;{agentId}&quot; doesn&apos;t exist or you
                don&apos;t have access to it.
              </p>
            </div>
            <Link
              pathname="/:tab"
              options={{ pathParams: { tab: "team" } }}
              className="zero-btn-morandi inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
            >
              Back to team
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <Breadcrumb />
      <main className="flex-1 px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card">
            <CardContent className="px-6 py-6 text-center space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <Link
                pathname="/team/:id"
                options={{ pathParams: { id: agentId } }}
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

/** Coerce hidden tabs back to "connectors" for non-admin default-agent view. */
function resolveVisibleTab(
  rawTab: string,
  hideProfileAndInstructions: boolean,
): string {
  if (
    hideProfileAndInstructions &&
    rawTab !== "connectors" &&
    rawTab !== "schedule"
  ) {
    return "connectors";
  }
  return rawTab;
}

function AgentTabNav({
  activeTab,
  onTabChange,
  showProfileAndInstructions,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  showProfileAndInstructions: boolean;
}) {
  return (
    <Tabs
      value={activeTab}
      onValueChange={onTabChange}
      className="flex-1 min-w-0"
    >
      <TabsList className="zero-tabs h-9 w-full sm:w-auto gap-1 px-1 py-1 overflow-x-auto">
        <TabsTrigger value="connectors" className={TAB_TRIGGER_CLASS}>
          <IconPlug size={14} stroke={1.5} />
          Connectors
        </TabsTrigger>
        <TabsTrigger value="schedule" className={TAB_TRIGGER_CLASS}>
          <IconCalendar size={14} stroke={1.5} />
          Scheduled
        </TabsTrigger>
        {showProfileAndInstructions && (
          <TabsTrigger value="profile" className={TAB_TRIGGER_CLASS}>
            <IconUserCircle size={14} stroke={1.5} />
            Profile
          </TabsTrigger>
        )}
        {showProfileAndInstructions && (
          <TabsTrigger value="instructions" className={TAB_TRIGGER_CLASS}>
            <IconFileText size={14} stroke={1.5} />
            Instructions
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );
}

function extractAgentFields(
  detail: AgentDetail | null,
  fallbackName: string,
  listItem?: {
    displayName?: string | null;
    description?: string | null;
    sound?: string | null;
  },
) {
  return {
    description: listItem?.description ?? detail?.description ?? "",
    framework: null,
    sound: listItem?.sound ?? detail?.sound ?? "professional",
    displayName:
      listItem?.displayName ??
      detail?.displayName ??
      detail?.agentId ??
      fallbackName,
  };
}

// ---------------------------------------------------------------------------
// Tab wrappers — resolve signals into shared component props
// ---------------------------------------------------------------------------

function JobConnectorsTab({
  agentId,
  agentDisplayName,
  readOnly,
}: {
  agentId: string;
  agentDisplayName: string;
  readOnly?: boolean;
}) {
  const addedConnectors = useGet(zeroJobAddedConnectors$);
  const connectorsDirty = useGet(zeroJobConnectorsDirty$);
  const connectorsSaving = useGet(zeroJobSettingsSaving$);
  const addConnector = useSet(addZeroJobConnector$);
  const removeConnector = useSet(removeZeroJobConnector$);
  const saveConnectors = useSet(saveZeroJobConnectors$);
  const discardConnectors = useSet(discardZeroJobConnectors$);
  const firewallPolicies = useGet(zeroJobFirewallPolicies$);
  const setFirewallPolicies = useSet(setZeroJobFirewallPolicies$);
  const pageSignal = useGet(pageSignal$);

  return (
    <ZeroConnectorsTab
      addedConnectors={addedConnectors}
      addedConnectorsLoading={false}
      connectorsDirty={connectorsDirty}
      connectorsSaving={connectorsSaving}
      agentId={agentId}
      displayName={agentDisplayName}
      firewallPolicies={firewallPolicies}
      onFirewallPoliciesChange={setFirewallPolicies}
      onAddConnector={addConnector}
      onRemoveConnector={removeConnector}
      onSaveConnectors={() =>
        detach(saveConnectors(pageSignal), Reason.DomCallback)
      }
      onDiscardConnectors={() => discardConnectors()}
      readOnly={readOnly}
    />
  );
}

function JobScheduleTab({ displayName }: { displayName: string }) {
  const entriesLoadable = useLoadable(zeroJobScheduleEntries$);
  const scheduleError = useGet(zeroJobScheduleError$);
  const saveSchedule = useSet(saveZeroJobSchedule$);
  const deleteSchedule = useSet(deleteZeroJobSchedule$);
  const toggleEnabled = useSet(toggleZeroJobScheduleEnabled$);
  const runScheduleNow = useSet(runScheduleNow$);
  const nav = useSet(navigateTo$);
  const pageSignal = useGet(pageSignal$);

  const entries: ScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  const handleRunNow = async (entry: ScheduleEntry) => {
    await runScheduleNow(entry.id, pageSignal);
  };

  const handleOpenDetails = (entry: ScheduleEntry) => {
    nav("/schedule/:scheduleId", { pathParams: { scheduleId: entry.id } });
  };

  return (
    <ZeroScheduleTab
      displayName={displayName}
      entries={entries}
      scheduleError={scheduleError}
      onSave={(params) => saveSchedule(params, pageSignal)}
      onDelete={(name) => deleteSchedule(name, pageSignal)}
      onToggleEnabled={(params) => toggleEnabled(params, pageSignal)}
      onRunNow={handleRunNow}
      onOpenDetails={handleOpenDetails}
    />
  );
}

function JobInstructionsTab() {
  const pageSignal = useGet(pageSignal$);
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
      onBuild={() => detach(build(pageSignal), Reason.DomCallback)}
    />
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ZeroJobDetailPage({
  agentId,
  zeroAvatarSrc,
  onCycleAvatar,
}: ZeroJobDetailPageProps) {
  const detail = useGet(zeroJobDetail$);
  const error = useGet(zeroJobDetailError$);
  const agents = useGet(agentsList$);
  const listItem = agents.find((a) => a.id === agentId);

  const { description, displayName, sound } = extractAgentFields(
    detail,
    agentId,
    listItem,
  );
  const resolvedSound: Tone = (TONE_OPTIONS as readonly string[]).includes(
    sound,
  )
    ? (sound as Tone)
    : "professional";

  const saving = useGet(zeroJobSettingsSaving$);
  const deleteAgent = useSet(deleteZeroJobAgent$);
  const nav = useSet(navigateTo$);
  const pageSignal = useGet(pageSignal$);

  const statusLoadable = useLastLoadable(zeroOnboardingStatus$);
  const isDefaultAgent =
    statusLoadable.state === "hasData" &&
    (statusLoadable.data.defaultAgentId === agentId ||
      statusLoadable.data.defaultAgentId === detail?.agentId);

  const adminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin = adminLoadable.state === "hasData" && adminLoadable.data;

  // Non-admin users cannot access profile/instructions tabs for the default agent
  const hideProfileAndInstructions = isDefaultAgent && !isAdmin;

  const handleDelete = async () => {
    await deleteAgent(pageSignal);
    nav("/team");
  };

  const rawTab = useGet(zeroJobActiveTab$);
  const setActiveTab = useSet(setZeroJobActiveTab$);
  const activeTab = resolveVisibleTab(rawTab, hideProfileAndInstructions);

  const agentAvatar = useAgentAvatar(agentId);
  const setAgentAvatarCmd = useSet(setAgentAvatar$);
  // Default agent uses the shared zero avatar; sub-agents use their own override.
  const currentAvatar = zeroAvatarSrc ?? agentAvatar;
  const cycleAvatar =
    onCycleAvatar ??
    (() => {
      const idx = AGENT_AVATARS.indexOf(
        agentAvatar as (typeof AGENT_AVATARS)[number],
      );
      const next = AGENT_AVATARS[(idx + 1) % AGENT_AVATARS.length];
      setAgentAvatarCmd(agentId, next);
    });

  if (!detail && !error) {
    return <DetailSkeleton />;
  }

  if (error) {
    return <DetailError error={error} agentId={agentId} />;
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <Breadcrumb currentName={displayName} />
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-center gap-4">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
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
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Switch avatar</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
            <AgentTabNav
              activeTab={activeTab}
              onTabChange={setActiveTab}
              showProfileAndInstructions={!hideProfileAndInstructions}
            />
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    pathname="/talk/:id"
                    options={{ pathParams: { id: agentId } }}
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
        {activeTab === "connectors" && (
          <JobConnectorsTab
            agentId={agentId}
            agentDisplayName={displayName}
            readOnly={hideProfileAndInstructions}
          />
        )}

        {activeTab === "schedule" && (
          <JobScheduleTab displayName={displayName} />
        )}

        {activeTab === "profile" && (
          <ZeroSettingsTab
            key={`${displayName}\0${description}\0${resolvedSound}`}
            displayName={displayName}
            description={description ?? ""}
            sound={resolvedSound}
            saving={saving}
            updateSettings$={zeroJobUpdateSettings$}
            inputId="job-agent-name"
            isDefaultAgent={isDefaultAgent}
            onDelete={handleDelete}
          />
        )}

        {activeTab === "instructions" && <JobInstructionsTab />}
      </main>
    </div>
  );
}
