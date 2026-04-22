// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCalendar,
  IconCircleDot,
  IconFileText,
  IconPlayerPlay,
  IconRotateClockwise2,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import {
  Button,
  Card,
  CardContent,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { Link } from "../router/link.tsx";
import { detachedNavigateTo$, pathParams$ } from "../../signals/route.ts";
import { agents$ } from "../../signals/agent.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  allOrgScheduleEntries$,
  allOrgSchedulesLoaded$,
  saveOrgSchedule$,
  toggleOrgScheduleEnabled$,
  deleteOrgSchedule$,
  runScheduleNow$,
  type OrgScheduleEntry,
  type ZeroScheduleSaveParams,
} from "../../signals/zero-page/zero-schedule.ts";
import { slackOrgData$ } from "../../signals/zero-page/zero-slack.ts";
import {
  scheduleDetailTab$,
  setScheduleDetailTab$,
} from "../../signals/schedule-page/schedule-detail-tab.ts";
import { LogTable, STATUS_LABELS } from "./components/log-views/log-table.tsx";
import { Pagination } from "../components/pagination.tsx";
import {
  scheduleRunData$,
  scheduleRunLimit$,
  scheduleRunHasPrev$,
  scheduleRunCurrentPage$,
  goToNextScheduleRunPage$,
  goToPrevScheduleRunPage$,
  goForwardTwoScheduleRunPages$,
  goBackTwoScheduleRunPages$,
  setScheduleRunRowsPerPage$,
  scheduleRunStatusFilter$,
  setScheduleRunStatusFilter$,
  scheduleRunAvailableStatuses$,
} from "../../signals/schedule-page/schedule-run-history.ts";
import { ZeroNoPermissionIllustration } from "./components/zero-no-permission-illustration.tsx";
import { InlineSettingsRow } from "./components/zero-inline-settings-row.tsx";
import {
  buildCombinedSchedule,
  ScheduleEditFields,
  type CombinedEntry,
} from "./zero-schedule-page.tsx";
import { parseScheduleTimeString } from "./zero-schedule-card.tsx";
import { TiptapInstructionsEditor } from "./tiptap-instructions-editor.tsx";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";
import {
  scheduleForm$,
  updateScheduleForm$,
  savedSettingsState$,
  setSavedSettingsState$,
  showDeleteConfirm$,
  setShowDeleteConfirm$,
  instructionDraft$,
  setInstructionDraft$,
  discardNonce$,
  incrementDiscardNonce$,
  syncSettingsFormEntry$,
  syncInstructionDraftEntry$,
  type ScheduleSettingsSnapshot,
} from "../../signals/schedule-page/schedule-form.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";
import { FeatureSwitchKey } from "@vm0/core";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";

const SCHEDULE_DETAIL_TAB_TRIGGER_CLASS =
  "gap-1.5 text-sm data-[state=active]:bg-background px-3";

function formatRunAt(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Max length for schedule detail heading and breadcrumb (instruction-derived). */
const SCHEDULE_DETAIL_TITLE_MAX = 30;

function excerptText(text: string, maxLen: number): string {
  const t = text.trim();
  if (t.length <= maxLen) {
    return t;
  }
  return `${t.slice(0, maxLen - 1)}\u2026`;
}

/** First sentence for titles (Latin . ! ? + space/end; CJK 。！？); else first line. */
function firstSentenceFromInstruction(text: string): string {
  const t = text.trim();
  if (t.length === 0) {
    return "";
  }
  const match = t.match(/^[\s\S]*?(?:[。！？]|[.!?](?:\s|$))/);
  if (match) {
    return match[0].trim();
  }
  const firstLine = t.split(/\r?\n/)[0]?.trim() ?? t;
  return firstLine;
}

/** Short label for breadcrumb when the full instruction summary is long. */
function scheduleDetailBreadcrumbLabel(entry: CombinedEntry): string {
  const desc = entry.description?.trim();
  if (desc && desc.length > 0) {
    return excerptText(desc, SCHEDULE_DETAIL_TITLE_MAX);
  }
  const promptTrim = entry.prompt.trim();
  if (promptTrim.length > 0) {
    const first = firstSentenceFromInstruction(promptTrim);
    const label = first.length > 0 ? first : promptTrim;
    return excerptText(label, SCHEDULE_DETAIL_TITLE_MAX);
  }
  if (entry.name !== undefined && entry.name.trim().length > 0) {
    return entry.name.trim();
  }
  return "Schedule";
}

function ScheduleBreadcrumbLink() {
  return (
    <Link
      pathname="/schedules"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
    >
      <IconCalendar size={14} stroke={1.5} className="shrink-0" />
      Scheduled
    </Link>
  );
}

function ScheduleDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <ScheduleBreadcrumbLink />
        <span className="text-muted-foreground/40 select-none">/</span>
        <div className="h-4 w-32 rounded bg-muted/50 animate-pulse" />
      </nav>
      <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
        <div className="mx-auto max-w-[900px]">
          <div className="flex items-stretch gap-4">
            <Skeleton className="h-14 w-14 shrink-0 rounded-xl bg-muted/60 sm:h-16 sm:w-16" />
            <div className="min-w-0 flex-1 h-14 sm:h-16 flex flex-col justify-center gap-1.5">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
          </div>
          <div className="mt-6 flex h-9 items-center">
            <Skeleton className="h-9 w-full max-w-md rounded-lg bg-muted/50" />
          </div>
        </div>
      </header>
      <main className="shrink-0 px-4 sm:px-6 pt-4 pb-16">
        <div className="mx-auto max-w-[900px]">
          <Card className="zero-card overflow-hidden">
            <CardContent className="p-4 sm:p-5 space-y-4">
              <Skeleton className="h-20 w-full" />
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}

