import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconBuilding,
  IconClock,
  IconLoader2,
  IconMail,
  IconPlayerStop,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconUser,
} from "@tabler/icons-react";
import type {
  GmailRelationshipBackfillRequest,
  GmailRelationshipStatusResponse,
  RelationshipRecord,
  RelationshipSearchResponse,
} from "@vm0/api-contracts/contracts/zero-relationships";
import { Button, cn, Input } from "@vm0/ui";
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
  deleteStoppedGmailRelationshipBackfill$,
  gmailRelationshipBackfillDialogOpen$,
  gmailRelationshipBackfillRequest$,
  gmailRelationshipStatus$,
  goBackTwoMemoryRelationshipPages$,
  goForwardTwoMemoryRelationshipPages$,
  goToNextMemoryRelationshipPage$,
  goToPrevMemoryRelationshipPage$,
  memoryRelationshipHasPrev$,
  memoryRelationshipFilter$,
  memoryRelationshipLimit$,
  memoryRelationshipPage$,
  memoryRelationshipSearch$,
  memoryRelationships$,
  reloadGmailRelationshipStatus$,
  selectedMemoryRelationshipId$,
  setGmailRelationshipBackfillDialogOpen$,
  setMemoryRelationshipFilter$,
  setMemoryRelationshipSearch$,
  setMemoryRelationshipRowsPerPage$,
  setSelectedMemoryRelationshipId$,
  startGmailRelationshipBackfill$,
  stopGmailRelationshipBackfill$,
  updateGmailRelationshipBackfillRequest$,
  type MemoryRelationshipFilter,
} from "../../signals/memory-page/memory-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Pagination } from "../components/pagination.tsx";

type RelationshipItemKind = RelationshipRecord["items"][number]["kind"];

const RELATIONSHIP_FILTERS: readonly {
  readonly value: MemoryRelationshipFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "people", label: "People" },
  { value: "organizations", label: "Organizations" },
  { value: "open-loops", label: "Open loops" },
];

const GMAIL_BACKFILL_DAY_OPTIONS = [
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 180, label: "Last 180 days" },
  { value: 365, label: "Last 365 days" },
] as const;

function formatShortDate(value: string | null): string {
  if (!value) {
    return "No touch";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function relationshipSubtitle(relationship: RelationshipRecord): string {
  const primary =
    relationship.entity.primaryEmail ?? relationship.entity.domain ?? null;
  return [
    primary,
    relationship.lastInteractionAt
      ? formatShortDate(relationship.lastInteractionAt)
      : null,
  ]
    .filter(Boolean)
    .join(" - ");
}

function providerLabel(
  provider: RelationshipRecord["items"][number]["sources"][number]["provider"],
): string {
  switch (provider) {
    case "gmail": {
      return "Gmail";
    }
    case "slack": {
      return "Slack";
    }
    case "github": {
      return "GitHub";
    }
    case "notion": {
      return "Notion";
    }
  }
}

function relationshipSourceLabels(
  relationship: RelationshipRecord,
): readonly string[] {
  const providers = new Set(
    relationship.items.flatMap((item) => {
      return item.sources.map((source) => {
        return source.provider;
      });
    }),
  );
  return [...providers].map((provider) => {
    return providerLabel(provider);
  });
}

function relationshipItems(
  relationship: RelationshipRecord,
  kind: RelationshipItemKind,
) {
  return relationship.items.filter((item) => {
    return item.kind === kind;
  });
}

function relationshipItemCount(relationship: RelationshipRecord): number {
  return relationship.items.length;
}

function relationshipCountLabel(
  pagination: RelationshipSearchResponse["pagination"],
  visibleCount: number,
): string {
  if (pagination.total === 0) {
    return "0";
  }
  if (visibleCount === 0) {
    return `0 of ${pagination.total}`;
  }

  const start = (pagination.page - 1) * pagination.pageSize + 1;
  const end = Math.min(start + visibleCount - 1, pagination.total);
  if (start === 1 && end === pagination.total) {
    return String(pagination.total);
  }
  return `${start}-${end} of ${pagination.total}`;
}

function RelationshipAvatar({
  relationship,
}: {
  readonly relationship: RelationshipRecord;
}) {
  const Icon =
    relationship.entity.type === "organization" ? IconBuilding : IconUser;
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        relationship.entity.type === "organization"
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "bg-primary/10 text-primary",
      )}
      aria-hidden="true"
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function RelationshipStatusBadge({
  relationship,
}: {
  readonly relationship: RelationshipRecord;
}) {
  if (relationship.status === null) {
    return null;
  }
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium",
        relationship.status === "active"
          ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {relationship.status === "active" ? "Active" : "Quiet"}
    </span>
  );
}

