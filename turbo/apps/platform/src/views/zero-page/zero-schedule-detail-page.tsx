import { useState } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  IconCalendar,
  IconFileText,
  IconPlayerPlay,
  IconSettings,
  IconTrash,
} from "@tabler/icons-react";
import {
  LoadingSwitch,
  compactSwitchClassName,
} from "../components/loading-switch.tsx";
import {
  Button,
  Card,
  CardContent,
  cn,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import { Switch } from "@vm0/ui/components/ui/switch";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { Link } from "../router/link.tsx";
import { navigateInReact$, pathParams$ } from "../../signals/route.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { agentsList$ } from "../../signals/zero-page/agents-list.ts";
import { zeroOnboardingStatus$ } from "../../signals/zero-page/zero-onboarding.ts";
import { detach, Reason, throwIfAbort } from "../../signals/utils.ts";
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

const SCHEDULE_DETAIL_TAB_TRIGGER_CLASS =
  "gap-1.5 text-sm data-[state=active]:bg-background px-3";

function formatRunAt(iso: string | null): string {
  if (!iso) {
    return "—";
  }
  try {
    return new Date(iso).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch (error) {
    throwIfAbort(error);
    return iso;
  }
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
      pathname="/schedule"
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
      <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
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
      <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
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
          pathname="/schedule"
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
  name: string;
  displayName?: string | null;
};

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
  onSave: (params: ZeroScheduleSaveParams & { composeId: string }) => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onDelete: () => void;
}) {
  const parsed = parseScheduleTimeString(entry.time);
  const [freq, setFreq] = useState(parsed.freq);
  const [date, setDate] = useState(parsed.date);
  const [hour, setHour] = useState(parsed.hour);
  const [minute, setMinute] = useState(parsed.minute);
  const [timezone, setTimezone] = useState(parsed.timezone);
  const [loopMinutes, setLoopMinutes] = useState(parsed.loopMinutes);
  const [composeId, setComposeId] = useState(entry.composeId);
  const [notifyEmail, setNotifyEmail] = useState(entry.notifyEmail);
  const [notifySlack, setNotifySlack] = useState(entry.notifySlack);
  const [dayOfWeek] = useState(parsed.dayOfWeek ?? "1");
  const [dayOfMonth] = useState(parsed.dayOfMonth ?? "1");

  const saveWith = (patch: {
    freq?: string;
    date?: string;
    hour?: number;
    minute?: number;
    timezone?: string;
    loopMinutes?: number;
    composeId?: string;
    notifyEmail?: boolean;
    notifySlack?: boolean;
  }) => {
    if (!entry.prompt.trim() || entry.name === undefined) {
      return;
    }
    const nextFreq = patch.freq ?? freq;
    onSave({
      prompt: entry.prompt.trim(),
      freq: nextFreq,
      date: patch.date ?? date,
      hour: patch.hour ?? hour,
      minute: patch.minute ?? minute,
      timezone: patch.timezone ?? timezone,
      intervalSeconds: (patch.loopMinutes ?? loopMinutes) * 60,
      editName: entry.name,
      composeId: patch.composeId ?? composeId,
      notifyEmail: patch.notifyEmail ?? notifyEmail,
      notifySlack: patch.notifySlack ?? notifySlack,
      ...(nextFreq === "every_week" ? { dayOfWeek } : {}),
      ...(nextFreq === "every_month" ? { dayOfMonth } : {}),
    });
  };

  const canDelete = entry.name !== undefined;
  const composeInList = agents.some((a) => a.id === composeId);

  return (
    <>
      <Card className="zero-card overflow-hidden">
        <CardContent className="p-4 sm:p-5">
          <InlineSettingsRow
            label="Agent"
            description="Which agent runs when this schedule fires."
          >
            <div className={SCHEDULE_DETAIL_CONTROL_WIDTH}>
              <Select
                value={composeId}
                onValueChange={(v) => {
                  setComposeId(v);
                  saveWith({ composeId: v });
                }}
                disabled={saving || agents.length === 0}
              >
                <SelectTrigger className="h-9 w-full">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {!composeInList && (
                    <SelectItem value={composeId}>
                      {entry.composeName || entry.agentLabel || composeId}
                    </SelectItem>
                  )}
                  {agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.displayName ?? a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                freq={freq}
                setFreq={(v) => {
                  setFreq(v);
                  saveWith({ freq: v });
                }}
                loopMinutes={loopMinutes}
                setLoopMinutes={(v) => {
                  setLoopMinutes(v);
                  saveWith({ loopMinutes: v });
                }}
                date={date}
                setDate={(v) => {
                  setDate(v);
                  saveWith({ date: v });
                }}
                hour={hour}
                setHour={(v) => {
                  setHour(v);
                  saveWith({ hour: v });
                }}
                minute={minute}
                setMinute={(v) => {
                  setMinute(v);
                  saveWith({ minute: v });
                }}
                timezone={timezone}
                setTimezone={(v) => {
                  setTimezone(v);
                  saveWith({ timezone: v });
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
                onToggle(checked).catch(() => {});
              }}
              ariaLabel={`${entry.enabled !== false ? "Disable" : "Enable"} this schedule`}
            />
          </InlineSettingsRow>

          <InlineSettingsRow
            label="Email notifications"
            description="Notify by email when a run completes."
            alignControls="center"
          >
            <Switch
              className={compactSwitchClassName}
              checked={notifyEmail}
              onCheckedChange={(v) => {
                setNotifyEmail(v);
                saveWith({ notifyEmail: v });
              }}
              disabled={saving}
            />
          </InlineSettingsRow>

          <InlineSettingsRow
            label="Slack notifications"
            description="Send a Slack message when a run completes."
            alignControls="center"
          >
            <Switch
              className={compactSwitchClassName}
              checked={notifySlack}
              onCheckedChange={(v) => {
                setNotifySlack(v);
                saveWith({ notifySlack: v });
              }}
              disabled={saving}
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
                  Deleting removes this schedule permanently.
                </p>
              </div>
              <div className="flex shrink-0 self-end sm:self-auto sm:pt-0.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 rounded-lg border-destructive/40 px-4 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={onDelete}
                >
                  <IconTrash size={14} stroke={1.5} />
                  Delete schedule
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
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
  const [draft, setDraft] = useState<string | null>(null);
  const [discardNonce, setDiscardNonce] = useState(0);
  const isDirty = draft !== null && draft.trim() !== entry.prompt.trim();

  return (
    <>
      <TiptapInstructionsEditor
        key={`schedule-instr-${entry.id}-${entry.prompt}-${discardNonce}`}
        initialContent={draft ?? entry.prompt}
        onChange={setDraft}
        disabled={saving}
        footerHint="This instruction runs each time this schedule executes."
      />
      {isDirty && (
        <ZeroUnsavedBar
          onDiscard={() => {
            setDraft(null);
            setDiscardNonce((n) => n + 1);
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
    params: ZeroScheduleSaveParams & { composeId: string },
  ) => void;
  onToggle: (enabled: boolean) => Promise<void>;
  onRunNow: () => Promise<void>;
  onDelete: () => void;
  onInstructionSavePrompt: (prompt: string) => void;
}) {
  const promptTrim = entry.prompt.trim();
  const summaryTitle = (() => {
    if (promptTrim.length === 0) {
      return "No instruction";
    }
    const first = firstSentenceFromInstruction(promptTrim);
    if (first.length === 0) {
      return "No instruction";
    }
    return excerptText(first, SCHEDULE_DETAIL_TITLE_MAX);
  })();
  const breadcrumbLabel = scheduleDetailBreadcrumbLabel(entry);
  const nextRunLabel = formatRunAt(entry.nextRunAt);
  const isActive = entry.enabled !== false;

  const [activeTab, setActiveTab] = useState<"settings" | "instructions">(
    "settings",
  );

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-auto [scrollbar-gutter:stable]">
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          if (v === "settings" || v === "instructions") {
            setActiveTab(v);
          }
        }}
        className="flex flex-1 flex-col min-h-0"
      >
        <nav className="shrink-0 flex items-center gap-1 px-4 pt-4 text-sm text-muted-foreground">
          <ScheduleBreadcrumbLink />
          <span className="text-muted-foreground/40 select-none">/</span>
          <span className="rounded-md px-1.5 py-0.5 text-foreground font-medium truncate min-w-0">
            {breadcrumbLabel}
          </span>
        </nav>

        <header className="shrink-0 bg-transparent px-4 sm:px-6 pt-6 pb-3">
          <div className="mx-auto max-w-[900px]">
            <div
              className={cn(
                "flex items-stretch gap-4 min-w-0",
                dimmed && "opacity-90",
              )}
            >
              <div
                className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
                aria-hidden
              >
                <IconCalendar
                  size={28}
                  stroke={1.25}
                  className="shrink-0 opacity-90"
                />
              </div>
              <div className="min-w-0 flex-1 h-14 sm:h-16 flex flex-col justify-center gap-3 overflow-hidden">
                <h1 className="min-w-0 text-base sm:text-lg font-semibold tracking-tight text-foreground leading-tight truncate">
                  {summaryTitle}
                </h1>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground leading-tight">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
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
                    className="text-muted-foreground/50 select-none"
                    aria-hidden
                  >
                    |
                  </span>
                  <span className="text-foreground/90">{entry.time}</span>
                  <span
                    className="text-muted-foreground/50 select-none"
                    aria-hidden
                  >
                    |
                  </span>
                  <span>
                    <span className="font-medium text-foreground/90">
                      Next run
                    </span>{" "}
                    <span className="tabular-nums text-foreground/90">
                      {nextRunLabel}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-6 flex h-9 items-center gap-2">
              <TabsList className="zero-tabs h-9 w-full sm:w-auto gap-1 px-1 py-1 overflow-x-auto">
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
              </TabsList>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="zero-btn-morandi ml-auto h-9 shrink-0 gap-2 rounded-lg px-4 border text-sm font-medium transition-colors hover:bg-accent"
                disabled={running || !entry.prompt.trim()}
                onClick={() => {
                  onRunNow().catch(() => {});
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
            "shrink-0 flex-1 px-4 sm:px-6 pt-4 pb-16 transition-opacity",
            dimmed && "opacity-90",
          )}
        >
          <div className="mx-auto max-w-[900px] flex flex-col gap-4">
            {activeTab === "settings" && (
              <ScheduleSettingsForm
                key={`${entry.id}\u0000${entry.time}\u0000${entry.composeId}\u0000${String(entry.notifyEmail)}\u0000${String(entry.notifySlack)}`}
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
          </div>
        </main>
      </Tabs>
    </div>
  );
}

export function ZeroScheduleDetailPage() {
  const params = useGet(pathParams$);
  const scheduleId =
    params && typeof params === "object" && "scheduleId" in params
      ? String(params.scheduleId)
      : null;

  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";

  const statusLoadable = useLoadable(zeroOnboardingStatus$);
  const defaultComposeId =
    statusLoadable.state === "hasData"
      ? statusLoadable.data.defaultAgentComposeId
      : null;

  const entriesLoadable = useLastLoadable(allOrgScheduleEntries$);
  const entries: OrgScheduleEntry[] =
    entriesLoadable.state === "hasData" ? entriesLoadable.data : [];

  const agentsLoadable = useLoadable(agentsList$);
  const agents = agentsLoadable.state === "hasData" ? agentsLoadable.data : [];
  const nameToDisplay = new Map(
    agents.filter((a) => a.displayName).map((a) => [a.name, a.displayName!]),
  );

  const loaded = useGet(allOrgSchedulesLoaded$);
  const saveSchedule = useSet(saveOrgSchedule$);
  const toggleEnabled = useSet(toggleOrgScheduleEnabled$);
  const deleteSchedule = useSet(deleteOrgSchedule$);
  const runScheduleNow = useSet(runScheduleNow$);
  const navigate = useSet(navigateInReact$);

  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [running, setRunning] = useState(false);
  const combinedSchedule = buildCombinedSchedule(
    entries,
    agentName,
    defaultComposeId,
    nameToDisplay,
  );

  if (!scheduleId) {
    return <ScheduleNotFound />;
  }

  if (!loaded || entriesLoadable.state !== "hasData") {
    return <ScheduleDetailSkeleton />;
  }

  const entry = combinedSchedule.find((e) => e.id === scheduleId);

  if (!entry) {
    return <ScheduleNotFound />;
  }

  const dimmed = entry.enabled === false;

  const handleSettingsSave = (
    params: ZeroScheduleSaveParams & { composeId: string },
  ) => {
    setSaving(true);
    detach(
      saveSchedule(params).finally(() => {
        setSaving(false);
      }),
      Reason.DomCallback,
    );
  };

  const handleInstructionSavePrompt = (prompt: string) => {
    if (!prompt) {
      return;
    }
    const parsed = parseScheduleTimeString(entry.time);
    setSaving(true);
    detach(
      saveSchedule({
        prompt,
        freq: parsed.freq,
        date: parsed.date,
        hour: parsed.hour,
        minute: parsed.minute,
        timezone: parsed.timezone,
        intervalSeconds: parsed.loopMinutes * 60,
        editName: entry.name,
        composeId: entry.composeId,
        notifyEmail: entry.notifyEmail,
        notifySlack: entry.notifySlack,
      }).finally(() => {
        setSaving(false);
      }),
      Reason.DomCallback,
    );
  };

  const handleToggle = async (enabled: boolean) => {
    if (entry.name === undefined) {
      return;
    }
    setToggling(true);
    try {
      await toggleEnabled({
        name: entry.name,
        enabled,
        composeId: entry.composeId,
      });
    } finally {
      setToggling(false);
    }
  };

  const handleRunNow = async () => {
    setRunning(true);
    try {
      await runScheduleNow({
        composeId: entry.composeId,
        prompt: entry.prompt,
      });
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = () => {
    if (entry.name === undefined) {
      return;
    }
    detach(
      deleteSchedule({ name: entry.name, composeId: entry.composeId }).then(
        () => {
          navigate("/schedule");
        },
      ),
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