function ScheduleNotFound() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <ScheduleBreadcrumbLink />
        <span className="text-muted-foreground/40 select-none">/</span>
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
          Schedule
        </span>
      </nav>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 pb-20">
        <ZeroNoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain opacity-90" />
        <h2 className="text-lg font-semibold text-foreground">
          Schedule not found
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          This schedule doesn&apos;t exist or was removed.
        </p>
        <Link
          pathname="/schedules"
          className="zero-btn-morandi mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
        >
          Back to scheduled tasks
        </Link>
      </div>
    </div>
  );
}

/** Matches Agent + schedule dropdown column width on the detail settings layout. */
const SCHEDULE_DETAIL_CONTROL_WIDTH =
  "w-full sm:w-[min(100%,20rem)] sm:ml-auto";

type ScheduleAgentOption = {
  id: string;
  displayName?: string | null;
};

// ScheduleSettingsSnapshot imported from signals/schedule-page/schedule-form.ts

function buildSettingsSnapshot(
  entry: CombinedEntry,
  parsed: ReturnType<typeof parseScheduleTimeString>,
): ScheduleSettingsSnapshot {
  return {
    freq: parsed.freq,
    date: parsed.date,
    hour: parsed.hour,
    minute: parsed.minute,
    timezone: entry.timezone ?? parsed.timezone,
    loopMinutes: parsed.loopMinutes,
    agentId: entry.agentId,
    description: entry.description ?? "",
    dayOfWeek: parsed.dayOfWeek ?? "1",
    dayOfMonth: parsed.dayOfMonth ?? "1",
    modelProviderId: entry.modelProviderId,
    selectedModel: entry.selectedModel,
  };
}

function isSettingsChanged(
  a: ScheduleSettingsSnapshot,
  b: ScheduleSettingsSnapshot,
): boolean {
  return (
    a.freq !== b.freq ||
    a.date !== b.date ||
    a.hour !== b.hour ||
    a.minute !== b.minute ||
    a.timezone !== b.timezone ||
    a.loopMinutes !== b.loopMinutes ||
    a.agentId !== b.agentId ||
    a.description !== b.description ||
    a.modelProviderId !== b.modelProviderId ||
    a.selectedModel !== b.selectedModel
  );
}