function SourceBadge({ label }: { readonly label: string }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-border bg-background px-2 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function sourceText(item: RelationshipRecord["items"][number]): string {
  const source = item.sources[0];
  if (!source) {
    return "No source attached";
  }
  const date = formatShortDate(source.occurredAt);
  const quote = source.quote ? ` - ${source.quote}` : "";
  return `${providerLabel(source.provider)} - ${date}${quote}`;
}

function RelationshipSection({
  title,
  items,
  emptyText,
}: {
  readonly title: string;
  readonly items: readonly RelationshipRecord["items"][number][];
  readonly emptyText: string;
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-background p-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {items.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {items.map((item) => {
            return (
              <div key={item.id} className="border-l-2 border-border pl-3">
                <p className="text-sm leading-5 text-foreground">{item.text}</p>
                <p className="mt-1 text-xs leading-4 text-muted-foreground">
                  {sourceText(item)}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          {emptyText}
        </p>
      )}
    </section>
  );
}

function RelationshipInteractions({
  interactions,
}: {
  readonly interactions: RelationshipRecord["recentInteractions"];
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-background p-3">
      <h3 className="text-sm font-semibold text-foreground">
        Recent interactions
      </h3>
      {interactions.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {interactions.map((interaction) => {
            return (
              <div
                key={interaction.id}
                className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3"
              >
                <span className="text-xs leading-5 text-muted-foreground">
                  {formatShortDate(interaction.occurredAt)}
                </span>
                <p className="min-w-0 text-sm leading-5 text-foreground">
                  {interaction.snippet}
                </p>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-2 text-sm leading-5 text-muted-foreground">
          No interactions yet
        </p>
      )}
    </section>
  );
}

function RelationshipDetail({
  relationship,
}: {
  readonly relationship: RelationshipRecord | null;
}) {
  if (relationship === null) {
    return (
      <section className="flex min-h-[360px] min-w-0 flex-col items-center justify-center px-6 text-center">
        <p className="text-sm font-medium text-foreground">
          No relationships found
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Try another name, company, email, or open loop.
        </p>
      </section>
    );
  }

  const keyFacts = relationshipItems(relationship, "key_fact");
  const preferences = relationshipItems(relationship, "preference");
  const openLoops = relationshipItems(relationship, "open_loop");
  const sourceLabels = relationshipSourceLabels(relationship);
  const detailSubtitle = [
    relationship.relationshipType,
    relationship.lastInteractionAt
      ? `last touch ${formatShortDate(relationship.lastInteractionAt)}`
      : null,
  ]
    .filter(Boolean)
    .join(" - ");

  return (
    <section className="min-w-0 bg-background">
      <header className="flex min-w-0 flex-col gap-4 border-b border-border/70 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <RelationshipAvatar relationship={relationship} />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold leading-6 text-foreground">
                {relationship.entity.displayName}
              </h2>
              {detailSubtitle ? (
                <p className="mt-0.5 truncate text-sm text-muted-foreground">
                  {detailSubtitle}
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <RelationshipStatusBadge relationship={relationship} />
            {sourceLabels.map((label) => {
              return <SourceBadge key={label} label={label} />;
            })}
            <SourceBadge label="This org only" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            disabled
          >
            <IconMail className="h-3.5 w-3.5" />
            <span>View sources</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-xs"
            disabled
          >
            <IconTrash className="h-3.5 w-3.5" />
            <span>Forget</span>
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-4">
        {relationship.summary ? (
          <section className="rounded-lg border border-border/70 bg-muted/20 p-3">
            <h3 className="text-sm font-semibold text-foreground">Summary</h3>
            <p className="mt-2 text-sm leading-6 text-foreground">
              {relationship.summary}
            </p>
          </section>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">
          <RelationshipSection
            title="Key facts"
            items={keyFacts}
            emptyText="No key facts yet"
          />
          <RelationshipSection
            title="Open loops"
            items={openLoops}
            emptyText="No open loops"
          />
        </div>
        <RelationshipSection
          title="Preferences"
          items={preferences}
          emptyText="No preferences yet"
        />
        <RelationshipInteractions
          interactions={relationship.recentInteractions}
        />
      </div>
    </section>
  );
}

function MemoryRelationshipsSkeleton() {
  return (
    <section className="zero-card flex min-h-[420px] min-w-0 items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Loading relationships
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Pulling relationship memory for this organization.
        </p>
      </div>
    </section>
  );
}

function MemoryRelationshipsError() {
  return (
    <section className="zero-card flex min-h-[420px] min-w-0 items-center justify-center px-6 text-center">
      <div>
        <p className="text-sm font-medium text-foreground">
          Relationships unavailable
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Try again once relationship memory is enabled.
        </p>
      </div>
    </section>
  );
}

function backfillProgressText(
  backfill: GmailRelationshipStatusResponse["backfill"],
): string {
  if (backfill.status === "failed") {
    return "Backfill failed";
  }
  if (backfill.status === "stopped") {
    return `Backfill stopped - ${backfill.scannedCount} scanned`;
  }
  if (backfill.status === "done") {
    return `Backfill complete - ${backfill.scannedCount} scanned`;
  }
  if (backfill.status === "idle") {
    return "Backfill not started";
  }
  const scanned = backfill.scannedCount;
  if (backfill.estimatedTotal !== null && backfill.estimatedTotal > 0) {
    return `Backfilling Gmail - ${scanned} / ~${backfill.estimatedTotal} scanned`;
  }
  return `Backfilling Gmail - ${scanned} scanned`;
}

function gmailRelationshipStatusText(
  status: GmailRelationshipStatusResponse,
): string {
  if (!status.connectorConnected) {
    return "Connect Gmail to start relationship memory.";
  }
  if (!status.enabled) {
    return "Enable Gmail watch and historical backfill.";
  }
  const watchText = status.watchEnabled ? "Watch active" : "Watch pending";
  const syncText =
    status.backfill.pendingSyncJobs > 0
      ? ` - ${status.backfill.pendingSyncJobs} sync jobs pending`
      : "";
  return `${watchText} - ${backfillProgressText(status.backfill)}${syncText}`;
}

function gmailRelationshipEnableLabel(
  status: GmailRelationshipStatusResponse,
  starting: boolean,
): string {
  if (starting) {
    return "Starting";
  }
  if (!status.enabled) {
    return "Enable Gmail";
  }
  if (status.backfill.status === "failed") {
    return "Retry backfill";
  }
  if (status.backfill.status === "done") {
    return "Backfill again";
  }
  return "Start backfill";
}

function canStartGmailBackfill(
  status: GmailRelationshipStatusResponse,
): boolean {
  return (
    !status.enabled ||
    status.backfill.status === "idle" ||
    status.backfill.status === "failed" ||
    status.backfill.status === "done"
  );
}

function canStopGmailBackfill(status: GmailRelationshipStatusResponse) {
  return (
    status.enabled &&
    (status.backfill.status === "pending" ||
      status.backfill.status === "running")
  );
}

function GmailBackfillOptionsFields() {
  const options = useGet(gmailRelationshipBackfillRequest$);
  const updateOptions = useSet(updateGmailRelationshipBackfillRequest$);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <label
          htmlFor="gmail-relationship-backfill-days"
          className="text-sm font-medium text-foreground"
        >
          Mail range
        </label>
        <Select
          value={String(options.days)}
          onValueChange={(value) => {
            updateOptions({
              days: Number(value) as GmailRelationshipBackfillRequest["days"],
            });
          }}
        >
          <SelectTrigger id="gmail-relationship-backfill-days" className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GMAIL_BACKFILL_DAY_OPTIONS.map((option) => {
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
          checked={options.includeArchived}
          onCheckedChange={(checked) => {
            updateOptions({ includeArchived: checked === true });
          }}
        />
        <span>Include archived mail</span>
      </label>
      <label className="flex items-center gap-3 text-sm text-foreground">
        <Checkbox
          checked={options.includeSent}
          onCheckedChange={(checked) => {
            updateOptions({ includeSent: checked === true });
          }}
        />
        <span>Include sent mail</span>
      </label>
    </div>
  );
}

function GmailRelationshipBackfillDialog({
  actionLabel,
  loading,
  onOpenChange,
  onSubmit,
  open,
}: {
  readonly actionLabel: string;
  readonly loading: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (options: GmailRelationshipBackfillRequest) => void;
  readonly open: boolean;
}) {
  const options = useGet(gmailRelationshipBackfillRequest$);

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
            <DialogTitle>Backfill Gmail relationships</DialogTitle>
            <DialogDescription>
              Choose the Gmail range for this backfill run.
            </DialogDescription>
          </DialogHeader>
          <GmailBackfillOptionsFields />
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
                <IconMail className="h-4 w-4" />
              )}
              <span>{actionLabel}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GmailRelationshipStatusActions({
  actionLabel,
  deletingStopped,
  onDeleteStoppedBackfill,
  onOpenBackfillDialog,
  onRefreshStatus,
  onStopBackfill,
  starting,
  status,
  stopping,
}: {
  readonly actionLabel: string;
  readonly deletingStopped: boolean;
  readonly onDeleteStoppedBackfill: () => void;
  readonly onOpenBackfillDialog: () => void;
  readonly onRefreshStatus: () => void;
  readonly onStopBackfill: () => void;
  readonly starting: boolean;
  readonly status: GmailRelationshipStatusResponse;
  readonly stopping: boolean;
}) {
  if (!status.connectorConnected) {
    return (
      <Button asChild variant="outline" size="sm" className="h-8 text-xs">
        <a href="/connectors">Connect Gmail</a>
      </Button>
    );
  }

  return (
    <>
      {canStartGmailBackfill(status) ? (
        <Button
          type="button"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={starting}
          onClick={onOpenBackfillDialog}
        >
          {starting ? (
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconMail className="h-3.5 w-3.5" />
          )}
          <span>{actionLabel}</span>
        </Button>
      ) : null}
      {canStopGmailBackfill(status) ? (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={stopping}
          onClick={onStopBackfill}
        >
          {stopping ? (
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconPlayerStop className="h-3.5 w-3.5" />
          )}
          <span>{stopping ? "Stopping" : "Stop job"}</span>
        </Button>
      ) : null}
      {status.backfill.status === "stopped" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-destructive/40 px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={deletingStopped}
          onClick={onDeleteStoppedBackfill}
        >
          {deletingStopped ? (
            <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <IconTrash className="h-3.5 w-3.5" />
          )}
          <span>{deletingStopped ? "Deleting" : "Delete stopped job"}</span>
        </Button>
      ) : null}
      {status.enabled ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          onClick={onRefreshStatus}
        >
          <IconRefresh className="h-3.5 w-3.5" />
          <span>Refresh</span>
        </Button>
      ) : null}
    </>
  );
}

function GmailRelationshipStatusPanel() {
  const statusLoadable = useLoadable(gmailRelationshipStatus$);
  const [backfillLoadable, startBackfill] = useLoadableSet(
    startGmailRelationshipBackfill$,
  );
  const [stopBackfillLoadable, stopBackfill] = useLoadableSet(
    stopGmailRelationshipBackfill$,
  );
  const [deleteStoppedBackfillLoadable, deleteStoppedBackfill] = useLoadableSet(
    deleteStoppedGmailRelationshipBackfill$,
  );
  const reloadStatus = useSet(reloadGmailRelationshipStatus$);
  const pageSignal = useGet(pageSignal$);
  const backfillDialogOpen = useGet(gmailRelationshipBackfillDialogOpen$);
  const setBackfillDialogOpen = useSet(setGmailRelationshipBackfillDialogOpen$);
  const starting = backfillLoadable.state === "loading";
  const stopping = stopBackfillLoadable.state === "loading";
  const deletingStopped = deleteStoppedBackfillLoadable.state === "loading";

  if (statusLoadable.state === "loading") {
    return (
      <div className="flex min-h-14 items-center gap-3 border-b border-border/70 bg-muted/20 px-3 py-3">
        <IconLoader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Checking Gmail relationships
        </span>
      </div>
    );
  }

  if (statusLoadable.state === "hasError") {
    return (
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-3 py-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Gmail relationships unavailable
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Relationship memory is still available below.
          </p>
        </div>
      </div>
    );
  }

  const status = statusLoadable.data;
  const backfillFailed = status.backfill.status === "failed";
  const backfillActionLabel = gmailRelationshipEnableLabel(status, starting);

  return (
    <div className="flex min-h-16 flex-col gap-3 border-b border-border/70 bg-muted/20 px-3 py-3 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
            status.enabled
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-border bg-background text-muted-foreground",
          )}
          aria-hidden="true"
        >
          <IconMail className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Gmail relationships
          </p>
          <p
            className={cn(
              "mt-0.5 text-sm leading-5 text-muted-foreground",
              backfillFailed ? "text-destructive" : null,
            )}
          >
            {gmailRelationshipStatusText(status)}
          </p>
          {backfillFailed && status.backfill.lastError ? (
            <p className="mt-1 text-xs leading-4 text-destructive">
              {status.backfill.lastError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <GmailRelationshipStatusActions
          actionLabel={backfillActionLabel}
          deletingStopped={deletingStopped}
          starting={starting}
          status={status}
          stopping={stopping}
          onDeleteStoppedBackfill={() => {
            detach(deleteStoppedBackfill(pageSignal), Reason.DomCallback);
          }}
          onOpenBackfillDialog={() => {
            setBackfillDialogOpen(true);
          }}
          onRefreshStatus={() => {
            reloadStatus();
          }}
          onStopBackfill={() => {
            detach(stopBackfill(pageSignal), Reason.DomCallback);
          }}
        />
        <GmailRelationshipBackfillDialog
          actionLabel={backfillActionLabel}
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
      </div>
    </div>
  );
}

function RelationshipsToolbar({
  search,
  filter,
  setSearch,
  setFilter,
}: {
  readonly search: string;
  readonly filter: MemoryRelationshipFilter;
  readonly setSearch: (value: string) => void;
  readonly setFilter: (value: MemoryRelationshipFilter) => void;
}) {
  return (
    <div className="border-b border-border/70 p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative min-w-0 flex-1">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            placeholder="Search people, companies, emails, or open loops"
            className="h-9 pl-9 text-sm"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          {RELATIONSHIP_FILTERS.map((option) => {
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
      </div>
    </div>
  );
}

function RelationshipList({
  relationships,
  pagination,
  selectedRelationship,
  setSelectedId,
}: {
  readonly relationships: readonly RelationshipRecord[];
  readonly pagination: RelationshipSearchResponse["pagination"];
  readonly selectedRelationship: RelationshipRecord | null;
  readonly setSelectedId: (value: string) => void;
}) {
  return (
    <aside className="min-w-0 border-b border-border/70 bg-muted/20 lg:border-b-0 lg:border-r">
      <div className="flex h-9 items-center justify-between border-b border-border/70 px-3">
        <span className="text-xs font-medium text-muted-foreground">
          Relationships
        </span>
        <span className="text-xs text-muted-foreground">
          {relationshipCountLabel(pagination, relationships.length)}
        </span>
      </div>
      <div className="max-h-[360px] overflow-auto p-2 lg:max-h-none">
        {relationships.length > 0 ? (
          <div className="flex flex-col gap-1">
            {relationships.map((relationship) => {
              const selected = relationship.id === selectedRelationship?.id;
              return (
                <button
                  key={relationship.id}
                  type="button"
                  aria-pressed={selected}
                  className={cn(
                    "flex min-w-0 gap-3 rounded-md px-2 py-2 text-left transition-colors",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-foreground hover:bg-background/80",
                  )}
                  onClick={() => {
                    setSelectedId(relationship.id);
                  }}
                >
                  <RelationshipAvatar relationship={relationship} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {relationship.entity.displayName}
                      </span>
                      {relationship.items.some((item) => {
                        return item.kind === "open_loop";
                      }) ? (
                        <IconClock className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                      ) : null}
                    </span>
                    {relationship.relationshipType ? (
                      <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">
                        {relationship.relationshipType}
                      </span>
                    ) : null}
                    <span className="block truncate text-xs leading-5 text-muted-foreground">
                      {relationshipSubtitle(relationship)}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs leading-5 text-muted-foreground">
                    {relationshipItemCount(relationship)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex min-h-[220px] items-center justify-center px-4 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">
                No relationships found
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Try another search or filter.
              </p>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

export function MemoryRelationships() {
  const search = useGet(memoryRelationshipSearch$);
  const filter = useGet(memoryRelationshipFilter$);
  const selectedId = useGet(selectedMemoryRelationshipId$);
  const currentPage = useGet(memoryRelationshipPage$);
  const rowsPerPage = useGet(memoryRelationshipLimit$);
  const hasPrev = useGet(memoryRelationshipHasPrev$);
  const setSearch = useSet(setMemoryRelationshipSearch$);
  const setFilter = useSet(setMemoryRelationshipFilter$);
  const setSelectedId = useSet(setSelectedMemoryRelationshipId$);
  const goToNext = useSet(goToNextMemoryRelationshipPage$);
  const goToPrev = useSet(goToPrevMemoryRelationshipPage$);
  const goForwardTwo = useSet(goForwardTwoMemoryRelationshipPages$);
  const goBackTwo = useSet(goBackTwoMemoryRelationshipPages$);
  const setRowsPerPage = useSet(setMemoryRelationshipRowsPerPage$);
  const relationshipsLoadable = useLoadable(memoryRelationships$);

  if (relationshipsLoadable.state === "loading") {
    return <MemoryRelationshipsSkeleton />;
  }
  if (relationshipsLoadable.state === "hasError") {
    return <MemoryRelationshipsError />;
  }

  const relationships = relationshipsLoadable.data.relationships;
  const pagination = relationshipsLoadable.data.pagination;
  const selectedRelationship =
    relationships.find((relationship) => {
      return relationship.id === selectedId;
    }) ??
    relationships[0] ??
    null;

  return (
    <section className="zero-card min-w-0 overflow-hidden">
      <GmailRelationshipStatusPanel />

      <RelationshipsToolbar
        search={search}
        filter={filter}
        setSearch={setSearch}
        setFilter={setFilter}
      />

      <div className="grid min-h-[420px] min-w-0 lg:grid-cols-[320px_minmax(0,1fr)]">
        <RelationshipList
          relationships={relationships}
          pagination={pagination}
          selectedRelationship={selectedRelationship}
          setSelectedId={setSelectedId}
        />

        <RelationshipDetail relationship={selectedRelationship} />
      </div>

      {pagination.total > 0 ? (
        <div className="border-t border-border/70 px-3 py-3">
          <Pagination
            currentPage={currentPage}
            totalPages={pagination.totalPages}
            rowsPerPage={rowsPerPage}
            hasNext={pagination.hasMore}
            hasPrev={hasPrev}
            labelClassName="font-normal text-muted-foreground"
            buttonClassName="bg-transparent border-border/70"
            onNextPage={() => {
              return goToNext(pagination.totalPages);
            }}
            onPrevPage={() => {
              return goToPrev();
            }}
            onForwardTwoPages={() => {
              return goForwardTwo(pagination.totalPages);
            }}
            onBackTwoPages={() => {
              return goBackTwo();
            }}
            onRowsPerPageChange={(limit) => {
              return setRowsPerPage(limit);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
