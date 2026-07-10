import type { ReactNode } from "react";
import type { ArtifactItem } from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  IconAlertTriangle,
  IconCarambola,
  IconCarambolaFilled,
  IconDots,
  IconExternalLink,
  IconHistory,
  IconMessagePlus,
  IconPackage,
  IconPhoto,
  IconPresentationAnalytics,
  IconSearch,
  IconVideo,
  IconWorld,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
  applyArtifactFavoriteOverrides,
  artifactFavoriteOverrides$,
  artifactsFavoritesOnly$,
  artifactsSearch$,
  artifactsWindow$,
  cachedArtifacts$,
  filterArtifacts,
  growArtifactsWindow$,
  navigateToArtifactThread$,
  reloadArtifacts$,
  remoteArtifacts$,
  selectedArtifactsAgentId$,
  selectedArtifactsCategory$,
  setArtifactsFavoritesOnly$,
  setArtifactsSearch$,
  setSelectedArtifactsAgentId$,
  setSelectedArtifactsCategory$,
  startArtifactChat$,
  toggleArtifactFavorite$,
} from "../../signals/artifacts-page/artifacts-signals.ts";
import type { ArtifactCategory } from "../../signals/artifacts-page/artifact-category.ts";
import {
  classifyChatAttachment,
  type BodyPreviewKind,
} from "../../signals/chat-page/parse-body-blocks.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  lightboxUrl$,
  openAudioLightbox$,
  openDocumentLightbox$,
  openImageLightbox$,
  openVideoLightbox$,
  type AttachmentArtifactMetadata,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AttachmentLightbox } from "../zero-page/zero-attachment-chips.tsx";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "../zero-page/zero-file-preview-icon.tsx";
import { publicAttachmentUrl } from "../zero-page/zero-attachment-url.ts";

type ArtifactPreviewKind = "image" | "html" | "pdf" | "video" | "file";
type ArtifactTypeIconKind = "presentation" | "html" | "image" | "video";

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

function formatArtifactKind(kind: string | undefined): string | null {
  if (!kind) {
    return null;
  }
  return kind.replace(/[-_]/g, " ");
}

