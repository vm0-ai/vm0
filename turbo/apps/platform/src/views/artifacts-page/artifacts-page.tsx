import type {
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  UIEvent as ReactUIEvent,
} from "react";
import type { ArtifactItem } from "@vm0/api-contracts/contracts/chat-threads";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  IconAlertTriangle,
  IconCarambola,
  IconCarambolaFilled,
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconDots,
  IconExternalLink,
  IconFilter,
  IconHistory,
  IconMessagePlus,
  IconPhoto,
  IconPresentationAnalytics,
  IconSearch,
  IconVideo,
  IconWorld,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { r2ImageTransformUrl } from "@vm0/core";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";

import { agents$ } from "../../signals/agent.ts";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";
import {
  applyArtifactFavorites,
  artifactFavoriteOverrides$,
  artifactsGridElement$,
  artifactsGridWidth$,
  artifactsFavoritesOnly$,
  artifactsSearch$,
  artifactsScrollMetrics$,
  artifactsScrollViewport$,
  artifactsWindow$,
  cachedArtifacts$,
  filterArtifacts,
  getArtifactFocusTarget,
  growArtifactsWindow$,
  mergeArtifactSources,
  navigateToArtifactThread$,
  reloadArtifacts$,
  remoteArtifacts$,
  remoteArtifactFavoriteUrls$,
  requestArtifactsKeyboardFocus$,
  selectedArtifactsAgentId$,
  selectedArtifactsCategory$,
  setArtifactCardRef$,
  setArtifactsGridRef$,
  setArtifactsFavoritesOnly$,
  setArtifactsScrollViewportRef$,
  setArtifactsSearch$,
  setSelectedArtifactsAgentId$,
  setSelectedArtifactsCategory$,
  startArtifactChat$,
  syncArtifacts$,
  syncArtifactsScrollMetrics$,
  toggleArtifactFavorite$,
  type ArtifactPageItem,
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
import { detach, Reason, tapError } from "../../signals/utils.ts";
import { AttachmentLightbox } from "../zero-page/zero-attachment-chips.tsx";
import {
  FilePreviewIcon,
  getFilePreviewAccentClass,
} from "../zero-page/zero-file-preview-icon.tsx";
import {
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "../zero-page/zero-attachment-url.ts";
import { emptyArtifactImg } from "../zero-page/platform-assets.ts";

type ArtifactPreviewKind = "image" | "html" | "pdf" | "video" | "file";
type ArtifactTypeIconKind = "presentation" | "html" | "image" | "video";

const DESKTOP_ARTIFACT_PREVIEW_WIDTH = 1280;
const DESKTOP_ARTIFACT_PREVIEW_HEIGHT = 800;
const ARTIFACT_AUTO_LOAD_THRESHOLD_PX = 800;
const ARTIFACT_GRID_GAP_PX = 12;
const ARTIFACT_GRID_MIN_CARD_WIDTH_PX = 292;
const ARTIFACT_GRID_OVERSCAN_ROWS = 2;
const ARTIFACT_GRID_FALLBACK_WIDTH_PX = 900;
const ARTIFACT_GRID_FALLBACK_VIEWPORT_HEIGHT_PX = 800;
const ARTIFACT_CARD_IMAGE_WIDTH = 640;
const ARTIFACT_CARD_IMAGE_HEIGHT = 400;
const ARTIFACT_CARD_PREVIEW_ASPECT_RATIO = 16 / 10;
const ARTIFACT_CARD_DETAILS_HEIGHT_PX = 64;
const ARTIFACT_CARD_BORDER_WIDTH_PX = 1;
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

function isZipArtifact(item: ArtifactItem): boolean {
  return (
    item.contentType === "application/zip" ||
    item.contentType === "application/x-zip-compressed"
  );
}

function artifactCardImageSupportsTransform(item: ArtifactItem): boolean {
  const extension = item.filename.split(".").pop()?.toLowerCase();
  return (
    extension === "gif" ||
    extension === "jpeg" ||
    extension === "jpg" ||
    extension === "png" ||
    extension === "webp"
  );
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
  const syncArtifacts = useSet(syncArtifacts$);
  const pageSignal = useGet(pageSignal$);
  const openImageLightbox = useSet(openImageLightbox$);
  const openDocumentLightbox = useSet(openDocumentLightbox$);
  const openVideoLightbox = useSet(openVideoLightbox$);
  const openAudioLightbox = useSet(openAudioLightbox$);

  return (item: ArtifactItem) => {
    const artifact = artifactLightboxMetadata(item, () => {
      reloadArtifacts();
      detach(tapError(syncArtifacts(pageSignal)), Reason.DomCallback);
    });
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

function artifactsAgentName(agent: TeamComposeItem): string {
  return agent.displayName ?? "Zero";
}

function ArtifactsAgentFilterSectionLabel({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground/80">
      {children}
    </div>
  );
}

function ArtifactsAgentFilterOption({
  active,
  onSelect,
  children,
}: {
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
}) {
  return (
    <DropdownMenuItem className="justify-between gap-2" onClick={onSelect}>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
      {active && (
        <IconCheck size={15} stroke={2} className="shrink-0 text-foreground" />
      )}
    </DropdownMenuItem>
  );
}

function ArtifactsAgentFilter({
  agents,
  selectedAgentId,
  onAgentChange,
}: {
  readonly agents: readonly TeamComposeItem[];
  readonly selectedAgentId: string | null;
  readonly onAgentChange: (value: string | null) => void;
}) {
  const activeAgent =
    selectedAgentId === null
      ? undefined
      : agents.find((agent) => {
          return agent.id === selectedAgentId;
        });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Agent filter"
          className="zero-btn-morandi h-9 shrink-0 gap-1.5 rounded-lg border"
        >
          <IconFilter
            size={14}
            stroke={1.5}
            className="text-muted-foreground"
          />
          {activeAgent && (
            <AvatarFromUrl
              avatarUrl={activeAgent.avatarUrl}
              alt={artifactsAgentName(activeAgent)}
              size={16}
              className="h-4 w-4 rounded-full object-cover"
            />
          )}
          <span className="max-w-[140px] truncate">
            {activeAgent ? artifactsAgentName(activeAgent) : "All agents"}
          </span>
          <IconChevronDown
            size={14}
            stroke={1.5}
            className="text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(420px,var(--radix-dropdown-menu-content-available-height))] w-56 overflow-y-auto"
      >
        <ArtifactsAgentFilterOption
          active={selectedAgentId === null}
          onSelect={() => {
            onAgentChange(null);
          }}
        >
          All agents
        </ArtifactsAgentFilterOption>
        {agents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <ArtifactsAgentFilterSectionLabel>
              Agents
            </ArtifactsAgentFilterSectionLabel>
            {agents.map((agent) => {
              return (
                <ArtifactsAgentFilterOption
                  key={agent.id}
                  active={selectedAgentId === agent.id}
                  onSelect={() => {
                    onAgentChange(agent.id);
                  }}
                >
                  <AvatarFromUrl
                    avatarUrl={agent.avatarUrl}
                    alt={artifactsAgentName(agent)}
                    size={16}
                    className="h-4 w-4 rounded-full object-cover"
                  />
                  <span className="truncate">{artifactsAgentName(agent)}</span>
                </ArtifactsAgentFilterOption>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
        <ArtifactsAgentFilter
          agents={agents}
          selectedAgentId={selectedAgentId}
          onAgentChange={onAgentChange}
        />
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
          height: `${DESKTOP_ARTIFACT_PREVIEW_HEIGHT}px`,
          scale: `calc(100cqw / ${DESKTOP_ARTIFACT_PREVIEW_WIDTH}px)`,
          width: `${DESKTOP_ARTIFACT_PREVIEW_WIDTH}px`,
        }}
        className="pointer-events-none absolute left-0 top-0 block origin-top-left scale-[0.22] border-0 bg-background"
      />
    </div>
  );
}

function ArtifactTypeIcon({ kind }: { readonly kind: ArtifactTypeIconKind }) {
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

  // A pre-rendered static snapshot (page screenshot for HTML/website, poster
  // frame for video) replaces the live iframe/video entirely, so the grid loads
  // a single image. Absent for old / not-yet-rendered / render-failed artifacts,
  // which fall through to the live preview below.
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
    const thumbnailUrl = artifactCardImageSupportsTransform(item)
      ? r2ImageTransformUrl(previewUrl, {
          width: ARTIFACT_CARD_IMAGE_WIDTH,
          height: ARTIFACT_CARD_IMAGE_HEIGHT,
          fit: "scale-down",
        })
      : previewUrl;
    return (
      <ArtifactPreviewSurface iconKind={iconKind}>
        <img
          src={thumbnailUrl}
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

interface ArtifactCardActionsProps {
  readonly favorited: boolean;
  readonly item: ArtifactPageItem;
  readonly previewUrl: string;
  readonly favoriteActionEnabled: boolean;
  readonly showFavoriteAction: boolean;
  readonly onOpenChat: (threadId: string) => void;
  readonly onStartChat: (item: ArtifactItem) => void;
  readonly onToggleFavorite: (item: ArtifactPageItem) => void;
}

function ArtifactCardActions({
  favorited,
  item,
  previewUrl,
  favoriteActionEnabled,
  showFavoriteAction,
  onOpenChat,
  onStartChat,
  onToggleFavorite,
}: ArtifactCardActionsProps) {
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
          variant="ghost"
          size="icon"
          className={cn(
            "h-8 w-8 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted",
            favorited && "text-amber-500 hover:text-amber-500",
          )}
          aria-label={
            favorited
              ? `Remove ${item.filename} from favorites`
              : `Add ${item.filename} to favorites`
          }
          aria-pressed={favorited}
          disabled={!favoriteActionEnabled}
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
            <IconCarambolaFilled size={16} aria-hidden />
          ) : (
            <IconCarambola size={16} stroke={1.5} aria-hidden />
          )}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted data-[state=open]:bg-muted data-[state=open]:text-foreground"
            aria-label={`More actions for ${item.filename}`}
            title={`More actions for ${item.filename}`}
          >
            <IconDots size={16} stroke={1.5} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-48 [&_svg]:text-muted-foreground"
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
            Ask about this
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              onOpenChat(item.threadId);
            }}
          >
            <IconHistory size={14} stroke={1.7} aria-hidden />
            View original chat
          </DropdownMenuItem>
          {isZipArtifact(item) ? (
            <DropdownMenuItem
              onClick={() => {
                detach(
                  downloadAttachmentUrl(item.url, undefined, item.filename),
                  Reason.DomCallback,
                  "artifact download",
                );
              }}
            >
              <IconDownload size={14} stroke={1.7} aria-hidden />
              Download
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem asChild>
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open preview for ${item.filename}`}
              >
                <IconExternalLink size={14} stroke={1.7} aria-hidden />
                Open in new tab
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ArtifactCard({
  cardRef,
  index,
  item,
  onOpenChat,
  onOpenPreview,
  onStartChat,
  onToggleFavorite,
  favoriteActionEnabled,
  showFavoriteAction,
}: {
  readonly cardRef: (element: HTMLElement | null) => void;
  readonly index: number;
  readonly item: ArtifactPageItem;
  readonly onOpenChat: (threadId: string) => void;
  readonly onOpenPreview: (item: ArtifactItem) => void;
  readonly onStartChat: (item: ArtifactItem) => void;
  readonly onToggleFavorite: (item: ArtifactPageItem) => void;
  readonly favoriteActionEnabled: boolean;
  readonly showFavoriteAction: boolean;
}) {
  const kindLabel = formatArtifactKind(item.artifactKind);
  const contextLabel = artifactContextLabel({ item, kindLabel });
  const previewUrl = publicAttachmentUrl(item.url);
  const previewable = artifactLightboxKind(item) !== "file";
  const favorited = item.isFavorited;
  return (
    <article
      ref={cardRef}
      data-artifact-index={index}
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
        "group flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-colors hover:border-foreground/20",
        previewable &&
          "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
    >
      <div
        data-testid="artifact-card-preview"
        className="relative aspect-[16/10] w-full shrink-0 overflow-hidden bg-background"
      >
        <ArtifactPreview item={item} />
      </div>
      <div
        data-testid="artifact-card-details"
        className="flex h-16 min-w-0 shrink-0 items-center gap-2 border-t border-border p-3"
      >
        <div className="min-w-0 flex-1">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <h2 className="min-w-0 cursor-default truncate text-sm font-semibold leading-5 text-foreground">
                  {item.filename}
                </h2>
              </TooltipTrigger>
              <TooltipContent side="bottom">{item.filename}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <p className="mt-1 truncate text-[11px] text-muted-foreground/80">
            {contextLabel}
          </p>
        </div>
        <ArtifactCardActions
          favorited={favorited}
          favoriteActionEnabled={favoriteActionEnabled}
          item={item}
          previewUrl={previewUrl}
          showFavoriteAction={showFavoriteAction}
          onOpenChat={onOpenChat}
          onStartChat={onStartChat}
          onToggleFavorite={onToggleFavorite}
        />
      </div>
    </article>
  );
}

function ArtifactsLoadingState() {
  return (
    <div
      className="grid gap-3"
      aria-label="Loading artifacts"
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${String(ARTIFACT_GRID_MIN_CARD_WIDTH_PX)}px), 1fr))`,
      }}
    >
      {Array.from({ length: 8 }, (_, index) => {
        return (
          <div
            key={index}
            className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
          >
            <div className="aspect-[16/10] w-full shrink-0 bg-muted/30" />
            <div className="flex h-16 shrink-0 items-center p-3">
              <div className="w-full">
                <div className="h-4 w-3/4 rounded bg-muted/60" />
                <div className="mt-2 h-3 w-1/2 rounded bg-muted/40" />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function hasUsableLayoutPosition(rect: DOMRectReadOnly): boolean {
  return rect.top !== 0 || rect.left !== 0;
}

function getArtifactsGridScrollMargin(
  scrollViewport: HTMLElement | null,
  gridElement: HTMLElement | null,
): number {
  if (!scrollViewport || !gridElement) {
    return 0;
  }

  const viewportRect = scrollViewport.getBoundingClientRect();
  const gridRect = gridElement.getBoundingClientRect();
  if (
    hasUsableLayoutPosition(viewportRect) ||
    hasUsableLayoutPosition(gridRect)
  ) {
    return Math.max(
      0,
      scrollViewport.scrollTop + gridRect.top - viewportRect.top,
    );
  }

  return Math.max(0, gridElement.offsetTop - scrollViewport.offsetTop);
}

function getArtifactGridDimensions(containerWidth: number) {
  const columnCount = Math.max(
    1,
    Math.floor(
      (containerWidth + ARTIFACT_GRID_GAP_PX) /
        (ARTIFACT_GRID_MIN_CARD_WIDTH_PX + ARTIFACT_GRID_GAP_PX),
    ),
  );
  const cardWidth =
    (containerWidth - ARTIFACT_GRID_GAP_PX * (columnCount - 1)) / columnCount;
  const cardContentWidth = Math.max(
    0,
    cardWidth - ARTIFACT_CARD_BORDER_WIDTH_PX * 2,
  );
  const cardHeight =
    cardContentWidth / ARTIFACT_CARD_PREVIEW_ASPECT_RATIO +
    ARTIFACT_CARD_DETAILS_HEIGHT_PX +
    ARTIFACT_CARD_BORDER_WIDTH_PX * 2;
  return {
    columnCount,
    rowHeight: cardHeight + ARTIFACT_GRID_GAP_PX,
  };
}

function getVirtualArtifactRange({
  columnCount,
  itemCount,
  rowHeight,
  scrollMargin,
  scrollTop,
  viewportHeight,
}: {
  readonly columnCount: number;
  readonly itemCount: number;
  readonly rowHeight: number;
  readonly scrollMargin: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
}) {
  const rowCount = Math.ceil(itemCount / columnCount);
  const localScrollTop = Math.max(0, scrollTop - scrollMargin);
  const firstVisibleRow = Math.min(
    Math.max(0, rowCount - 1),
    Math.floor(localScrollTop / rowHeight),
  );
  const visibleRowCount = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const startRow = Math.max(0, firstVisibleRow - ARTIFACT_GRID_OVERSCAN_ROWS);
  const endRow = Math.min(
    rowCount,
    firstVisibleRow + visibleRowCount + ARTIFACT_GRID_OVERSCAN_ROWS,
  );

  return {
    endIndex: Math.min(itemCount, endRow * columnCount),
    startIndex: startRow * columnCount,
    startOffset: startRow * rowHeight,
    totalHeight:
      rowCount === 0 ? 0 : rowCount * rowHeight - ARTIFACT_GRID_GAP_PX,
  };
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

function ArtifactsEmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-12 text-center">
      <img
        src={emptyArtifactImg}
        alt=""
        role="presentation"
        loading="lazy"
        className="mx-auto h-24 w-24 object-contain opacity-80"
      />
      <h2 className="mt-4 text-sm font-medium text-foreground">
        No artifacts found
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        Artifacts will appear here when they are available.
      </p>
    </div>
  );
}

function ArtifactsKeyboardContinuation({
  onFocus,
}: {
  readonly onFocus: () => void;
}) {
  return (
    <button
      type="button"
      className="sr-only focus:not-sr-only focus:absolute focus:left-0 focus:top-full focus:z-10 focus:mt-2 focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:text-foreground focus:shadow-sm"
      onFocus={onFocus}
    >
      Continue browsing artifacts
    </button>
  );
}

function createArtifactsKeyboardNavigation({
  artifactsLength,
  columnCount,
  endIndex,
  onLoadMore,
  requestKeyboardFocus,
  rowHeight,
  scrollMargin,
  scrollViewport,
  startIndex,
  syncScrollMetrics,
  windowedLength,
}: {
  readonly artifactsLength: number;
  readonly columnCount: number;
  readonly endIndex: number;
  readonly onLoadMore: () => void;
  readonly requestKeyboardFocus: (index: number) => void;
  readonly rowHeight: number;
  readonly scrollMargin: number;
  readonly scrollViewport: HTMLElement | null;
  readonly startIndex: number;
  readonly syncScrollMetrics: (viewport: HTMLElement) => void;
  readonly windowedLength: number;
}) {
  const scrollToIndex = (index: number) => {
    if (!scrollViewport) {
      return;
    }
    const row = Math.floor(index / columnCount);
    scrollViewport.scrollTop = scrollMargin + row * rowHeight;
    syncScrollMetrics(scrollViewport);
  };

  const continueForward = () => {
    const nextIndex = endIndex < windowedLength ? endIndex : windowedLength;
    if (nextIndex >= artifactsLength) {
      return;
    }
    requestKeyboardFocus(nextIndex);
    if (nextIndex >= windowedLength) {
      onLoadMore();
    }
    scrollToIndex(nextIndex);
  };

  const handleBackward = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== "Tab" ||
      !event.shiftKey ||
      startIndex === 0 ||
      !scrollViewport
    ) {
      return;
    }
    const firstMountedArtifact = event.currentTarget.querySelector<HTMLElement>(
      `[data-artifact-index="${startIndex}"]`,
    );
    if (
      !firstMountedArtifact ||
      event.target !== getArtifactFocusTarget(firstMountedArtifact)
    ) {
      return;
    }
    event.preventDefault();
    requestKeyboardFocus(startIndex - 1);
    scrollToIndex(startIndex - 1);
  };

  return { continueForward, handleBackward };
}

function ArtifactsList({
  artifacts,
  loading,
  error,
  visibleCount,
  onLoadMore,
  onOpenChat,
  onOpenPreview,
  onStartChat,
  onToggleFavorite,
  favoriteActionEnabled,
  showFavoriteAction,
}: {
  readonly artifacts: readonly ArtifactPageItem[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly visibleCount: number;
  readonly onLoadMore: () => void;
  readonly onOpenChat: (threadId: string) => void;
  readonly onOpenPreview: (item: ArtifactItem) => void;
  readonly onStartChat: (item: ArtifactItem) => void;
  readonly onToggleFavorite: (item: ArtifactPageItem) => void;
  readonly favoriteActionEnabled: boolean;
  readonly showFavoriteAction: boolean;
}) {
  const scrollViewport = useGet(artifactsScrollViewport$);
  const scrollMetrics = useGet(artifactsScrollMetrics$);
  const gridElement = useGet(artifactsGridElement$);
  const measuredGridWidth = useGet(artifactsGridWidth$);
  const setGridRef = useSet(setArtifactsGridRef$);
  const syncScrollMetrics = useSet(syncArtifactsScrollMetrics$);
  const requestKeyboardFocus = useSet(requestArtifactsKeyboardFocus$);
  const setArtifactCardRef = useSet(setArtifactCardRef$);
  const windowed = artifacts.slice(0, visibleCount);
  const gridWidth =
    measuredGridWidth ||
    gridElement?.clientWidth ||
    ARTIFACT_GRID_FALLBACK_WIDTH_PX;
  const viewportHeight =
    scrollMetrics.clientHeight ||
    scrollViewport?.clientHeight ||
    ARTIFACT_GRID_FALLBACK_VIEWPORT_HEIGHT_PX;
  const scrollTop = scrollMetrics.scrollTop || scrollViewport?.scrollTop || 0;
  const scrollMargin = getArtifactsGridScrollMargin(
    scrollViewport,
    gridElement,
  );
  const { columnCount, rowHeight } = getArtifactGridDimensions(gridWidth);
  const { endIndex, startIndex, startOffset, totalHeight } =
    getVirtualArtifactRange({
      columnCount,
      itemCount: windowed.length,
      rowHeight,
      scrollMargin,
      scrollTop,
      viewportHeight,
    });
  const virtualized = windowed.slice(startIndex, endIndex);
  const hasKeyboardContinuation =
    endIndex < windowed.length || windowed.length < artifacts.length;
  const {
    continueForward: continueKeyboardNavigation,
    handleBackward: handleGridKeyDownCapture,
  } = createArtifactsKeyboardNavigation({
    artifactsLength: artifacts.length,
    columnCount,
    endIndex,
    onLoadMore,
    requestKeyboardFocus,
    rowHeight,
    scrollMargin,
    scrollViewport,
    startIndex,
    syncScrollMetrics,
    windowedLength: windowed.length,
  });

  if (loading) {
    return <ArtifactsLoadingState />;
  }
  if (error) {
    return <ArtifactsErrorState />;
  }
  if (artifacts.length === 0) {
    return <ArtifactsEmptyState />;
  }

  return (
    <div
      ref={setGridRef}
      onKeyDownCapture={handleGridKeyDownCapture}
      className="relative w-full"
      data-testid="artifacts-virtual-grid"
      style={{ height: totalHeight }}
    >
      <div
        className="absolute left-0 top-0 grid w-full gap-3"
        data-testid="artifacts-virtual-grid-items"
        style={{
          gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
          transform: `translateY(${startOffset}px)`,
        }}
      >
        {virtualized.map((artifact, visibleOffset) => {
          const index = startIndex + visibleOffset;
          return (
            <ArtifactCard
              key={artifact.artifactItemId}
              cardRef={setArtifactCardRef}
              favoriteActionEnabled={favoriteActionEnabled}
              index={index}
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
      {hasKeyboardContinuation && (
        <ArtifactsKeyboardContinuation onFocus={continueKeyboardNavigation} />
      )}
    </div>
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
  const setScrollViewportRef = useSet(setArtifactsScrollViewportRef$);
  const syncScrollMetrics = useSet(syncArtifactsScrollMetrics$);
  const openArtifactPreview = useOpenArtifactPreview();
  const lightboxUrl = useGet(lightboxUrl$);
  const remoteLoadable = useLastLoadable(remoteArtifacts$);
  const cachedLoadable = useLastLoadable(cachedArtifacts$);
  const favoriteUrlsLoadable = useLastLoadable(remoteArtifactFavoriteUrls$);
  const agents = useLastResolved(agents$) ?? [];
  const features = useLastResolved(featureSwitch$);
  const artifactFavoritesEnabled =
    features?.[FeatureSwitchKey.ArtifactFavorites] ?? false;
  const favoriteUrls =
    favoriteUrlsLoadable.state === "hasData" ? favoriteUrlsLoadable.data : null;
  const artifactFavoritesReady =
    artifactFavoritesEnabled && favoriteUrls !== null;
  const remoteData =
    remoteLoadable.state === "hasData" ? remoteLoadable.data : null;
  const cachedData =
    cachedLoadable.state === "hasData" ? cachedLoadable.data : null;
  // Keep the bounded cache visible while incremental pages arrive. A full
  // remote snapshot replaces it; an incremental response merges into it until
  // the background sync has rebuilt the complete local snapshot.
  const sourceData = mergeArtifactSources(
    cachedData?.artifacts ?? [],
    remoteData,
  );
  const sourceArtifacts = applyArtifactFavorites(
    sourceData,
    favoriteUrls,
    favoriteOverrides,
  );
  const artifacts = filterArtifacts(sourceArtifacts, {
    search,
    agentId: selectedAgentId,
    category: selectedCategory,
    favoritesOnly: artifactFavoritesReady && favoritesOnly,
  });
  // Drive first-paint loading / error off the source set (not the filtered
  // view, which is legitimately empty when a filter matches nothing).
  const nothingCached = sourceArtifacts.length === 0;
  const cachePending = cachedLoadable.state === "loading";
  const remotePending = remoteLoadable.state === "loading";
  const remoteStillNeedsCache =
    remotePending ||
    remoteLoadable.state === "hasError" ||
    remoteData?.mergeCachedArtifacts === true;
  const loading =
    nothingCached && (remotePending || (cachePending && remoteStillNeedsCache));
  const error = nothingCached && remoteLoadable.state === "hasError";
  const handleScroll = (event: ReactUIEvent<HTMLElement>) => {
    const viewport = event.currentTarget;
    syncScrollMetrics(viewport);
    if (visibleCount >= artifacts.length) {
      return;
    }
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom <= ARTIFACT_AUTO_LOAD_THRESHOLD_PX) {
      loadMore();
    }
  };

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
              Browse files from this organization.
            </p>
          </div>
        </div>
      </header>

      <main
        ref={setScrollViewportRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto px-4 pb-8 pt-3 sm:px-6 [scrollbar-gutter:stable]"
      >
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-4">
          <ArtifactsToolbar
            search={search}
            selectedAgentId={selectedAgentId}
            selectedCategory={selectedCategory}
            favoritesOnly={artifactFavoritesReady && favoritesOnly}
            showFavoritesFilter={artifactFavoritesReady}
            agents={agents}
            onSearchChange={setSearch}
            onAgentChange={setSelectedAgentId}
            onCategoryChange={setSelectedCategory}
            onFavoritesOnlyChange={setFavoritesOnly}
          />
          <ArtifactsList
            artifacts={artifacts}
            favoriteActionEnabled={artifactFavoritesReady}
            loading={loading}
            error={error}
            visibleCount={visibleCount}
            onLoadMore={loadMore}
            onOpenChat={openChat}
            onOpenPreview={openArtifactPreview}
            onStartChat={(item) => {
              detach(startChat(item, pageSignal), Reason.DomCallback);
            }}
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