function ScheduleSettingsForm({
  entry,
  agents,
  saving,
  toggling,
  onSave,
  onToggle,
  onDelete,
}: {
  entry: CombinedEntry;
  agents: ScheduleAgentOption[];
  saving: boolean;
  toggling: boolean;
  onSave: (
    params: ZeroScheduleSaveParams & { agentId: string },
  ) => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onDelete: () => void;
}) {
  const parsed = parseScheduleTimeString(entry.time);
  const initial = buildSettingsSnapshot(entry, parsed);

  const form = useGet(scheduleForm$);
  const updateForm = useSet(updateScheduleForm$);
  const savedState = useGet(savedSettingsState$);
  const setSavedState = useSet(setSavedSettingsState$);
  const showDeleteConfirmVal = useGet(showDeleteConfirm$);
  const setShowDeleteConfirmVal = useSet(setShowDeleteConfirm$);

  const features = useLastResolved(featureSwitch$);
  const showModelPicker =
    features?.[FeatureSwitchKey.ModelProviderSelection] ?? false;
  const orgProviders = useLastResolved(orgModelProviders$);

  // Reset form when entry changes (component is keyed by entry.id)
  useSet(syncSettingsFormEntry$)(entry.id, entry.prompt, initial);

  const current: ScheduleSettingsSnapshot = {
    freq: form.freq,
    date: form.date,
    hour: form.hour,
    minute: form.minute,
    timezone: form.timezone,
    loopMinutes: form.loopMinutes,
    agentId: form.agentId,
    description: form.description,
    dayOfWeek: form.dayOfWeek,
    dayOfMonth: form.dayOfMonth,
    modelProviderId: form.modelProviderId,
    selectedModel: form.selectedModel,
  };
  const isDirty = savedState ? isSettingsChanged(current, savedState) : false;

  const handleDiscard = () => {
    if (!savedState) {
      return;
    }
    updateForm({
      freq: savedState.freq,
      date: savedState.date,
      hour: savedState.hour,
      minute: savedState.minute,
      timezone: savedState.timezone,
      loopMinutes: savedState.loopMinutes,
      agentId: savedState.agentId,
      description: savedState.description,
      modelProviderId: savedState.modelProviderId,
      selectedModel: savedState.selectedModel,
    });
  };

  const handleSave = async () => {
    if (!entry.prompt.trim() || entry.name === undefined) {
      return;
    }
    await onSave({
      prompt: entry.prompt.trim(),
      description: form.description,
      freq: form.freq,
      date: form.date,
      hour: form.hour,
      minute: form.minute,
      timezone: form.timezone,
      intervalSeconds: form.loopMinutes * 60,
      editName: entry.name,
      agentId: form.agentId,
      modelProviderId: form.modelProviderId,
      selectedModel: form.selectedModel,
      ...(form.freq === "every_week" ? { dayOfWeek: form.dayOfWeek } : {}),
      ...(form.freq === "every_month" ? { dayOfMonth: form.dayOfMonth } : {}),
    });
    setSavedState(current);
  };

  const canDelete = entry.name !== undefined;

  return (
    <>
      <Card className="zero-card overflow-hidden">
        <CardContent className="p-4 sm:p-5">
          <InlineSettingsRow
            label="Agent"
            description="The agent is fixed once a schedule is created. Delete and recreate the schedule to run it on a different agent."
          >
            <div className={SCHEDULE_DETAIL_CONTROL_WIDTH}>
              <Select value={form.agentId} disabled>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((a) => {
                    return (
                      <SelectItem key={a.id} value={a.id}>
                        {a.displayName ?? a.id}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          </InlineSettingsRow>

          <InlineSettingsRow
            label="Description"
            description="A short summary shown in the schedule list. Leave blank to auto-generate."
          >
            <div className={SCHEDULE_DETAIL_CONTROL_WIDTH}>
              <Input
                value={form.description}
                onChange={(e) => {
                  return updateForm({ description: e.target.value });
                }}
                placeholder="Leave blank to auto-generate"
                className="h-9"
                disabled={saving}
              />
            </div>
          </InlineSettingsRow>

          <InlineSettingsRow
            label="Schedule"
            description="How often this task runs and at what local time."
          >
            <fieldset
              disabled={saving}
              className={cn(
                "min-w-0 border-0 p-0 m-0 space-y-3 disabled:opacity-60",
                SCHEDULE_DETAIL_CONTROL_WIDTH,
              )}
            >
              <ScheduleEditFields
                freq={form.freq}
                setFreq={(v) => {
                  return updateForm({ freq: v });
                }}
                loopMinutes={form.loopMinutes}
                setLoopMinutes={(v) => {
                  return updateForm({ loopMinutes: v });
                }}
                date={form.date}
                setDate={(v) => {
                  return updateForm({ date: v });
                }}
                hour={form.hour}
                setHour={(v) => {
                  return updateForm({ hour: v });
                }}
                minute={form.minute}
                setMinute={(v) => {
                  return updateForm({ minute: v });
                }}
                timezone={form.timezone}
                setTimezone={(v) => {
                  return updateForm({ timezone: v });
                }}
              />
            </fieldset>
          </InlineSettingsRow>

          <InlineSettingsRow
            label="Status"
            description="Paused schedules do not run until re-enabled."
            alignControls="center"
          >
            <LoadingSwitch
              checked={entry.enabled !== false}
              loading={toggling}
              onCheckedChange={(checked) => {
                detach(onToggle(checked), Reason.DomCallback);
              }}
              ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} this schedule`}
            />
          </InlineSettingsRow>

          {showModelPicker &&
            orgProviders &&
            orgProviders.modelProviders.length > 0 && (
              <InlineSettingsRow
                label="Model"
                description="Override the org default model for this schedule."
              >
                <div className={SCHEDULE_DETAIL_CONTROL_WIDTH}>
                  <ModelProviderPicker
                    providers={orgProviders.modelProviders}
                    value={
                      form.modelProviderId && form.selectedModel
                        ? {
                            modelProviderId: form.modelProviderId,
                            selectedModel: form.selectedModel,
                          }
                        : null
                    }
                    onChange={(sel: ModelProviderSelection | null) => {
                      updateForm({
                        modelProviderId: sel?.modelProviderId ?? null,
                        selectedModel: sel?.selectedModel ?? null,
                      });
                    }}
                  />
                </div>
              </InlineSettingsRow>
            )}
        </CardContent>
      </Card>

      {canDelete && (
        <Card className="zero-card overflow-hidden border-destructive/20">
          <CardContent className="p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0 sm:max-w-[46%]">
                <h3 className="text-sm font-medium text-foreground">
                  Danger zone
                </h3>
                <p className="text-xs text-muted-foreground mt-1 leading-snug">
                  Deleting removes this schedule permanently.
                </p>
              </div>
              <div className="flex shrink-0 self-end sm:self-auto sm:pt-0.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => {
                    return setShowDeleteConfirmVal(true);
                  }}
                >
                  <IconTrash size={14} stroke={1.5} />
                  Delete schedule
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {isDirty && (
        <ZeroUnsavedBar
          onDiscard={handleDiscard}
          onSave={() => {
            return detach(handleSave(), Reason.DomCallback);
          }}
          saving={saving}
        />
      )}

      <Dialog
        open={showDeleteConfirmVal}
        onOpenChange={(open) => {
          if (!open) {
            setShowDeleteConfirmVal(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule?</DialogTitle>
            <DialogDescription>
              This will permanently delete the schedule{" "}
              <span className="font-medium text-foreground">
                {entry.description ?? entry.prompt}
              </span>
              . This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                return setShowDeleteConfirmVal(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setShowDeleteConfirmVal(false);
                onDelete();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Isolated editor state: parent sets `key={entry.id + entry.prompt}` so a
 * successful save remounts and clears drafts without useEffect.
 */
function ScheduleInstructionEditorBlock({
  entry,
  saving,
  onSavePrompt,
}: {
  entry: CombinedEntry;
  saving: boolean;
  onSavePrompt: (prompt: string) => void;
}) {
  const draft = useGet(instructionDraft$);
  const setDraft = useSet(setInstructionDraft$);
  const nonce = useGet(discardNonce$);
  const incrementNonce = useSet(incrementDiscardNonce$);
  // Reset draft when entry changes (component is keyed by entry.id + prompt)
  const initKey = `${entry.id}\u0000${entry.prompt}`;
  useSet(syncInstructionDraftEntry$)(initKey);

  const isDirty = draft !== null && draft.trim() !== entry.prompt.trim();

  return (
    <>
      <TiptapInstructionsEditor
        key={`schedule-instr-${entry.id}-${entry.prompt}-${nonce}`}
        initialContent={draft ?? entry.prompt}
        onChange={setDraft}
        disabled={saving}
        footerHint="This instruction runs each time this schedule executes."
      />
      {isDirty && (
        <ZeroUnsavedBar
          onDiscard={() => {
            setDraft(null);
            incrementNonce();
          }}
          onSave={() => {
            onSavePrompt((draft ?? entry.prompt).trim());
          }}
          saving={saving}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Run History tab
// ---------------------------------------------------------------------------

function ScheduleRunHistoryTab() {
  const pageSignal = useGet(pageSignal$);
  const dataLoadable = useLastLoadable(scheduleRunData$);
  const hasPrev = useGet(scheduleRunHasPrev$);
  const currentPage = useGet(scheduleRunCurrentPage$);
  const rowsPerPage = useGet(scheduleRunLimit$);
  const goToNext = useSet(goToNextScheduleRunPage$);
  const goToPrev = useSet(goToPrevScheduleRunPage$);
  const goForwardTwo = useSet(goForwardTwoScheduleRunPages$);
  const goBackTwo = useSet(goBackTwoScheduleRunPages$);
  const setRowsPerPage = useSet(setScheduleRunRowsPerPage$);

  const statusFilter = useGet(scheduleRunStatusFilter$);
  const setStatusFilter = useSet(setScheduleRunStatusFilter$);
  const availableStatusesLoadable = useLastLoadable(
    scheduleRunAvailableStatuses$,
  );

  const logs = dataLoadable.state === "hasData" ? dataLoadable.data.data : [];
  const hasNext =
    dataLoadable.state === "hasData" && dataLoadable.data.pagination.hasMore;
  const totalPages =
    dataLoadable.state === "hasData"
      ? dataLoadable.data.pagination.totalPages
      : undefined;
  const isLoading = dataLoadable.state === "loading";

  const statusOptions = [
    { value: "all", label: "All status" },
    ...(availableStatusesLoadable.state === "hasData"
      ? availableStatusesLoadable.data.map((s) => {
          return {
            value: s,
            label: STATUS_LABELS[s],
          };
        })
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Filter row */}
      <div className="flex items-center gap-2">
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            return setStatusFilter(v);
          }}
        >
          <SelectTrigger
            aria-label="Status filter"
            className="zero-btn-morandi h-9 w-auto gap-1.5 rounded-lg px-3.5 text-sm font-medium"
          >
            <IconCircleDot size={14} stroke={1.5} className="shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statusOptions.map((opt) => {
              return (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card className="zero-card overflow-hidden">
        <CardContent className="pb-3 pt-0 px-0">
          <LogTable
            logs={logs}
            isLoading={isLoading}
            rowsPerPage={rowsPerPage}
            emptyTitle="No runs yet"
            emptyDescription="When this schedule runs, its history will show up here."
            filteredEmptyTitle="Nothing matches that filter"
            filteredEmptyDescription="Try a different status filter."
            hasActiveFilter={statusFilter !== "all"}
            minWidth="440px"
          />
        </CardContent>
      </Card>

      {/* Pagination */}
      {(totalPages === undefined || totalPages > 1) && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          rowsPerPage={rowsPerPage}
          hasNext={hasNext}
          hasPrev={hasPrev}
          isLoading={isLoading}
          labelClassName="font-normal text-muted-foreground"
          buttonClassName="bg-transparent border-border/70"
          onNextPage={() => {
            return detach(goToNext(pageSignal), Reason.DomCallback);
          }}
          onPrevPage={() => {
            return goToPrev();
          }}
          onForwardTwoPages={() => {
            return detach(goForwardTwo(pageSignal), Reason.DomCallback);
          }}
          onBackTwoPages={() => {
            return goBackTwo();
          }}
          onRowsPerPageChange={(limit) => {
            return setRowsPerPage(limit);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function ScheduleDetailView({
  entry,
  dimmed,
  toggling,
  running,
  saving,
  agents,
  onSettingsSave,
  onToggle,
  onRunNow,
  onDelete,
  onInstructionSavePrompt,
}: {
  entry: CombinedEntry;
  dimmed: boolean;
  toggling: boolean;
  running: boolean;
  saving: boolean;
  agents: ScheduleAgentOption[];
  onSettingsSave: (
    params: ZeroScheduleSaveParams & { agentId: string },
  ) => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onRunNow: () => Promise<void>;
  onDelete: () => void;
  onInstructionSavePrompt: (prompt: string) => void;
}) {
  const promptTrim = entry.prompt.trim();
  const summaryTitle = (() => {
    const desc = entry.description?.trim();
    if (desc && desc.length > 0) {
      return desc;
    }
    if (promptTrim.length === 0) {
      return "No instruction";
    }
    const first = firstSentenceFromInstruction(promptTrim);
    if (first.length === 0) {
      return "No instruction";
    }
    return first;
  })();
  const breadcrumbLabel = scheduleDetailBreadcrumbLabel(entry);
  const nextRunLabel = formatRunAt(entry.nextRunAt);
  const isActive = entry.enabled !== false;

  const activeTab = useGet(scheduleDetailTab$);
  const setActiveTab = useSet(setScheduleDetailTab$);

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (v === "settings" || v === "instructions" || v === "history") {
            setActiveTab(v);
          }
        }}
        className="flex flex-1 flex-col min-h-0"
      >
        <nav className="hidden sm:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          <ScheduleBreadcrumbLink />
          <span className="text-muted-foreground/40 select-none">/</span>
          <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate min-w-0">
            {breadcrumbLabel}
          </span>
        </nav>

        <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-0">
          <div className="mx-auto max-w-[900px]">
            <div
              className={cn(
                "flex flex-col gap-2 min-w-0 sm:flex-row sm:items-center sm:gap-4",
                dimmed && "opacity-90",
              )}
            >
              <div
                className="h-[54px] w-[54px] flex items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
                aria-hidden
              >
                <IconCalendar
                  size={24}
                  stroke={1.25}
                  className="shrink-0 opacity-90"
                />
              </div>
              <div className="min-w-0 flex-1 flex flex-col gap-1">
                <h1 className="min-w-0 text-base sm:text-lg font-semibold tracking-tight text-foreground leading-tight truncate">
                  {summaryTitle}
                </h1>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground leading-tight">
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        isActive ? "bg-emerald-500" : "bg-muted-foreground/50",
                      )}
                      aria-hidden
                    />
                    <span
                      className={cn(
                        "font-medium",
                        isActive ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {isActive ? "Active" : "Paused"}
                    </span>
                  </span>
                  <span
                    className="text-muted-foreground/40 select-none"
                    aria-hidden
                  >
                    ·
                  </span>
                  <span className="text-foreground/80 whitespace-nowrap">
                    {entry.time}
                  </span>
                  <span
                    className="text-muted-foreground/40 select-none"
                    aria-hidden
                  >
                    ·
                  </span>
                  <span className="whitespace-nowrap">
                    <span className="font-medium text-foreground/70">
                      Next run
                    </span>{" "}
                    <span className="tabular-nums">{nextRunLabel}</span>
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:mt-6 sm:flex-row sm:h-9 sm:items-center sm:justify-between">
              {/* Mobile: Select dropdown */}
              <div className="sm:hidden w-full">
                <Select
                  value={activeTab}
                  onValueChange={(v) => {
                    if (
                      v === "settings" ||
                      v === "instructions" ||
                      v === "history"
                    ) {
                      setActiveTab(v);
                    }
                  }}
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="settings">Settings</SelectItem>
                    <SelectItem value="instructions">Instructions</SelectItem>
                    <SelectItem value="history">Run History</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Desktop: tab list */}
              <TabsList className="zero-tabs hidden sm:inline-flex h-9 gap-1 px-1 py-1">
                <TabsTrigger
                  value="settings"
                  className={SCHEDULE_DETAIL_TAB_TRIGGER_CLASS}
                >
                  <IconSettings size={14} stroke={1.5} />
                  Settings
                </TabsTrigger>
                <TabsTrigger
                  value="instructions"
                  className={SCHEDULE_DETAIL_TAB_TRIGGER_CLASS}
                >
                  <IconFileText size={14} stroke={1.5} />
                  Instructions
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  className={SCHEDULE_DETAIL_TAB_TRIGGER_CLASS}
                >
                  <IconRotateClockwise2 size={14} stroke={1.5} />
                  Run History
                </TabsTrigger>
              </TabsList>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="zero-btn-morandi h-9 shrink-0 gap-2 rounded-lg px-4 border text-sm font-medium transition-colors hover:bg-accent"
                disabled={running || !entry.prompt.trim()}
                onClick={() => {
                  detach(onRunNow(), Reason.DomCallback);
                }}
              >
                <IconPlayerPlay size={14} stroke={1.5} />
                {running ? "Starting…" : "Run now"}
              </Button>
            </div>
          </div>
        </header>

        <main
          className={cn(
            "shrink-0 flex-1 px-4 sm:px-6 pt-4 sm:pt-6 pb-16 transition-opacity",
            dimmed && "opacity-90",
          )}
        >
          <div className="mx-auto max-w-[900px] flex flex-col gap-4">
            {activeTab === "settings" && (
              <ScheduleSettingsForm
                key={entry.id}
                entry={entry}
                agents={agents}
                saving={saving}
                toggling={toggling}
                onSave={onSettingsSave}
                onToggle={onToggle}
                onDelete={onDelete}
              />
            )}

            {activeTab === "instructions" && (
              <div className="mx-auto w-full max-w-[900px]">
                <ScheduleInstructionEditorBlock
                  key={`${entry.id}\u0000${entry.prompt}`}
                  entry={entry}
                  saving={saving}
                  onSavePrompt={onInstructionSavePrompt}
                />
              </div>
            )}

            {activeTab === "history" && <ScheduleRunHistoryTab />}
          </div>
        </main>
      </Tabs>
    </div>
  );
}

function ScheduleActionsContainer({
  entry,
  dimmed,
  agents,
}: {
  entry: CombinedEntry;
  dimmed: boolean;
  agents: ScheduleAgentOption[];
}) {
  const pageSignal = useGet(pageSignal$);
  const [savingLoadable, saveScheduleTracked] =
    useLoadableSet(saveOrgSchedule$);
  const [togglingLoadable, toggleEnabledTracked] = useLoadableSet(
    toggleOrgScheduleEnabled$,
  );
  const [runningLoadable, runScheduleNowTracked] =
    useLoadableSet(runScheduleNow$);
  const deleteSchedule = useSet(deleteOrgSchedule$);
  const navigate = useSet(detachedNavigateTo$);

  const saving = savingLoadable.state === "loading";
  const toggling = togglingLoadable.state === "loading";
  const running = runningLoadable.state === "loading";

  const handleSettingsSave = async (
    params: ZeroScheduleSaveParams & { agentId: string },
  ) => {
    await saveScheduleTracked(params, pageSignal);
  };

  const handleInstructionSavePrompt = (prompt: string) => {
    if (!prompt) {
      return;
    }
    const parsed = parseScheduleTimeString(entry.time);
    detach(
      saveScheduleTracked(
        {
          prompt,
          description: entry.description ?? undefined,
          freq: parsed.freq,
          date: parsed.date,
          hour: parsed.hour,
          minute: parsed.minute,
          timezone: entry.timezone ?? parsed.timezone,
          intervalSeconds: parsed.loopMinutes * 60,
          editName: entry.name,
          agentId: entry.agentId,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const handleToggle = async (enabled: boolean) => {
    if (entry.name === undefined) {
      return;
    }
    await toggleEnabledTracked(
      {
        name: entry.name,
        enabled,
        agentId: entry.agentId,
      },
      pageSignal,
    );
  };

  const handleRunNow = async () => {
    await runScheduleNowTracked(entry.id, pageSignal);
  };

  const handleDelete = () => {
    if (entry.name === undefined) {
      return;
    }
    detach(
      deleteSchedule(
        { name: entry.name, agentId: entry.agentId },
        pageSignal,
      ).then(() => {
        navigate("/schedules");
      }),
      Reason.DomCallback,
    );
  };

  return (
    <ScheduleDetailView
      entry={entry}
      dimmed={dimmed}
      toggling={toggling}
      running={running}
      saving={saving}
      agents={agents}
      onSettingsSave={handleSettingsSave}
      onToggle={handleToggle}
      onRunNow={handleRunNow}
      onDelete={handleDelete}
      onInstructionSavePrompt={handleInstructionSavePrompt}
    />
  );
}

export function ZeroScheduleDetailPage() {
  const params = useGet(pathParams$);
  const scheduleId =
    params && typeof params === "object" && "scheduleId" in params
      ? String(params.scheduleId)
      : null;

  const entriesLoadable = useLastLoadable(allOrgScheduleEntries$);
  const entries: OrgScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  const schedulesLoaded = useGet(allOrgSchedulesLoaded$);
  const slackData = useLastLoadable(slackOrgData$);

  const combinedSchedule = buildCombinedSchedule(entries);

  if (!scheduleId) {
    return <ScheduleNotFound />;
  }

  if (
    !schedulesLoaded ||
    entriesLoadable.state !== "hasData" ||
    slackData.state !== "hasData"
  ) {
    return <ScheduleDetailSkeleton />;
  }

  const entry = combinedSchedule.find((e) => {
    return e.id === scheduleId;
  });

  if (!entry) {
    return <ScheduleNotFound />;
  }

  const dimmed = entry.enabled === false;

  return (
    <ScheduleActionsContainer entry={entry} dimmed={dimmed} agents={agents} />
  );
}
