import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconBrandSlack,
  IconDatabase,
  IconInfoCircle,
  IconLoader2,
  IconMail,
  IconPlayerStop,
  IconRefresh,
} from "@tabler/icons-react";
import type {
  MemorySourceDetailResponse,
  MemorySourceListResponse,
  SlackMemoryBackfillRequest,
  SlackMemoryStatusResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import { Button, cn } from "@vm0/ui";
import { Checkbox } from "@vm0/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@vm0/ui/components/ui/select";

import {
  goBackTwoMemorySourcePages$,
  goForwardTwoMemorySourcePages$,
  goToNextMemorySourcePage$,
  goToPrevMemorySourcePage$,
  memorySourceHasPrev$,
  memorySourceLimit$,
  memorySourcePage$,
  memorySourceProviderFilter$,
  memorySources$,
  reloadMemorySources$,
  reloadSlackMemoryStatus$,
  selectedMemorySourceDetail$,
  selectedMemorySourceId$,
  setMemorySourceProviderFilter$,
  setMemorySourceRowsPerPage$,
  setSelectedMemorySourceId$,
  setSlackMemoryBackfillDialogOpen$,
  slackMemoryBackfillDialogOpen$,
  slackMemoryBackfillRequest$,
  slackMemoryStatus$,
  startSlackMemoryBackfill$,
  stopSlackMemoryBackfill$,
  updateSlackMemoryBackfillRequest$,
  type MemorySourceProviderFilter,
} from "../../signals/memory-page/memory-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Pagination } from "../components/pagination.tsx";

const SOURCE_PROVIDER_FILTERS: readonly {
  readonly value: MemorySourceProviderFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "slack", label: "Slack" },
  { value: "gmail", label: "Gmail" },
];

const SLACK_BACKFILL_DAY_OPTIONS = [
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
] as const;

type MemorySource = MemorySourceListResponse["sources"][number];

const SOURCE_DETAIL_METADATA_ORDER: readonly string[] = [
  "workspaceId",
  "channelId",
  "channelType",
  "threadId",
  "messageId",
  "messageTs",
  "senderId",
  "participantIds",
  "fileIds",
  "mailboxEmail",
  "historyId",
  "direction",
  "from",
  "to",
  "cc",
  "reason",
];

function formatDateTime(value: string | null): string {
  if (!value) {
    return "No timestamp";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function providerLabel(provider: MemorySource["provider"]): string {
  return provider === "slack" ? "Slack" : "Gmail";
}

function sourceTypeLabel(source: MemorySource): string {
  if (source.sourceType === "slack_message") {
    const channelType = source.metadata.channelType;
    if (channelType === "group") {
      return "Private channel message";
    }
    if (channelType === "im") {
      return "Direct message";
    }
    if (channelType === "mpim") {
      return "Group direct message";
    }
    return "Channel message";
  }
  return "Email message";
}

function providerIcon(source: MemorySource) {
  return source.provider === "slack" ? IconBrandSlack : IconMail;
}

function sourceMetadataParts(source: MemorySource): string[] {
  if (source.provider === "slack") {
    return [
      source.metadata.channelId ? `Channel ${source.metadata.channelId}` : null,
      source.metadata.senderId ? `Sender ${source.metadata.senderId}` : null,
      source.metadata.messageTs ? `Ts ${source.metadata.messageTs}` : null,
    ].filter((part): part is string => {
      return part !== null;
    });
  }

  return [
    source.metadata.mailboxEmail ?? null,
    source.metadata.direction ? `Direction ${source.metadata.direction}` : null,
  ].filter((part): part is string => {
    return part !== null;
  });
}

function sourceCountLabel(
  pagination: MemorySourceListResponse["pagination"],
  visibleCount: number,
): string {
  if (pagination.total === 0) {
    return "0";
  }
  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(start + visibleCount - 1, pagination.total);
  return `${start}-${end} of ${pagination.total}`;
}

function detailMetadataLabel(key: string): string {
  if (key === "workspaceId") {
    return "Workspace ID";
  }
  if (key === "channelId") {
    return "Channel ID";
  }
  if (key === "channelType") {
    return "Channel type";
  }
  if (key === "threadId") {
    return "Thread ID";
  }
  if (key === "messageId") {
    return "Message ID";
  }
  if (key === "messageTs") {
    return "Message timestamp";
  }
  if (key === "senderId") {
    return "Sender ID";
  }
  if (key === "participantIds") {
    return "Participants";
  }
  if (key === "fileIds") {
    return "Files";
  }
  if (key === "mailboxEmail") {
    return "Mailbox";
  }
  if (key === "historyId") {
    return "History ID";
  }
  if (key === "direction") {
    return "Direction";
  }
  if (key === "from") {
    return "From";
  }
  if (key === "to") {
    return "To";
  }
  if (key === "cc") {
    return "Cc";
  }
  if (key === "reason") {
    return "Reason";
  }
  return key;
}

function detailMetadataEntries(
  metadata: MemorySourceDetailResponse["metadata"],
): [string, unknown][] {
  return Object.entries(metadata).sort(([left], [right]) => {
    const leftIndex = SOURCE_DETAIL_METADATA_ORDER.indexOf(left);
    const rightIndex = SOURCE_DETAIL_METADATA_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) {
      return left.localeCompare(right);
    }
    if (leftIndex === -1) {
      return 1;
    }
    if (rightIndex === -1) {
      return -1;
    }
    return leftIndex - rightIndex;
  });
}

function detailValueText(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "None";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function SourceDetailField({
  label,
  mono = false,
  value,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly value: unknown;
}) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-2 last:border-b-0 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 break-words text-sm text-foreground",
          mono ? "font-mono text-xs leading-5" : null,
        )}
      >
        {detailValueText(value)}
      </dd>
    </div>
  );
}

