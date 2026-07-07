import type {
  ArtifactItem,
  ChatThreadArtifactGoogleDriveSync,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  IconAlertTriangle,
  IconBrandGoogleDrive,
  IconExternalLink,
  IconFileText,
  IconPackage,
  IconSearch,
} from "@tabler/icons-react";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@vm0/ui";

import { agents$ } from "../../signals/agent.ts";
import {
  artifactsList$,
  artifactsSearch$,
  navigateToArtifactThread$,
  selectedArtifactsAgentId$,
  setArtifactsSearch$,
  setSelectedArtifactsAgentId$,
} from "../../signals/artifacts-page/artifacts-signals.ts";

const ARTIFACTS_PAGE_LIMIT = 50;

function formatArtifactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatArtifactKind(kind: string | undefined): string | null {
  if (!kind) {
    return null;
  }
  return kind.replace(/[-_]/g, " ");
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  const kib = size / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function driveSyncLabel(
  sync: ChatThreadArtifactGoogleDriveSync | undefined,
): string | null {
  if (!sync) {
    return null;
  }
  if (sync.status === "synced") {
    return "Synced to Google Drive";
  }
  if (sync.status === "not_synced") {
    return "Not synced";
  }
  if (sync.status === "disconnected") {
    return "Google Drive disconnected";
  }
  return "Sync unknown";
}

function agentDisplayName(
  item: ArtifactItem,
  agents: readonly TeamComposeItem[],
) {
  return (
    item.agentName ??
    agents.find((agent) => {
      return agent.id === item.agentId;
    })?.displayName ??
    "Agent"
  );
}

function ArtifactsToolbar({
  search,
  selectedAgentId,
  agents,
  onSearchChange,
  onAgentChange,
}: {
  readonly search: string;
  readonly selectedAgentId: string | null;
  readonly agents: readonly TeamComposeItem[];
  readonly onSearchChange: (value: string) => void;
  readonly onAgentChange: (value: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        <IconSearch
          aria-hidden
          size={15}
          stroke={1.5}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
        />
        <Input
          aria-label="Search artifacts"
          placeholder="Search artifacts"
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
          }}
          className="pl-9"
        />
      </div>
      <Select
        value={selectedAgentId ?? "all"}
        onValueChange={(value) => {
          onAgentChange(value === "all" ? null : value);
        }}
      >
        <SelectTrigger aria-label="Agent filter" className="w-full sm:w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All agents</SelectItem>
          {agents.map((agent) => {
            return (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.displayName ?? "Zero"}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function ArtifactMetadataPill({
  children,
  className,
}: {
  readonly children: string;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center rounded border border-border/70 bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function ArtifactCard({
  item,
  agents,
  onOpenChat,
}: {
  readonly item: ArtifactItem;
  readonly agents: readonly TeamComposeItem[];
  readonly onOpenChat: (threadId: string) => void;
}) {
  const kindLabel = formatArtifactKind(item.artifactKind);
  const syncLabel = driveSyncLabel(item.googleDriveSync);
  return (
    <article className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground">
          <IconFileText size={17} stroke={1.5} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium text-foreground">
                {item.filename}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {agentDisplayName(item, agents)}
                {item.threadTitle ? ` · ${item.threadTitle}` : ""}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 rounded-lg"
              aria-label={`Open source chat for ${item.filename}`}
              onClick={() => {
                onOpenChat(item.threadId);
              }}
            >
              <IconExternalLink size={14} stroke={1.5} aria-hidden />
              Open chat
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <ArtifactMetadataPill>{item.contentType}</ArtifactMetadataPill>
            {kindLabel && (
              <ArtifactMetadataPill>{kindLabel}</ArtifactMetadataPill>
            )}
            <ArtifactMetadataPill>
              {formatBytes(item.size)}
            </ArtifactMetadataPill>
            <ArtifactMetadataPill>
              {formatArtifactDate(item.createdAt)}
            </ArtifactMetadataPill>
          </div>
        </div>
      </div>
      {syncLabel && (
        <div className="mt-2 flex items-center gap-1.5 pl-11 text-xs text-muted-foreground">
          <IconBrandGoogleDrive size={14} stroke={1.5} aria-hidden />
          <span>{syncLabel}</span>
        </div>
      )}
    </article>
  );
}

function ArtifactsLoadingState() {
  return (
    <div className="flex flex-col gap-2" aria-label="Loading artifacts">
      {Array.from({ length: 4 }, (_, index) => {
        return (
          <div
            key={index}
            className="h-[92px] rounded-lg border border-border bg-card px-4 py-3"
          >
            <div className="flex items-start gap-3">
              <div className="h-8 w-8 rounded-lg bg-muted/50" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-2/5 rounded bg-muted/50" />
                <div className="h-3 w-1/3 rounded bg-muted/40" />
                <div className="flex gap-2 pt-2">
                  <div className="h-5 w-20 rounded bg-muted/40" />
                  <div className="h-5 w-24 rounded bg-muted/40" />
                  <div className="h-5 w-16 rounded bg-muted/40" />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ArtifactsErrorState() {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <IconAlertTriangle size={16} stroke={1.5} aria-hidden />
      Could not load artifacts. Try again later.
    </div>
  );
}

function ArtifactsEmptyState({ filtered }: { readonly filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
        <IconPackage size={20} stroke={1.5} aria-hidden />
      </div>
      <h2 className="mt-4 text-sm font-medium text-foreground">
        {filtered ? "No artifacts match this search" : "No artifacts yet"}
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {filtered
          ? "Adjust the search or agent filter to find generated artifacts."
          : "Generated files will appear here after agents create them."}
      </p>
    </div>
  );
}

function ArtifactsList({
  artifacts,
  agents,
  hasFilters,
  loading,
  error,
  onOpenChat,
}: {
  readonly artifacts: readonly ArtifactItem[];
  readonly agents: readonly TeamComposeItem[];
  readonly hasFilters: boolean;
  readonly loading: boolean;
  readonly error: boolean;
  readonly onOpenChat: (threadId: string) => void;
}) {
  if (loading) {
    return <ArtifactsLoadingState />;
  }
  if (error) {
    return <ArtifactsErrorState />;
  }
  if (artifacts.length === 0) {
    return <ArtifactsEmptyState filtered={hasFilters} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {artifacts.map((artifact) => {
        return (
          <ArtifactCard
            key={artifact.artifactItemId}
            item={artifact}
            agents={agents}
            onOpenChat={onOpenChat}
          />
        );
      })}
    </div>
  );
}

export function ArtifactsPage() {
  const search = useGet(artifactsSearch$);
  const selectedAgentId = useGet(selectedArtifactsAgentId$);
  const setSearch = useSet(setArtifactsSearch$);
  const setSelectedAgentId = useSet(setSelectedArtifactsAgentId$);
  const openChat = useSet(navigateToArtifactThread$);
  const artifactsLoadable = useLastLoadable(artifactsList$);
  const agents = useLastResolved(agents$) ?? [];
  const response =
    artifactsLoadable.state === "hasData" ? artifactsLoadable.data : null;
  const artifacts = response?.artifacts ?? [];
  const loading = artifactsLoadable.state === "loading" && !response;
  const error = artifactsLoadable.state === "hasError";
  const hasFilters = search.trim().length > 0 || selectedAgentId !== null;
  const hasMore = Boolean(response?.nextCursor);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto [scrollbar-gutter:stable]">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pt-10 md:pb-3">
        <div className="mx-auto w-full max-w-[900px]">
          <div className="hidden min-w-0 md:block">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              Artifacts
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Browse generated files from this organization.
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pt-3 pb-16 sm:px-6">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
          <ArtifactsToolbar
            search={search}
            selectedAgentId={selectedAgentId}
            agents={agents}
            onSearchChange={setSearch}
            onAgentChange={setSelectedAgentId}
          />
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              Showing up to {ARTIFACTS_PAGE_LIMIT} generated artifacts
              {hasMore ? " with more available" : ""}
            </span>
            {artifactsLoadable.state === "loading" && response && (
              <span>Refreshing</span>
            )}
          </div>
          <ArtifactsList
            artifacts={artifacts}
            agents={agents}
            hasFilters={hasFilters}
            loading={loading}
            error={error}
            onOpenChat={openChat}
          />
        </div>
      </main>
    </div>
  );
}