function artifactPreviewKind(item: ArtifactItem): ArtifactPreviewKind {
  const kind = artifactLightboxKind(item);

  if (kind === "image") {
    return "image";
  }
  if (kind === "html") {
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

function artifactTypeIconKind(
  item: ArtifactItem,
  previewKind: ArtifactPreviewKind,
): ArtifactTypeIconKind | null {
  if (item.artifactKind === "presentation-html") {
    return "presentation";
  }
  if (previewKind === "html") {
    return "html";
  }
  if (previewKind === "image") {
    return "image";
  }
  if (previewKind === "video") {
    return "video";
  }
  return null;
}

function artifactLightboxKind(item: ArtifactItem): BodyPreviewKind {
  const kind = classifyChatAttachment({
    filename: item.filename,
    url: item.url,
    contentType: item.contentType,
  });

  if (
    kind === "html" ||
    item.artifactKind === "hosted-site" ||
    item.artifactKind === "presentation-html"
  ) {
    return "html";
  }
  return kind;
}

function artifactLightboxMetadata(
  item: ArtifactItem,
  onSyncSuccess: () => void,
): AttachmentArtifactMetadata {
  return {
    agentId: item.agentId,
    artifactKind: item.artifactKind,
    contentType: item.contentType,
    createdAt: item.createdAt,
    fileId: item.fileId,
    filename: item.filename,
    googleDriveDisconnected: item.googleDriveSync?.status === "disconnected",
    googleDriveSynced: item.googleDriveSync?.status === "synced",
    onSyncSuccess,
    runId: item.runId,
    size: item.size,
    threadId: item.threadId,
  };
}

function useOpenArtifactPreview(): (item: ArtifactItem) => void {
  const reloadArtifacts = useSet(reloadArtifacts$);
  const openImageLightbox = useSet(openImageLightbox$);
  const openDocumentLightbox = useSet(openDocumentLightbox$);
  const openVideoLightbox = useSet(openVideoLightbox$);
  const openAudioLightbox = useSet(openAudioLightbox$);

  return (item: ArtifactItem) => {
    const artifact = artifactLightboxMetadata(item, reloadArtifacts);
    const base = {
      artifact,
      editAvailable: false,
      filename: item.filename,
      showSizeInSubtitle: false,
      splitViewAvailable: false,
      url: item.url,
    };
    const kind = artifactLightboxKind(item);

    if (kind === "image") {
      openImageLightbox(base);
      return;
    }
    if (kind === "video") {
      openVideoLightbox(base);
      return;
    }
    if (kind === "audio") {
      openAudioLightbox(base);
      return;
    }
    if (
      kind === "markdown" ||
      kind === "text" ||
      kind === "json" ||
      kind === "csv" ||
      kind === "html" ||
      kind === "pdf"
    ) {
      openDocumentLightbox({ ...base, kind });
    }
  };
}

function ArtifactsToolbar({
  search,
  selectedAgentId,
  selectedCategory,
  favoritesOnly,
  showFavoritesFilter,
  agents,
  onSearchChange,
  onAgentChange,
  onCategoryChange,
  onFavoritesOnlyChange,
}: {
  readonly search: string;
  readonly selectedAgentId: string | null;
  readonly selectedCategory: ArtifactCategory | null;
  readonly favoritesOnly: boolean;
  readonly showFavoritesFilter: boolean;
  readonly agents: readonly TeamComposeItem[];
  readonly onSearchChange: (value: string) => void;
  readonly onAgentChange: (value: string | null) => void;
  readonly onCategoryChange: (value: ArtifactCategory | null) => void;
  readonly onFavoritesOnlyChange: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2 sm:flex-1 sm:flex-row sm:items-center">
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
          {showFavoritesFilter && (
            <button
              type="button"
              aria-label="Show favorite artifacts"
              aria-pressed={favoritesOnly}
              onClick={() => {
                onFavoritesOnlyChange(!favoritesOnly);
              }}
              className={cn(
                "inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium leading-none transition-colors",
                favoritesOnly
                  ? "bg-muted text-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {favoritesOnly ? (
                <IconCarambolaFilled size={14} aria-hidden />
              ) : (
                <IconCarambola size={14} stroke={1.7} aria-hidden />
              )}
              Favorites
            </button>
          )}
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
  return kindLabel ?? item.contentType;
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

function ArtifactTypeIcon({
  kind,
}: {
  readonly kind: ArtifactTypeIconKind;
}) {
  const icon =
    kind === "presentation"
      ? {
          element: <IconPresentationAnalytics size={16} stroke={1.7} />,
          label: "Presentation",
        }
      : kind === "html"
        ? { element: <IconWorld size={16} stroke={1.7} />, label: "HTML" }
        : kind === "image"
          ? { element: <IconPhoto size={16} stroke={1.7} />, label: "Image" }
          : { element: <IconVideo size={16} stroke={1.7} />, label: "Video" };

  return (
    <span
      aria-label={`${icon.label} artifact`}
      data-testid={`artifact-card-type-icon-${kind}`}
      className="pointer-events-none absolute left-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white shadow-sm ring-1 ring-white/15"
    >
      {icon.element}
    </span>
  );
}

function ArtifactPreviewSurface({
  iconKind,
  children,
}: {
  readonly iconKind: ArtifactTypeIconKind | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="relative h-full w-full">
      {children}
      {iconKind ? <ArtifactTypeIcon kind={iconKind} /> : null}
    </div>
  );
}

function ArtifactPreview({ item }: { readonly item: ArtifactItem }) {
  const previewUrl = publicAttachmentUrl(item.url);
  const previewKind = artifactPreviewKind(item);
  const iconKind = artifactTypeIconKind(item, previewKind);
  const title = `${item.filename} preview`;

  // A pre-rendered static snapshot (generated at deploy time for HTML/website
  // artifacts) replaces the live iframe entirely, so the grid loads a single
  // image instead of the full hosted site. Absent for old / not-yet-rendered /
  // render-failed artifacts, which fall through to the live preview below.
  if (item.previewImageUrl) {
    return (
      <ArtifactPreviewSurface iconKind={iconKind}>
        <img
          src={item.previewImageUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </ArtifactPreviewSurface>
    );
  }

  if (previewKind === "image") {
    return (
      <ArtifactPreviewSurface iconKind={iconKind}>
        <img
          src={previewUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      </ArtifactPreviewSurface>
    );
  }

  if (previewKind === "html") {
    return (
      <ArtifactPreviewSurface iconKind={iconKind}>
        <DesktopArtifactPreviewFrame src={previewUrl} title={title} />
      </ArtifactPreviewSurface>
    );
  }

  if (previewKind === "pdf") {
    return (
      <ArtifactPreviewSurface iconKind={iconKind}>
        <iframe
          src={`${previewUrl}#navpanes=0`}
          title={title}
          loading="lazy"
          tabIndex={-1}
          className="pointer-events-none block h-full w-full border-0 bg-background"
        />
      </ArtifactPreviewSurface>
    );
  }

  if (previewKind === "video") {
    return (
      <ArtifactPreviewSurface iconKind={iconKind}>
        <video
          src={previewUrl}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full bg-black object-cover"
          aria-label={title}
        />
      </ArtifactPreviewSurface>
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

function ArtifactCardActions({
  favorited,
  item,
  previewUrl,
  showFavoriteAction,
  onOpenChat,
  onStartChat,
  onToggleFavorite,
}: {
  readonly favorited: boolean;
  readonly item: ArtifactItem;
  readonly previewUrl: string;
  readonly showFavoriteAction: boolean;
  readonly onOpenChat: (threadId: string) => void;
  readonly onStartChat: (item: ArtifactItem) => void;
  readonly onToggleFavorite: (item: ArtifactItem) => void;
}) {
  return (
    <div
      className="flex shrink-0 gap-1"
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
    >
      {showFavoriteAction && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className={cn(
            "h-8 w-8 rounded-lg bg-background/95 text-foreground shadow-sm hover:bg-background",
            favorited && "text-amber-500 hover:text-amber-500",
          )}
          aria-label={
            favorited
              ? `Remove ${item.filename} from favorites`
              : `Add ${item.filename} to favorites`
          }
          aria-pressed={favorited}
          title={
            favorited
              ? `Remove ${item.filename} from favorites`
              : `Add ${item.filename} to favorites`
          }
          onClick={() => {
            onToggleFavorite(item);
          }}
        >
          {favorited ? (
            <IconCarambolaFilled size={14} aria-hidden />
          ) : (
            <IconCarambola size={14} stroke={1.7} aria-hidden />
          )}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="h-8 w-8 rounded-lg bg-background/95 text-foreground shadow-sm hover:bg-background"
            aria-label={`More actions for ${item.filename}`}
            title={`More actions for ${item.filename}`}
          >
            <IconDots size={14} stroke={1.7} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48"
          onClick={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
          }}
        >
          <DropdownMenuItem
            onClick={() => {
              onStartChat(item);
            }}
          >
            <IconMessagePlus size={14} stroke={1.7} aria-hidden />
            Ask about it
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              onOpenChat(item.threadId);
            }}
          >
            <IconHistory size={14} stroke={1.7} aria-hidden />
            View creation chat
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open preview for ${item.filename}`}
            >
              <IconExternalLink size={14} stroke={1.7} aria-hidden />
              Open a new tab
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ArtifactCard({
  item,
  onOpenChat,
  onOpenPreview,
  onStartChat,
  onToggleFavorite,
  showFavoriteAction,
}: {
  readonly item: ArtifactItem;
  readonly onOpenChat: (threadId: string) => void;
  readonly onOpenPreview: (item: ArtifactItem) => void;
  readonly onStartChat: (item: ArtifactItem) => void;
  readonly onToggleFavorite: (item: ArtifactItem) => void;
  readonly showFavoriteAction: boolean;
}) {
  const kindLabel = formatArtifactKind(item.artifactKind);
  const contextLabel = artifactContextLabel({ item, kindLabel });
  const previewUrl = publicAttachmentUrl(item.url);
  const previewable = artifactLightboxKind(item) !== "file";
  const favorited = item.isFavorited === true;
  return (
    <article
      role={previewable ? "button" : undefined}
      tabIndex={previewable ? 0 : undefined}
      aria-label={previewable ? `Preview ${item.filename}` : undefined}
      onClick={
        previewable
          ? () => {
              onOpenPreview(item);
            }
          : undefined
      }
      onKeyDown={
        previewable
          ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }
              event.preventDefault();
              onOpenPreview(item);
            }
          : undefined
      }
      className={cn(
        "group relative mb-3 aspect-square break-inside-avoid overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-colors hover:border-foreground/20",
        previewable &&
          "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
    >
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
          <ArtifactCardActions
            favorited={favorited}
            item={item}
            previewUrl={previewUrl}
            showFavoriteAction={showFavoriteAction}
            onOpenChat={onOpenChat}
            onStartChat={onStartChat}
            onToggleFavorite={onToggleFavorite}
          />
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
  visibleCount,
  onLoadMore,
  onOpenChat,
  onOpenPreview,
  onStartChat,
  onToggleFavorite,
  showFavoriteAction,
}: {
  readonly artifacts: readonly ArtifactItem[];
  readonly hasFilters: boolean;
  readonly loading: boolean;
  readonly error: boolean;
  readonly visibleCount: number;
  readonly onLoadMore: () => void;
  readonly onOpenChat: (threadId: string) => void;
  readonly onOpenPreview: (item: ArtifactItem) => void;
  readonly onStartChat: (item: ArtifactItem) => void;
  readonly onToggleFavorite: (item: ArtifactItem) => void;
  readonly showFavoriteAction: boolean;
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
  // Render only the current window so a large set never mounts thousands of
  // cards (and their iframes) at once; "Load more" reveals the next window.
  const windowed = artifacts.slice(0, visibleCount);
  const hasMore = windowed.length < artifacts.length;
  return (
    <>
      <div className="columns-[220px] gap-3">
        {windowed.map((artifact) => {
          return (
            <ArtifactCard
              key={artifact.artifactItemId}
              item={artifact}
              onOpenChat={onOpenChat}
              onOpenPreview={onOpenPreview}
              onStartChat={onStartChat}
              onToggleFavorite={onToggleFavorite}
              showFavoriteAction={showFavoriteAction}
            />
          );
        })}
      </div>
      {hasMore && (
        <div className="flex justify-center pt-1">
          <Button variant="secondary" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export function ArtifactsPage() {
  const search = useGet(artifactsSearch$);
  const selectedAgentId = useGet(selectedArtifactsAgentId$);
  const selectedCategory = useGet(selectedArtifactsCategory$);
  const favoritesOnly = useGet(artifactsFavoritesOnly$);
  const favoriteOverrides = useGet(artifactFavoriteOverrides$);
  const setSearch = useSet(setArtifactsSearch$);
  const setSelectedAgentId = useSet(setSelectedArtifactsAgentId$);
  const setSelectedCategory = useSet(setSelectedArtifactsCategory$);
  const setFavoritesOnly = useSet(setArtifactsFavoritesOnly$);
  const toggleFavorite = useSet(toggleArtifactFavorite$);
  const openChat = useSet(navigateToArtifactThread$);
  const startChat = useSet(startArtifactChat$);
  const pageSignal = useGet(pageSignal$);
  const visibleCount = useGet(artifactsWindow$);
  const loadMore = useSet(growArtifactsWindow$);
  const openArtifactPreview = useOpenArtifactPreview();
  const lightboxUrl = useGet(lightboxUrl$);
  const remoteLoadable = useLastLoadable(remoteArtifacts$);
  const cachedLoadable = useLastLoadable(cachedArtifacts$);
  const agents = useLastResolved(agents$) ?? [];
  const features = useLastResolved(featureSwitch$);
  const artifactFavoritesEnabled =
    features?.[FeatureSwitchKey.ArtifactFavorites] ?? false;
  const remoteData =
    remoteLoadable.state === "hasData" ? remoteLoadable.data : null;
  const cachedData =
    cachedLoadable.state === "hasData" ? cachedLoadable.data : null;
  // Cache-first paint, then let the successful remote bulk response become the
  // authoritative set. Cached fallback is only used before remote data loads or
  // when the refresh errors.
  const sourceData = remoteData ?? cachedData;
  const sourceArtifacts = applyArtifactFavoriteOverrides(
    sourceData?.artifacts ?? [],
    favoriteOverrides,
  );
  const artifacts = filterArtifacts(sourceArtifacts, {
    search,
    agentId: selectedAgentId,
    category: selectedCategory,
    favoritesOnly: artifactFavoritesEnabled && favoritesOnly,
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
    selectedCategory !== null ||
    (artifactFavoritesEnabled && favoritesOnly);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {lightboxUrl && <AttachmentLightbox />}
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
            favoritesOnly={artifactFavoritesEnabled && favoritesOnly}
            showFavoritesFilter={artifactFavoritesEnabled}
            agents={agents}
            onSearchChange={setSearch}
            onAgentChange={setSelectedAgentId}
            onCategoryChange={setSelectedCategory}
            onFavoritesOnlyChange={setFavoritesOnly}
          />
          <ArtifactsList
            artifacts={artifacts}
            hasFilters={hasFilters}
            loading={loading}
            error={error}
            visibleCount={visibleCount}
            onLoadMore={loadMore}
            onOpenChat={openChat}
            onOpenPreview={openArtifactPreview}
            onStartChat={startChat}
            onToggleFavorite={(item) => {
              detach(toggleFavorite(item, pageSignal), Reason.DomCallback);
            }}
            showFavoriteAction={artifactFavoritesEnabled}
          />
        </div>
      </main>
    </div>
  );
}
