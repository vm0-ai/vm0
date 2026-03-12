import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { createPortal } from "react-dom";
import {
  IconMessageCircle,
  IconUser,
  IconFileText,
  IconPlug,
  IconPlus,
  IconCalendar,
  IconPencil,
  IconLoader2,
  IconCrown,
  IconDotsVertical,
} from "@tabler/icons-react";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
  stripMetadataFrontmatter,
} from "@vm0/core";
import { skills$ } from "../../data/skills.ts";
import { ConnectorIcon } from "../settings-page/connector-icons.tsx";
import {
  Card,
  CardContent,
  Input,
  Button,
  Tabs,
  TabsList,
  TabsTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  cn,
} from "@vm0/ui";
import { ZeroScheduleCard, type ScheduleEntry } from "./zero-schedule-card";
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
  type ZeroScheduleSaveParams,
} from "../../signals/zero-page/zero-schedule.ts";
import {
  type ConnectorTypeWithStatus,
  allConnectorTypes$,
  connectConnector$,
  addConnectionDialogOpen$,
  setAddConnectionDialogOpen$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  pollingConnectorType$,
  justConnectedTypes$,
  clearJustConnectedTypes$,
} from "../../signals/settings-page/connectors.ts";
import { deleteConnector$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { updatePathname$ } from "../../signals/route.ts";
import {
  AddConnectionDialog,
  ConnectModal,
} from "../settings-page/add-connection-dialog.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import { detach, Reason } from "../../signals/utils.ts";
import { notificationPreferences$ } from "../../signals/settings-page/notification-settings.ts";
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

/** Stored as lowercase in metadata.sound. */
const TONE_OPTIONS = [
  "professional",
  "friendly",
  "direct",
  "supportive",
] as const;

type Tone = (typeof TONE_OPTIONS)[number];

function toneLabel(t: Tone) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const TONE_HINT: Readonly<Record<Tone, string>> = {
  professional: "Clear and polished",
  friendly: "Warm and approachable",
  direct: "To the point",
  supportive: "In your corner",
};

const TONE_SAMPLES: Readonly<
  Record<Tone, Readonly<{ user: string; zero: string }>>
> = {
  professional: {
    user: "I need the Q3 report by Friday.",
    zero: "I'll have the Q3 report ready by Friday. I'll send a draft by Thursday for your review.",
  },
  friendly: {
    user: "I need the Q3 report by Friday.",
    zero: "Sure thing! I'll get that Q3 report to you by Friday—I'll send over a draft Thursday so you can take a look.",
  },
  direct: {
    user: "I need the Q3 report by Friday.",
    zero: "Friday. I'll send a draft Thursday.",
  },
  supportive: {
    user: "I need the Q3 report by Friday.",
    zero: "I'll make sure you have the Q3 report by Friday. I'll send a draft on Thursday so you have time to review—let me know if you'd like anything else.",
  },
};

// ---------------------------------------------------------------------------
// Skill card — a single card in the skills grid
// ---------------------------------------------------------------------------

function ZeroSkillCard({
  name,
  label,
  iconUrl,
  connector,
  pollingType,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  name: string;
  label: string;
  iconUrl: string | undefined;
  connector: ConnectorTypeWithStatus | null;
  pollingType: ConnectorType | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  const isPolling = pollingType === name;

  return (
    <div className="flex flex-col rounded-[var(--zero-card-radius)] border border-[var(--zero-card-border)] bg-card shadow-[var(--zero-card-shadow)]">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
          {name in CONNECTOR_TYPES ? (
            <ConnectorIcon type={name as ConnectorType} size={22} />
          ) : iconUrl ? (
            <img src={iconUrl} alt="" className="h-5 w-5 object-contain" />
          ) : (
            <IconPlug
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
          )}
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
          {label}
        </span>
      </div>

      <div className="flex h-11 items-center justify-between border-t border-border/50 pl-5 pr-2">
        <div className="flex items-center gap-2 min-w-0">
          {connector &&
            (isPolling ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <IconLoader2 size={12} stroke={1.5} className="animate-spin" />
                Connecting…
              </span>
            ) : connector.connected ? (
              <span className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                {connector.connector?.externalUsername
                  ? `@${connector.connector.externalUsername}`
                  : connector.connector?.authMethod === "api-token"
                    ? "API key"
                    : "Connected"}
              </span>
            ) : (
              <button
                type="button"
                onClick={onConnect}
                className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
              >
                {connector.availableAuthMethods.length === 1 &&
                connector.availableAuthMethods[0] === "api-token"
                  ? "Add API key"
                  : "Connect"}
              </button>
            ))}
          {!connector && (
            <span className="text-xs text-muted-foreground">Added</span>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label="More options"
            >
              <IconDotsVertical size={14} stroke={1.5} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {connector?.connected && (
              <DropdownMenuItem onClick={onDisconnect}>
                Disconnect
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onRemove}>Remove skill</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule tab — real schedule CRUD
// ---------------------------------------------------------------------------

function ZeroScheduleTab({ resolvedAgentName }: { resolvedAgentName: string }) {
  const entriesLoadable = useLoadable(zeroScheduleEntries$);
  const prefsLoadable = useLoadable(notificationPreferences$);
  const userTimezone =
    prefsLoadable.state === "hasData" ? prefsLoadable.data.timezone : null;
  const fetchSchedules = useSet(fetchZeroSchedules$);
  const saveSchedule = useSet(saveZeroSchedule$);
  const deleteSchedule = useSet(deleteZeroSchedule$);
  const toggleEnabled = useSet(toggleZeroScheduleEnabled$);
  const saving$ = useCCState(false);
  const saving = useGet(saving$);
  const setSaving = useSet(saving$);

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

  const handleSave = async (params: ZeroScheduleSaveParams) => {
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
        title={`${resolvedAgentName}'s schedule`}
        subtitle={`Set a time and prompt for ${resolvedAgentName} to run automatically.`}
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

// ---------------------------------------------------------------------------
// Skills tab — merged skills + connector management
// ---------------------------------------------------------------------------

function ZeroSkillsTab() {
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const pollingType = useGet(pollingConnectorType$);
  const connect = useSet(connectConnector$);
  const disconnect = useSet(deleteConnector$);
  const signal = useGet(pageSignal$);
  const addDialogOpen = useGet(addConnectionDialogOpen$);
  const setAddDialogOpen = useSet(setAddConnectionDialogOpen$);
  const selectedType = useGet(selectedConnectorType$);
  const setSelected = useSet(setSelectedConnectorType$);

  // Skills list: local draft, saved via compose jobs on explicit Save
  const addedSkillsLoadable = useLastLoadable(zeroAddedSkills$);
  const addedSkills =
    addedSkillsLoadable.state === "hasData" ? addedSkillsLoadable.data : [];
  const allSkills = useGet(skills$);
  const addSkill = useSet(addZeroSkill$);
  const removeSkill = useSet(removeZeroSkill$);
  const skillsDirtyLoadable = useLastLoadable(zeroSkillsDirty$);
  const skillsDirty =
    skillsDirtyLoadable.state === "hasData" ? skillsDirtyLoadable.data : false;
  const saveSkills = useSet(saveZeroSkills$);
  const discardSkills = useSet(discardZeroSkills$);
  const skillsSaving = useGet(zeroSettingsSaving$);

  // Optimistic connected state — set by connectConnector$/submitApiToken$
  // so the skill shows "Connected" immediately without waiting for refetch.
  const optimisticConnected = useGet(justConnectedTypes$);
  const clearOptimistic = useSet(clearJustConnectedTypes$);

  // Cache previous connector data so the list doesn't flash during refetch
  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  // Clear optimistic state once real data reflects the connection.
  // This is a safe render-body side effect: after clearing, optimisticConnected
  // becomes empty so the condition won't fire again (self-limiting, no loop).
  if (allTypesLoadable.state === "hasData" && optimisticConnected.size > 0) {
    clearOptimistic();
  }
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));
  const skillMap = new Map(allSkills.map((s) => [s.value, s]));
  const addedSet = new Set(addedSkills);

  const handleConnectSuccess = (type: string) => {
    detach(addSkill(type), Reason.DomCallback);
    const label =
      skillMap.get(type)?.label ??
      connectorMap.get(type as ConnectorType)?.label ??
      type;
    toast.success(`${label} added to skills`);
  };

  const handleRemoveSkill = (name: string) => {
    detach(removeSkill(name), Reason.DomCallback);
    const label =
      skillMap.get(name)?.label ??
      connectorMap.get(name as ConnectorType)?.label ??
      name;
    toast.success(`${label} removed from skills`);
  };

  return (
    <div className="mx-auto max-w-[900px] px-7 flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Skills manage your connections and help you get more out of these
        services.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Add skill */}
        <button
          type="button"
          onClick={() => setAddDialogOpen(true)}
          className="flex flex-col rounded-[var(--zero-card-radius)] border border-dashed border-border/80 transition-colors hover:border-border hover:bg-muted/30 group"
        >
          <div className="flex h-14 items-center gap-2.5 px-5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center">
              <IconPlus
                size={18}
                stroke={2}
                className="text-muted-foreground group-hover:text-foreground"
              />
            </span>
            <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground">
              Add skill
            </span>
          </div>
          <div className="flex h-11 items-center border-t border-dashed border-border/80 px-5 group-hover:border-border">
            <span className="text-xs text-muted-foreground/70">
              Browse 100+ popular skills
            </span>
          </div>
        </button>

        {/* Skeleton cards while loading */}
        {addedSkillsLoadable.state !== "hasData" &&
          addedSkills.length === 0 && (
            <>
              {Array.from({ length: 3 }, (_, i) => (
                <div
                  key={i}
                  className="flex flex-col rounded-[var(--zero-card-radius)] border border-border/50 bg-card animate-pulse"
                >
                  <div className="flex h-14 items-center gap-2.5 px-5">
                    <span className="h-7 w-7 shrink-0 rounded-lg bg-muted/50" />
                    <span className="h-4 w-24 rounded bg-muted/50" />
                  </div>
                  <div className="flex h-11 items-center border-t border-border/30 px-5">
                    <span className="h-3 w-16 rounded bg-muted/30" />
                  </div>
                </div>
              ))}
            </>
          )}

        {/* Skill cards */}
        {addedSkills.map((name) => {
          const skill = skillMap.get(name);
          const connector = connectorMap.get(name as ConnectorType) ?? null;
          const effectiveConnector =
            optimisticConnected.has(name) && connector && !connector.connected
              ? { ...connector, connected: true }
              : connector;
          return (
            <ZeroSkillCard
              key={name}
              name={name}
              label={skill?.label ?? name}
              iconUrl={skill?.icon}
              connector={effectiveConnector}
              pollingType={pollingType}
              onConnect={() => {
                const ct = connectorMap.get(name as ConnectorType);
                if (
                  ct &&
                  ct.availableAuthMethods.length === 1 &&
                  ct.availableAuthMethods[0] === "api-token"
                ) {
                  setSelected(name as ConnectorType);
                } else {
                  detach(
                    connect(name as ConnectorType, signal),
                    Reason.DomCallback,
                  );
                }
              }}
              onDisconnect={() => {
                detach(disconnect(name as ConnectorType), Reason.DomCallback);
                const label =
                  skillMap.get(name)?.label ??
                  connectorMap.get(name as ConnectorType)?.label ??
                  name;
                toast.success(`${label} disconnected`);
              }}
              onRemove={() => handleRemoveSkill(name)}
            />
          );
        })}
      </div>

      <AddConnectionDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        variant="zero"
        excludeTypes={addedSet}
        onConnectSuccess={handleConnectSuccess}
        onAdd={handleConnectSuccess}
      />

      {selectedType && (
        <ConnectModal
          onClose={() => setSelected(null)}
          onSuccess={() => {
            if (selectedType && !addedSet.has(selectedType)) {
              handleConnectSuccess(selectedType);
            }
          }}
        />
      )}

      {(skillsDirty || skillsSaving) &&
        createPortal(
          <div className="zero-app fixed bottom-6 left-0 right-0 z-40 flex justify-center px-4 sm:left-[255px]">
            <div className="zero-card flex max-w-md items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4 shadow-lg">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <IconPencil
                  size={18}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
                <span>You have unsaved changes</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => discardSkills()}
                  disabled={skillsSaving}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() => detach(saveSkills(), Reason.DomCallback)}
                  disabled={skillsSaving}
                >
                  {skillsSaving ? (
                    <IconLoader2
                      size={14}
                      stroke={1.5}
                      className="animate-spin mr-1.5"
                    />
                  ) : null}
                  Save
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Instructions tab — editable textarea with build
// ---------------------------------------------------------------------------

function ZeroInstructionsTab() {
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

  const rawContent = instructions?.content ?? "";
  const strippedContent = stripMetadataFrontmatter(rawContent);
  const displayContent = edited ?? strippedContent;

  return (
    <div className="mx-auto max-w-[900px] px-7">
      <Card className="zero-card-white">
        <CardContent className="py-7">
          {loading ? (
            <div className="space-y-4 animate-pulse">
              <div className="h-5 w-40 rounded bg-muted/50" />
              <div className="h-64 w-full rounded bg-muted/30" />
            </div>
          ) : fetchError ? (
            <p className="text-sm text-destructive">{fetchError}</p>
          ) : (
            <>
              <textarea
                aria-label="Agent instructions editor"
                className="px-1 text-sm font-mono text-foreground w-full min-h-[200px] bg-transparent border-none outline-none resize-none whitespace-pre-wrap leading-relaxed"
                value={displayContent}
                onChange={(e) => setEdited(e.target.value)}
                rows={Math.max(10, displayContent.split("\n").length + 2)}
                disabled={isBuilding}
                placeholder="Write instructions for your agent..."
              />
              <div className="flex items-center gap-2 pt-5 mt-5 border-t border-border/60">
                <p className="text-muted-foreground text-xs">
                  Edit the instructions directly to customize your agent&apos;s
                  behavior.
                </p>
                {buildError && (
                  <span className="text-xs font-medium text-destructive">
                    {buildError}
                  </span>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {(isDirty || isBuilding) &&
        createPortal(
          <div className="zero-app fixed bottom-6 left-0 right-0 z-40 flex justify-center px-4 sm:left-[255px]">
            <div className="zero-card flex max-w-md items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4 shadow-lg">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <IconPencil
                  size={18}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
                <span>You have unsaved changes</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={discard}
                  disabled={isBuilding}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() => detach(build(), Reason.DomCallback)}
                  disabled={isBuilding}
                >
                  {isBuilding ? (
                    <IconLoader2
                      size={14}
                      stroke={1.5}
                      className="animate-spin mr-1.5"
                    />
                  ) : null}
                  Save
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings tab — name + tone (wired to real API for agent name persistence)
// ---------------------------------------------------------------------------

function ZeroSettingsTab({
  agentName: resolvedAgentName,
  sound: initialSound,
}: {
  agentName: string;
  sound: Tone;
}) {
  const agentName$ = useCCState(resolvedAgentName);
  const agentName = useGet(agentName$);
  const setAgentName = useSet(agentName$);
  const tone$ = useCCState<Tone>(initialSound);
  const tone = useGet(tone$);
  const setTone = useSet(tone$);
  const savedSettings$ = useCCState<{ name: string; tone: Tone }>({
    name: resolvedAgentName,
    tone: initialSound,
  });
  const savedSettings = useGet(savedSettings$);
  const setSavedSettings = useSet(savedSettings$);
  const saving = useGet(zeroSettingsSaving$);

  // Sync local state when props change (e.g. metadata finishes loading)
  const prevProps$ = useCCState({
    name: resolvedAgentName,
    tone: initialSound,
  });
  const prevProps = useGet(prevProps$);
  const setPrevProps = useSet(prevProps$);
  if (resolvedAgentName !== prevProps.name || initialSound !== prevProps.tone) {
    queueMicrotask(() => {
      setPrevProps({ name: resolvedAgentName, tone: initialSound });
      setAgentName(resolvedAgentName);
      setTone(initialSound);
      setSavedSettings({ name: resolvedAgentName, tone: initialSound });
    });
  }

  const isSettingsDirty =
    agentName !== savedSettings.name || tone !== savedSettings.tone;

  const handleResetSettings = () => {
    setAgentName(savedSettings.name);
    setTone(savedSettings.tone);
  };

  const handleSaveSettings$ = useCommand(async ({ get, set }) => {
    const currentName = get(agentName$);
    const currentTone = get(tone$);
    await set(zeroUpdateSettings$, {
      displayName: currentName,
      sound: currentTone,
    });
    set(savedSettings$, { name: currentName, tone: currentTone });
  });
  const handleSaveSettings = useSet(handleSaveSettings$);

  return (
    <>
      <div className="mx-auto max-w-[900px] px-7">
        <Card className="zero-card">
          <CardContent className="py-5 flex flex-col gap-4">
            <div className="flex flex-col gap-8">
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="zero-agent-name"
                  className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Name
                </label>
                <Input
                  id="zero-agent-name"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="What should we call them?"
                  className="h-9"
                />
              </div>
              <div
                className="flex flex-col gap-2"
                role="group"
                aria-label={`How ${resolvedAgentName} sounds`}
              >
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  How they sound
                </span>
                <div
                  className="flex flex-wrap gap-2"
                  role="group"
                  aria-label="Tone"
                >
                  {TONE_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setTone(opt)}
                      className={cn(
                        "rounded-lg border px-4 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                        tone === opt
                          ? "border-primary/40 bg-primary/10 text-primary dark:border-primary/50 dark:bg-primary/15"
                          : "zero-chip text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {toneLabel(opt)}
                    </button>
                  ))}
                </div>
                <div
                  className="zero-chip rounded-lg border px-3 py-2 transition-colors duration-200"
                  key={tone}
                >
                  <p className="text-xs text-muted-foreground italic min-h-[1.25rem] leading-relaxed">
                    {TONE_HINT[tone]}
                  </p>
                  <div className="my-2 border-t border-border/30" />
                  <div className="flex flex-col gap-1.5 pb-1.5">
                    <div className="flex justify-end">
                      <div className="zero-bubble-cool max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed transition-colors duration-200">
                        {TONE_SAMPLES[tone].user}
                      </div>
                    </div>
                    <div className="flex justify-start">
                      <div className="zero-chat-bubble-assistant max-w-[85%] rounded-2xl border px-3 py-2 text-sm text-foreground leading-relaxed transition-colors duration-200">
                        {TONE_SAMPLES[tone].zero}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {isSettingsDirty &&
        createPortal(
          <div className="zero-app fixed bottom-6 left-0 right-0 z-40 flex justify-center px-4 sm:left-[255px]">
            <div className="zero-card flex max-w-md items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4 shadow-lg">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <IconPencil
                  size={18}
                  stroke={1.5}
                  className="shrink-0 text-muted-foreground"
                />
                <span>You have unsaved changes</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={handleResetSettings}
                  disabled={saving}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  className="h-9 rounded-lg px-4 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() =>
                    detach(handleSaveSettings(), Reason.DomCallback)
                  }
                  disabled={saving}
                >
                  {saving ? (
                    <IconLoader2
                      size={14}
                      stroke={1.5}
                      className="animate-spin mr-1.5"
                    />
                  ) : null}
                  Save
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
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
        {activeTab === "skills" && <ZeroSkillsTab />}

        {activeTab === "schedule" && (
          <ZeroScheduleTab resolvedAgentName={resolvedAgentName} />
        )}

        {activeTab === "settings" && (
          <ZeroSettingsTab
            agentName={resolvedAgentName}
            sound={resolvedSound}
          />
        )}

        {activeTab === "instructions" && <ZeroInstructionsTab />}
      </main>
    </div>
  );
}
