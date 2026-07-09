import type { ArtifactItem } from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  IconAlertTriangle,
  IconExternalLink,
  IconMessageCircle,
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
  artifactsSearch$,
  cachedArtifacts$,
  filterArtifacts,
  navigateToArtifactThread$,
  remoteArtifacts$,
  selectedArtifactsAgentId$,
  selectedArtifactsCategory$,
  setArtifactsSearch$,
  setSelectedArtifactsAgentId$,
  setSelectedArtifactsCategory$,
} from "../../signals/artifacts-page/artifacts-signals.ts";
import type { ArtifactCategory } from "../../signals/artifacts-page/artifact-category.ts";
import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "../zero-page/zero-file-preview-icon.tsx";
import { publicAttachmentUrl } from "../zero-page/zero-attachment-url.ts";

type ArtifactPreviewKind = "image" | "html" | "pdf" | "video" | "file";

const DESKTOP_ARTIFACT_PREVIEW_SIZE = 1280;
const ARTIFACT_CATEGORY_OPTIONS: readonly {
  readonly ariaLabel: string;
  readonly label: string;
  readonly value: ArtifactCategory | null;
}[] = [
  { ariaLabel: "Show all artifacts", label: "All", value: null },
  { ariaLabel: "Show image artifacts", label: "Images", value: "image" },
  { ariaLabel: "Show video artifacts", label: "Videos", value: "video" },
  { ariaLabel: "Show website artifacts", label: "Websites", value: "website" },
  {
    ariaLabel: "Show presentation artifacts",
    label: "Presentations",
    value: "presentation",
  },
  {
    ariaLabel: "Show document artifacts",
    label: "Documents",
    value: "document",
  },
  { ariaLabel: "Show data artifacts", label: "Data", value: "data" },
  { ariaLabel: "Show other artifacts", label: "Other", value: "other" },
];

function formatArtifactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("en-US", {
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

function artifactPreviewKind(item: ArtifactItem): ArtifactPreviewKind {
  const kind = classifyChatAttachment({
    filename: item.filename,
    url: item.url,
    contentType: item.contentType,
  });

  if (kind === "image") {
    return "image";
  }
  if (
    kind === "html" ||
    item.artifactKind === "hosted-site" ||
    item.artifactKind === "presentation-html"
  ) {
    return "html";
  }
  if (kind === "pdf") {
    return "pdf";
  }
  if (kind === "video") {
    return "video";
  }
  return "file";
}

function ArtifactsToolbar({
  search,
  selectedAgentId,
  selectedCategory,
  agents,
  onSearchChange,
  onAgentChange,
  onCategoryChange,
}: {
  readonly search: string;
  readonly selectedAgentId: string | null;
  readonly selectedCategory: ArtifactCategory | null;
  readonly agents: readonly TeamComposeItem[];
  readonly onSearchChange: (value: string) => void;
  readonly onAgentChange: (value: string | null) => void;
  readonly onCategoryChange: (value: ArtifactCategory | null) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
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
            placeholder="Search artifacts..."
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
      <div
        className="flex flex-wrap items-center gap-1.5"
        aria-label="Artifact category filters"
      >
        {ARTIFACT_CATEGORY_OPTIONS.map((option) => {
          const selected = option.value === selectedCategory;
          return (
            <button
              key={option.label}
              type="button"
              aria-label={option.ariaLabel}
              aria-pressed={selected}
              onClick={() => {
                onCategoryChange(option.value);
              }}
              className={cn(
                "inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors",
                selected
                  ? "bg-muted text-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function artifactContextLabel({
  item,
  kindLabel,
}: {
  readonly item: ArtifactItem;
  readonly kindLabel: string | null;
}): string {
  return [kindLabel ?? item.contentType, formatArtifactDate(item.createdAt)]
    .filter((part) => {
      return part.length > 0;
    })
    .join(" · ");
}

function DesktopArtifactPreviewFrame({
  src,
  title,
}: {
  readonly src: string;
  readonly title: string;
}) {
  return (
    <div className="@container relative h-full w-full overflow-hidden bg-background">
      <iframe
        src={src}
        title={title}
        loading="lazy"
        sandbox="allow-same-origin allow-scripts"
        tabIndex={-1}
        style={{
          height: `${DESKTOP_ARTIFACT_PREVIEW_SIZE}px`,
          scale: `calc(100cqw / ${DESKTOP_ARTIFACT_PREVIEW_SIZE}px)`,
          width: `${DESKTOP_ARTIFACT_PREVIEW_SIZE}px`,
        }}
        className="pointer-events-none absolute left-0 top-0 block origin-top-left scale-[0.22] border-0 bg-background"
      />
    </div>
  );
}
function ArtifactPreview({ item }: { readonly item: ArtifactItem }) {
  const previewUrl = publicAttachmentUrl(item.url);
  const previewKind = artifactPreviewKind(item);
  const title = `${item.filename} preview`;

  if (previewKind === "image") {
    return (
      <img
        src={previewUrl}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }

  if (previewKind === "html") {
    return <DesktopArtifactPreviewFrame src={previewUrl} title={title} />;
  }

  if (previewKind === "pdf") {
    return (
      <iframe
        src={`${previewUrl}#navpanes=0`}
        title={title}
        loading="lazy"
        tabIndex={-1}
        className="pointer-events-none block h-full w-full border-0 bg-background"
      />
    );
  }

  if (previewKind === "video") {
    return (
      <video
        src={previewUrl}
        muted
        playsInline
        preload="metadata"
        className="h-full w-full bg-black object-cover"
        aria-label={title}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-3 bg-gradient-to-br p-6 text-center",
        getFilePreviewAccentClass(item.filename, item.contentType),
      )}
    >
      <FilePreviewIcon
        filename={item.filename}
        contentType={item.contentType}
      />
      <div className="max-w-full space-y-1">
        <p className="truncate text-xs font-medium text-foreground">
          {formatArtifactKind(item.artifactKind) ?? item.contentType}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          Preview unavailable
        </p>
      </div>
    </div>
  );
}

function ArtifactCard({
  item,
  onOpenChat,
}: {
  readonly item: ArtifactItem;
  readonly onOpenChat: (threadId: string) => void;
}) {
  const kindLabel = formatArtifactKind(item.artifactKind);
  const contextLabel = artifactContextLabel({ item, kindLabel });
  const previewUrl = publicAttachmentUrl(item.url);
  return (
    <article className="group relative mb-3 aspect-square break-inside-avoid overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-colors hover:border-foreground/20">
      <ArtifactPreview item={item} />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/95 to-transparent p-3 pt-14">
        <div className="flex min-w-0 items-end gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {item.filename}
            </h2>
            <p className="mt-1 truncate text-[11px] text-muted-foreground/80">
              {contextLabel}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              asChild
              variant="secondary"
              size="icon"
              className="h-8 w-8 rounded-lg bg-background/95 text-foreground shadow-sm hover:bg-background"
            >
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open preview for ${item.filename}`}
                title={`Open preview for ${item.filename}`}
              >
                <IconExternalLink size={14} stroke={1.7} aria-hidden />
              </a>
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="h-8 w-8 rounded-lg bg-background/95 text-foreground shadow-sm hover:bg-background"
              aria-label={`Open source chat for ${item.filename}`}
              title={`Open source chat for ${item.filename}`}
              onClick={() => {
                onOpenChat(item.threadId);
              }}
            >
              <IconMessageCircle size={14} stroke={1.7} aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function ArtifactsLoadingState() {
  return (
    <div className="columns-[220px] gap-3" aria-label="Loading artifacts">
      {Array.from({ length: 8 }, (_, index) => {
        return (
          <div
            key={index}
            className="mb-3 aspect-square break-inside-avoid overflow-hidden rounded-lg border border-border bg-card"
          >
            <div className="h-full bg-muted/30">
              <div className="flex h-full flex-col justify-end p-3">
                <div className="h-4 w-3/4 rounded bg-background/70" />
                <div className="mt-2 h-3 w-1/2 rounded bg-background/60" />
                <div className="mt-3 flex gap-1.5">
                  <div className="h-5 w-16 rounded border border-border/40 bg-background/60" />
                  <div className="h-5 w-20 rounded border border-border/40 bg-background/60" />
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
  hasFilters,
  loading,
  error,
  truncated,
  onOpenChat,
}: {
  readonly artifacts: readonly ArtifactItem[];
  readonly hasFilters: boolean;
  readonly loading: boolean;
  readonly error: boolean;
  readonly truncated: boolean;
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
    <>
      {truncated && (
        <div
          role="status"
          className="mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          Showing the newest 10,000 artifacts. Filters apply to this capped set.
        </div>
      )}
      <div className="columns-[220px] gap-3">
        {artifacts.map((artifact) => {
          return (
            <ArtifactCard
              key={artifact.artifactItemId}
              item={artifact}
              onOpenChat={onOpenChat}
            />
          );
        })}
      </div>
    </>
  );
}

export function ArtifactsPage() {
  const search = useGet(artifactsSearch$);
  const selectedAgentId = useGet(selectedArtifactsAgentId$);
  const selectedCategory = useGet(selectedArtifactsCategory$);
  const setSearch = useSet(setArtifactsSearch$);
  const setSelectedAgentId = useSet(setSelectedArtifactsAgentId$);
  const setSelectedCategory = useSet(setSelectedArtifactsCategory$);
  const openChat = useSet(navigateToArtifactThread$);
  const remoteLoadable = useLastLoadable(remoteArtifacts$);
  const cachedLoadable = useLastLoadable(cachedArtifacts$);
  const agents = useLastResolved(agents$) ?? [];
  const remoteData =
    remoteLoadable.state === "hasData" ? remoteLoadable.data : null;
  const cachedData =
    cachedLoadable.state === "hasData" ? cachedLoadable.data : null;
  // Cache-first paint, then let the successful remote bulk response become the
  // authoritative set. Cached fallback is only used before remote data loads or
  // when the refresh errors.
  const sourceData = remoteData ?? cachedData;
  const sourceArtifacts = sourceData?.artifacts ?? [];
  const artifacts = filterArtifacts(sourceArtifacts, {
    search,
    agentId: selectedAgentId,
    category: selectedCategory,
  });
  // Drive first-paint loading / error off the source set (not the filtered
  // view, which is legitimately empty when a filter matches nothing).
  const nothingCached = sourceArtifacts.length === 0;
  const loading =
    nothingCached &&
    (remoteLoadable.state === "loading" || cachedLoadable.state === "loading");
  const error = nothingCached && remoteLoadable.state === "hasError";
  const hasFilters =
    search.trim().length > 0 ||
    selectedAgentId !== null ||
    selectedCategory !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-0 pt-3 sm:px-6 md:pb-3 md:pt-10">
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

      <main className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6 [scrollbar-gutter:stable]">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
          <ArtifactsToolbar
            search={search}
            selectedAgentId={selectedAgentId}
            selectedCategory={selectedCategory}
            agents={agents}
            onSearchChange={setSearch}
            onAgentChange={setSelectedAgentId}
            onCategoryChange={setSelectedCategory}
          />
          <ArtifactsList
            artifacts={artifacts}
            hasFilters={hasFilters}
            loading={loading}
            error={error}
            truncated={sourceData?.truncated ?? false}
            onOpenChat={openChat}
          />
        </div>
      </main>
    </div>
  );
}