function SourceDetailDialog() {
  const selectedSourceId = useGet(selectedMemorySourceId$);
  const setSelectedSourceId = useSet(setSelectedMemorySourceId$);
  const detailLoadable = useLoadable(selectedMemorySourceDetail$);
  const open = selectedSourceId !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setSelectedSourceId(null);
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Source details</DialogTitle>
          <DialogDescription>
            Review the identifiers and metadata recorded for this source.
          </DialogDescription>
        </DialogHeader>
        {detailLoadable.state === "loading" ? (
          <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
            <IconLoader2 className="h-4 w-4 animate-spin" />
            <span>Loading source details</span>
          </div>
        ) : detailLoadable.state === "hasError" ? (
          <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Source details are unavailable.
          </div>
        ) : detailLoadable.data ? (
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <dl className="rounded-lg border border-border/70 px-3">
              <SourceDetailField
                label="Title"
                value={detailLoadable.data.title}
              />
              <SourceDetailField
                label="Provider"
                value={providerLabel(detailLoadable.data.provider)}
              />
              <SourceDetailField
                label="Source type"
                value={sourceTypeLabel(detailLoadable.data)}
              />
              <SourceDetailField
                label="Occurred"
                value={formatDateTime(detailLoadable.data.occurredAt)}
              />
              <SourceDetailField
                label="Created"
                value={formatDateTime(detailLoadable.data.createdAt)}
              />
              <SourceDetailField
                label="Updated"
                value={formatDateTime(detailLoadable.data.updatedAt)}
              />
              <SourceDetailField
                label="External ID"
                mono
                value={detailLoadable.data.externalId}
              />
              <SourceDetailField
                label="Connector ID"
                mono
                value={detailLoadable.data.connectorId}
              />
              <SourceDetailField
                label="Content hash"
                mono
                value={detailLoadable.data.contentHash}
              />
            </dl>
            <div className="mt-4">
              <p className="text-sm font-medium text-foreground">Metadata</p>
              <dl className="mt-2 rounded-lg border border-border/70 px-3">
                {detailMetadataEntries(detailLoadable.data.metadata).map(
                  ([key, value]) => {
                    return (
                      <SourceDetailField
                        key={key}
                        label={detailMetadataLabel(key)}
                        mono={Array.isArray(value) || key.endsWith("Id")}
                        value={value}
                      />
                    );
                  },
                )}
              </dl>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function backfillProgressText(
  backfill: SlackMemoryStatusResponse["backfill"],
): string {
  if (backfill.status === "failed") {
    return "Backfill failed";
  }
  if (backfill.status === "stopped") {
    return `Backfill stopped - ${backfill.scannedCount} scanned`;
  }
  if (backfill.status === "done") {
    return `Backfill complete - ${backfill.recordedCount} recorded`;
  }
  if (backfill.status === "idle") {
    return "Backfill not started";
  }
  return `Backfilling Slack - ${backfill.scannedCount} scanned, ${backfill.recordedCount} recorded`;
}

function slackStatusText(status: SlackMemoryStatusResponse): string {
  if (!status.workspaceConnected) {
    return "Install Slack to backfill visible workspace messages.";
  }
  if (!status.userConnected) {
    return "Connect your Slack account to backfill your messages.";
  }
  return backfillProgressText(status.backfill);
}

function canStartSlackBackfill(status: SlackMemoryStatusResponse): boolean {
  return (
    status.workspaceConnected &&
    status.userConnected &&
    (status.backfill.status === "idle" ||
      status.backfill.status === "stopped" ||
      status.backfill.status === "failed" ||
      status.backfill.status === "done")
  );
}

function canStopSlackBackfill(status: SlackMemoryStatusResponse): boolean {
  return (
    status.backfill.status === "pending" || status.backfill.status === "running"
  );
}

function SlackBackfillOptionsFields() {
  const options = useGet(slackMemoryBackfillRequest$);
  const updateOptions = useSet(updateSlackMemoryBackfillRequest$);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <label
          htmlFor="slack-memory-backfill-days"
          className="text-sm font-medium text-foreground"
        >
          Message range
        </label>
        <Select
          value={String(options.days)}
          onValueChange={(value) => {
            updateOptions({
              days: Number(value) as SlackMemoryBackfillRequest["days"],
            });
          }}
        >
          <SelectTrigger id="slack-memory-backfill-days" className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SLACK_BACKFILL_DAY_OPTIONS.map((option) => {
              return (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-3 text-sm text-foreground">
        <Checkbox
          checked={options.includePublicChannels}
          onCheckedChange={(checked) => {
            updateOptions({ includePublicChannels: checked === true });
          }}
        />
        <span>Include public channels</span>
      </label>
      <label className="flex items-center gap-3 text-sm text-foreground">
        <Checkbox
          checked={options.includePrivateChannels}
          onCheckedChange={(checked) => {
            updateOptions({ includePrivateChannels: checked === true });
          }}
        />
        <span>Include private channels</span>
      </label>
      <label className="flex items-center gap-3 text-sm text-foreground">
        <Checkbox
          checked={options.includeDirectMessages}
          onCheckedChange={(checked) => {
            updateOptions({ includeDirectMessages: checked === true });
          }}
        />
        <span>Include direct messages</span>
      </label>
    </div>
  );
}

function SlackBackfillDialog({
  loading,
  onOpenChange,
  onSubmit,
  open,
}: {
  readonly loading: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (options: SlackMemoryBackfillRequest) => void;
  readonly open: boolean;
}) {
  const options = useGet(slackMemoryBackfillRequest$);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!loading) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(options);
          }}
        >
          <DialogHeader>
            <DialogTitle>Backfill Slack memory</DialogTitle>
            <DialogDescription>
              Choose which visible Slack conversations to scan.
            </DialogDescription>
          </DialogHeader>
          <SlackBackfillOptionsFields />
          <DialogFooter className="gap-2 sm:gap-2 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading} className="gap-2">
              {loading ? (
                <IconLoader2 className="h-4 w-4 animate-spin" />
              ) : (
                <IconBrandSlack className="h-4 w-4" />
              )}
              <span>{loading ? "Starting" : "Start backfill"}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SlackBackfillStatusPanel() {
  const statusLoadable = useLoadable(slackMemoryStatus$);

  if (statusLoadable.state === "loading") {
    return (
      <div className="flex min-h-14 items-center gap-3 border-b border-border/70 bg-muted/20 px-3 py-3">
        <IconLoader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Checking Slack memory
        </span>
      </div>
    );
  }

  if (statusLoadable.state === "hasError") {
    return (
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Slack memory unavailable
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Source memory is still available below.
          </p>
        </div>
      </div>
    );
  }

  const status = statusLoadable.data;
  const backfillFailed = status.backfill.status === "failed";

  return (
    <div className="flex min-h-16 flex-col gap-3 border-b border-border/70 bg-muted/20 px-3 py-3 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
            status.workspaceConnected && status.userConnected
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-border bg-background text-muted-foreground",
          )}
          aria-hidden="true"
        >
          <IconBrandSlack className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Slack memory</p>
          <p
            className={cn(
              "mt-0.5 text-sm leading-5 text-muted-foreground",
              backfillFailed ? "text-destructive" : null,
            )}
          >
            {slackStatusText(status)}
          </p>
          {backfillFailed && status.backfill.lastError ? (
            <p className="mt-1 text-xs leading-4 text-destructive">
              {status.backfill.lastError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <SlackBackfillActions status={status} />
      </div>
    </div>
  );
}

function SlackBackfillActions({
  status,
}: {
  readonly status: SlackMemoryStatusResponse;
}) {
  const [backfillLoadable, startBackfill] = useLoadableSet(
    startSlackMemoryBackfill$,
  );
  const [stopLoadable, stopBackfill] = useLoadableSet(stopSlackMemoryBackfill$);
  const reloadStatus = useSet(reloadSlackMemoryStatus$);
  const setBackfillDialogOpen = useSet(setSlackMemoryBackfillDialogOpen$);
  const backfillDialogOpen = useGet(slackMemoryBackfillDialogOpen$);
  const pageSignal = useGet(pageSignal$);
  const starting = backfillLoadable.state === "loading";
  const stopping = stopLoadable.state === "loading";

  return (
    <>
      {!status.workspaceConnected || !status.userConnected ? (
        <Button asChild variant="outline" size="sm" className="h-8 text-xs">
          <a href="/settings/slack">Open Slack settings</a>
        </Button>
      ) : null}
      {canStartSlackBackfill(status) ? (
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={starting}
          onClick={() => {
            setBackfillDialogOpen(true);
          }}
        >
          {starting ? (
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconBrandSlack className="h-3.5 w-3.5" />
          )}
          <span>{starting ? "Starting" : "Backfill Slack"}</span>
        </Button>
      ) : null}
      {canStopSlackBackfill(status) ? (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={stopping}
          onClick={() => {
            detach(stopBackfill(pageSignal), Reason.DomCallback);
          }}
        >
          {stopping ? (
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconPlayerStop className="h-3.5 w-3.5" />
          )}
          <span>{stopping ? "Stopping" : "Stop job"}</span>
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 gap-1.5 px-2.5 text-xs"
        onClick={() => {
          reloadStatus();
        }}
      >
        <IconRefresh className="h-3.5 w-3.5" />
        <span>Refresh</span>
      </Button>
      <SlackBackfillDialog
        loading={starting}
        open={backfillDialogOpen}
        onOpenChange={setBackfillDialogOpen}
        onSubmit={(options) => {
          detach(
            (async () => {
              await startBackfill(options, pageSignal);
              setBackfillDialogOpen(false);
            })(),
            Reason.DomCallback,
          );
        }}
      />
    </>
  );
}

function SourcesToolbar({
  countLabel,
  filter,
  setFilter,
}: {
  readonly countLabel: string;
  readonly filter: MemorySourceProviderFilter;
  readonly setFilter: (value: MemorySourceProviderFilter) => void;
}) {
  const reloadSources = useSet(reloadMemorySources$);

  return (
    <div className="border-b border-border/70 p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {countLabel} sources
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Structured source records from connected providers.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {SOURCE_PROVIDER_FILTERS.map((option) => {
              const selected = option.value === filter;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "h-8 rounded-md px-2.5 text-xs font-medium transition-colors",
                    selected
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                  onClick={() => {
                    setFilter(option.value);
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            onClick={() => {
              reloadSources();
            }}
          >
            <IconRefresh className="h-3.5 w-3.5" />
            <span>Refresh</span>
          </Button>
        </div>
      </div>
    </div>
  );
}

function SourceRow({ source }: { readonly source: MemorySource }) {
  const Icon = providerIcon(source);
  const metadataParts = sourceMetadataParts(source);
  const setSelectedSourceId = useSet(setSelectedMemorySourceId$);

  return (
    <article className="flex min-w-0 gap-3 border-b border-border/70 px-4 py-3 last:border-b-0">
      <span
        className={cn(
          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
          source.provider === "slack"
            ? "border-purple-500/20 bg-purple-500/10 text-purple-700 dark:text-purple-300"
            : "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
        )}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="truncate text-sm font-medium text-foreground">
            {source.title ?? providerLabel(source.provider)}
          </h3>
          <span className="inline-flex h-5 items-center rounded-full border border-border bg-background px-2 text-[11px] font-medium text-muted-foreground">
            {providerLabel(source.provider)}
          </span>
        </div>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {sourceTypeLabel(source)} - {formatDateTime(source.occurredAt)}
        </p>
        {metadataParts.length > 0 ? (
          <p className="mt-1 truncate text-xs leading-4 text-muted-foreground">
            {metadataParts.join(" - ")}
          </p>
        ) : null}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
        onClick={() => {
          setSelectedSourceId(source.id);
        }}
      >
        <IconInfoCircle className="h-3.5 w-3.5" />
        <span>Details</span>
      </Button>
    </article>
  );
}

function MemorySourcesSkeleton() {
  return (
    <section className="zero-card flex min-h-[420px] min-w-0 items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">Loading sources</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulling structured memory sources for this organization.
        </p>
      </div>
    </section>
  );
}

function MemorySourcesError() {
  return (
    <section className="zero-card flex min-h-[420px] min-w-0 items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Sources unavailable
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Try again once relationship memory is enabled.
        </p>
      </div>
    </section>
  );
}

export function MemorySources() {
  const sourcesLoadable = useLoadable(memorySources$);
  const filter = useGet(memorySourceProviderFilter$);
  const setFilter = useSet(setMemorySourceProviderFilter$);
  const page = useGet(memorySourcePage$);
  const limit = useGet(memorySourceLimit$);
  const hasPrev = useGet(memorySourceHasPrev$);
  const goToNextPage = useSet(goToNextMemorySourcePage$);
  const goToPrevPage = useSet(goToPrevMemorySourcePage$);
  const goForwardTwoPages = useSet(goForwardTwoMemorySourcePages$);
  const goBackTwoPages = useSet(goBackTwoMemorySourcePages$);
  const setRowsPerPage = useSet(setMemorySourceRowsPerPage$);

  if (sourcesLoadable.state === "loading") {
    return <MemorySourcesSkeleton />;
  }

  if (sourcesLoadable.state === "hasError") {
    return <MemorySourcesError />;
  }

  const data = sourcesLoadable.data;

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <SlackBackfillStatusPanel />
      <SourcesToolbar
        countLabel={sourceCountLabel(data.pagination, data.sources.length)}
        filter={filter}
        setFilter={setFilter}
      />
      {data.sources.length > 0 ? (
        <div className="divide-y-0">
          {data.sources.map((source) => {
            return <SourceRow key={source.id} source={source} />;
          })}
        </div>
      ) : (
        <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted/30 text-muted-foreground">
            <IconDatabase className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm font-medium text-foreground">
            No sources found
          </p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Backfill Slack or wait for provider events to create source records.
          </p>
        </div>
      )}
      <div className="border-t border-border/70 p-3">
        <Pagination
          currentPage={page}
          totalPages={data.pagination.totalPages}
          rowsPerPage={limit}
          hasNext={data.pagination.hasMore}
          hasPrev={hasPrev}
          onNextPage={() => {
            goToNextPage(data.pagination.totalPages);
          }}
          onPrevPage={() => {
            goToPrevPage();
          }}
          onForwardTwoPages={() => {
            goForwardTwoPages(data.pagination.totalPages);
          }}
          onBackTwoPages={() => {
            goBackTwoPages();
          }}
          onRowsPerPageChange={setRowsPerPage}
        />
      </div>
      <SourceDetailDialog />
    </section>
  );
}
