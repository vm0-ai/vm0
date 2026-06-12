// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconCalendar,
  IconCircleDot,
  IconFileText,
  IconPlayerPlay,
  IconMessageCircle,
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
  allOrgAutomationEntries$,
  allOrgAutomationsLoaded$,
  saveOrgAutomation$,
  toggleOrgAutomationEnabled$,
  deleteOrgAutomation$,
  runAutomationNow$,
  type OrgAutomationEntry,
  type ZeroAutomationSaveParams,
} from "../../signals/zero-page/zero-automations.ts";
import { slackOrgData$ } from "../../signals/zero-page/zero-slack.ts";
import {
  automationDetailTab$,
  setAutomationDetailTab$,
} from "../../signals/automation-page/automation-detail-tab.ts";
import { LogTable, STATUS_LABELS } from "./components/log-views/log-table.tsx";
import { Pagination } from "../components/pagination.tsx";
import {
  automationRunData$,
  automationRunLimit$,
  automationRunHasPrev$,
  automationRunCurrentPage$,
  goToNextAutomationRunPage$,
  goToPrevAutomationRunPage$,
  goForwardTwoAutomationRunPages$,
  goBackTwoAutomationRunPages$,
  setAutomationRunRowsPerPage$,
  automationRunStatusFilter$,
  setAutomationRunStatusFilter$,
  automationRunAvailableStatuses$,
} from "../../signals/automation-page/automation-run-history.ts";
import { ZeroNoPermissionIllustration } from "./components/zero-no-permission-illustration.tsx";
import { InlineSettingsRow } from "./components/zero-inline-settings-row.tsx";
import {
  buildCombinedAutomations,
  AutomationEditFields,
  type CombinedEntry,
} from "./zero-automations-page.tsx";
import { parseAutomationTimeString } from "./zero-automation-card.tsx";
import { TiptapInstructionsEditor } from "./tiptap-instructions-editor.tsx";
import { ZeroUnsavedBar } from "./zero-unsaved-bar.tsx";
import {
  automationForm$,
  updateAutomationForm$,
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
  type AutomationSettingsSnapshot,
} from "../../signals/automation-page/automation-form.ts";
import {
  automationTitle,
  automationTitleExcerpt,
} from "../../signals/zero-page/automation-title.ts";

const AUTOMATION_DETAIL_TAB_TRIGGER_CLASS =
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

function AutomationBreadcrumbLink({ chatThreadId }: { chatThreadId?: string }) {
  if (chatThreadId) {
    return (
      <Link
        pathname="/chats/:threadId"
        options={{ pathParams: { threadId: chatThreadId } }}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
      >
        <IconMessageCircle size={14} stroke={1.5} className="shrink-0" />
        Chat thread
      </Link>
    );
  }

  return (
    <Link
      pathname="/automations"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground transition-colors no-underline text-inherit"
    >
      <IconCalendar size={14} stroke={1.5} className="shrink-0" />
      Automations
    </Link>
  );
}

function AutomationDetailSkeleton() {
  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <AutomationBreadcrumbLink />
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

function AutomationNotFound() {
  return (
    <div className="h-full flex flex-col min-h-0">
      <nav className="hidden md:flex shrink-0 items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
        <AutomationBreadcrumbLink />
        <span className="text-muted-foreground/40 select-none">/</span>
        <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium">
          Automation
        </span>
      </nav>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 pb-20">
        <ZeroNoPermissionIllustration className="h-32 w-auto max-w-[220px] object-contain opacity-90" />
        <h2 className="text-lg font-semibold text-foreground">
          Automation not found
        </h2>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          This automation doesn&apos;t exist or was removed.
        </p>
        <Link
          pathname="/automations"
          className="zero-btn-morandi mt-2 inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium no-underline text-inherit hover:bg-accent"
        >
          Back to automations
        </Link>
      </div>
    </div>
  );
}

/** Matches Agent + automation dropdown column width on the detail settings layout. */
const AUTOMATION_DETAIL_CONTROL_WIDTH =
  "w-full sm:w-[min(100%,20rem)] sm:ml-auto";

type AutomationAgentOption = {
  id: string;
  displayName?: string | null;
};

// AutomationSettingsSnapshot imported from signals/automation-page/automation-form.ts

function buildSettingsSnapshot(
  entry: CombinedEntry,
  parsed: ReturnType<typeof parseAutomationTimeString>,
): AutomationSettingsSnapshot {
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
  };
}

function isSettingsChanged(
  a: AutomationSettingsSnapshot,
  b: AutomationSettingsSnapshot,
): boolean {
  return (
    a.freq !== b.freq ||
    a.date !== b.date ||
    a.hour !== b.hour ||
    a.minute !== b.minute ||
    a.timezone !== b.timezone ||
    a.loopMinutes !== b.loopMinutes ||
    a.agentId !== b.agentId ||
    a.description !== b.description
  );
}

function AutomationSettingsForm({
  entry,
  agents,
  saving,
  toggling,
  onSave,
  onToggle,
  onDelete,
}: {
  entry: CombinedEntry;
  agents: AutomationAgentOption[];
  saving: boolean;
  toggling: boolean;
  onSave: (
    params: ZeroAutomationSaveParams & { agentId: string },
  ) => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onDelete: () => void;
}) {
  const parsed = parseAutomationTimeString(entry.time);
  const initial = buildSettingsSnapshot(entry, parsed);

  const form = useGet(automationForm$);
  const updateForm = useSet(updateAutomationForm$);
  const savedState = useGet(savedSettingsState$);
  const setSavedState = useSet(setSavedSettingsState$);
  const showDeleteConfirmVal = useGet(showDeleteConfirm$);
  const setShowDeleteConfirmVal = useSet(setShowDeleteConfirm$);

  // Reset form when entry changes (component is keyed by entry.id)
  useSet(syncSettingsFormEntry$)(entry.id, entry.prompt, initial);

  const current: AutomationSettingsSnapshot = {
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
            description="The agent is fixed once an automation is created. Delete and recreate the automation to run it on a different agent."
          >
            <div className={AUTOMATION_DETAIL_CONTROL_WIDTH}>
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
            description="A short summary shown in the automation list. Leave blank to auto-generate."
          >
            <div className={AUTOMATION_DETAIL_CONTROL_WIDTH}>
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
                AUTOMATION_DETAIL_CONTROL_WIDTH,
              )}
            >
              <AutomationEditFields
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
            description="Paused automations do not run until re-enabled."
            alignControls="center"
          >
            <LoadingSwitch
              checked={entry.enabled !== false}
              loading={toggling}
              onCheckedChange={(checked) => {
                detach(onToggle(checked), Reason.DomCallback);
              }}
              ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} this automation`}
            />
          </InlineSettingsRow>
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
                  Deleting removes this automation permanently.
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
                  Delete automation
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
            <DialogTitle>Delete automation?</DialogTitle>
            <DialogDescription>
              This will permanently delete the automation{" "}
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
function AutomationInstructionEditorBlock({
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
        key={`automation-instr-${entry.id}-${entry.prompt}-${nonce}`}
        initialContent={draft ?? entry.prompt}
        onChange={setDraft}
        disabled={saving}
        footerHint="This instruction runs each time this automation executes."
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

function AutomationRunHistoryTab() {
  const pageSignal = useGet(pageSignal$);
  const dataLoadable = useLastLoadable(automationRunData$);
  const hasPrev = useGet(automationRunHasPrev$);
  const currentPage = useGet(automationRunCurrentPage$);
  const rowsPerPage = useGet(automationRunLimit$);
  const goToNext = useSet(goToNextAutomationRunPage$);
  const goToPrev = useSet(goToPrevAutomationRunPage$);
  const goForwardTwo = useSet(goForwardTwoAutomationRunPages$);
  const goBackTwo = useSet(goBackTwoAutomationRunPages$);
  const setRowsPerPage = useSet(setAutomationRunRowsPerPage$);

  const statusFilter = useGet(automationRunStatusFilter$);
  const setStatusFilter = useSet(setAutomationRunStatusFilter$);
  const availableStatusesLoadable = useLastLoadable(
    automationRunAvailableStatuses$,
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
            emptyDescription="When this automation runs, its history will show up here."
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

function AutomationDetailView({
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
  agents: AutomationAgentOption[];
  onSettingsSave: (
    params: ZeroAutomationSaveParams & { agentId: string },
  ) => Promise<void>;
  onToggle: (enabled: boolean) => Promise<void>;
  onRunNow: () => Promise<void>;
  onDelete: () => void;
  onInstructionSavePrompt: (prompt: string) => void;
}) {
  const summaryTitle = automationTitle(entry);
  const breadcrumbLabel = automationTitleExcerpt(entry);
  const nextRunLabel = formatRunAt(entry.nextRunAt);
  const isActive = entry.enabled !== false;

  const activeTab = useGet(automationDetailTab$);
  const setActiveTab = useSet(setAutomationDetailTab$);

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
          <AutomationBreadcrumbLink chatThreadId={entry.chatThreadId} />
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
                  className={AUTOMATION_DETAIL_TAB_TRIGGER_CLASS}
                >
                  <IconSettings size={14} stroke={1.5} />
                  Settings
                </TabsTrigger>
                <TabsTrigger
                  value="instructions"
                  className={AUTOMATION_DETAIL_TAB_TRIGGER_CLASS}
                >
                  <IconFileText size={14} stroke={1.5} />
                  Instructions
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  className={AUTOMATION_DETAIL_TAB_TRIGGER_CLASS}
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
              <AutomationSettingsForm
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
                <AutomationInstructionEditorBlock
                  key={`${entry.id}\u0000${entry.prompt}`}
                  entry={entry}
                  saving={saving}
                  onSavePrompt={onInstructionSavePrompt}
                />
              </div>
            )}

            {activeTab === "history" && <AutomationRunHistoryTab />}
          </div>
        </main>
      </Tabs>
    </div>
  );
}

function AutomationActionsContainer({
  entry,
  dimmed,
  agents,
}: {
  entry: CombinedEntry;
  dimmed: boolean;
  agents: AutomationAgentOption[];
}) {
  const pageSignal = useGet(pageSignal$);
  const [savingLoadable, saveAutomationTracked] =
    useLoadableSet(saveOrgAutomation$);
  const [togglingLoadable, toggleEnabledTracked] = useLoadableSet(
    toggleOrgAutomationEnabled$,
  );
  const [runningLoadable, runAutomationNowTracked] =
    useLoadableSet(runAutomationNow$);
  const deleteAutomation = useSet(deleteOrgAutomation$);
  const navigate = useSet(detachedNavigateTo$);

  const saving = savingLoadable.state === "loading";
  const toggling = togglingLoadable.state === "loading";
  const running = runningLoadable.state === "loading";

  const handleSettingsSave = async (
    params: ZeroAutomationSaveParams & { agentId: string },
  ) => {
    await saveAutomationTracked(params, pageSignal);
  };

  const handleInstructionSavePrompt = (prompt: string) => {
    if (!prompt) {
      return;
    }
    const parsed = parseAutomationTimeString(entry.time);
    detach(
      saveAutomationTracked(
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
    await runAutomationNowTracked(entry.id, pageSignal);
  };

  const handleDelete = () => {
    if (entry.name === undefined) {
      return;
    }
    const name = entry.name;
    detach(
      (async () => {
        await deleteAutomation({ name, agentId: entry.agentId }, pageSignal);
        navigate("/automations");
      })(),
      Reason.DomCallback,
    );
  };

  return (
    <AutomationDetailView
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

export function ZeroAutomationDetailPage() {
  const params = useGet(pathParams$);
  const scheduleId =
    params && typeof params === "object" && "scheduleId" in params
      ? String(params.scheduleId)
      : null;

  const entriesLoadable = useLastLoadable(allOrgAutomationEntries$);
  const entries: OrgAutomationEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  const agentsLoadable = useLastLoadable(agents$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];

  const automationsLoaded = useGet(allOrgAutomationsLoaded$);
  const slackData = useLastLoadable(slackOrgData$);

  const combinedAutomations = buildCombinedAutomations(entries);

  if (!scheduleId) {
    return <AutomationNotFound />;
  }

  if (
    !automationsLoaded ||
    entriesLoadable.state !== "hasData" ||
    slackData.state !== "hasData"
  ) {
    return <AutomationDetailSkeleton />;
  }

  const entry = combinedAutomations.find((e) => {
    return e.id === scheduleId;
  });

  if (!entry) {
    return <AutomationNotFound />;
  }

  const dimmed = entry.enabled === false;

  return (
    <AutomationActionsContainer entry={entry} dimmed={dimmed} agents={agents} />
  );
}
