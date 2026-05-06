import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  IconAlertCircle,
  IconHandStop,
  IconPhoto,
  IconChartLine,
  IconPlayerStop,
  IconCopy,
  IconCheck,
  IconDots,
  IconPin,
  IconVolume2,
  IconArrowBarToUp,
  IconBrandGoogleDrive,
  IconDownload,
  IconEye,
  IconFile,
  IconLink,
  IconLoader2,
  IconPackage,
} from "@tabler/icons-react";
import {
  cn,
  isEditableTarget,
  matchShortcut,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import type { ChatThreadArtifactFile } from "@vm0/api-contracts/contracts/chat-threads";
import emptyChatImg from "./assets/empty-chat.webp";
import emptyArtifactImg from "./assets/empty-artifact.webp";
import docAudioIcon from "./assets/doc-audio.svg";
import docCsvIcon from "./assets/doc-csv.svg";
import docDocIcon from "./assets/doc-doc.svg";
import docHtmlIcon from "./assets/doc-html.svg";
import docJsonIcon from "./assets/doc-json.svg";
import docPdfIcon from "./assets/doc-pdf.svg";
import docTxtIcon from "./assets/doc-txt.svg";
import docVideoIcon from "./assets/doc-video.svg";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { playTts$, stopTts$ } from "../../signals/voice-io/voice-io-tts.ts";
import {
  autoReadEnabled$,
  toggleAutoRead$,
} from "../../signals/voice-io/voice-io-settings.ts";
import { Markdown } from "../components/markdown.tsx";
import { detach, Reason, onDomEventFn } from "../../signals/utils.ts";
import { zeroClient$ } from "../../signals/api-client.ts";
import {
  AttachmentLightbox,
  downloadAttachmentUrl,
  FileAttachmentChip,
  getAttachmentRawUrl,
  PreviewableFileAttachmentChip,
} from "./zero-attachment-chips.tsx";
import {
  classifyChatAttachment,
  contentTypeForBodyPreviewKind,
  enrichBlocksWithTextPreviews,
  parseBodyRenderBlocks,
  type BodyRenderBlock,
} from "../../signals/chat-page/parse-body-blocks.ts";
import { AttachmentPreview } from "./zero-attachment-preview.tsx";
import {
  lightboxUrl$ as attachmentLightboxUrl$,
  openImageLightbox$ as openAttachmentImageLightbox$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import {
  writeToClipboard,
  type ChatClipboardAttachment,
} from "../../signals/zero-page/clipboard.ts";
import { connectors$ } from "../../signals/external/connectors.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  chatShortcutHelpOpen$,
  setChatShortcutHelpOpen$,
} from "../../signals/chat-page/chat-shortcut-help.ts";
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
import { ShortcutHelpDialog } from "../components/shortcut-help-dialog.tsx";

import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
  PagedChatMessage,
} from "../../signals/chat-page/chat-message.ts";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";
import type { ChatThread } from "../../signals/agent-chat.ts";
import { ATTACH_ONLY_PLACEHOLDER } from "../../signals/chat-page/resolve-draft-attachments.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  imageLoadStatusByKey$,
  imageLoadStatusRef$,
  setImageLoadStatus$,
} from "../../signals/view-component-state.ts";
import {
  currentLeftThread$,
  currentRightThread$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import {
  navigateToAdjacentThread$,
  scrollCurrentThread$,
} from "../../signals/chat-page/chat-keyboard.ts";
import { sidebarChatThreads$ } from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import {
  type ArtifactGoogleDriveSyncFile,
  syncArtifactFilesToGoogleDrive,
  syncArtifactFileToGoogleDrive,
  waitForGoogleDriveAndSyncArtifacts$,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import { apiBaseForNavigation$ } from "../../signals/fetch.ts";
import { createZipBlob } from "../../lib/zip.ts";

const CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP =
  "Connect Google Drive to upload artifacts";

const CHAT_SHORTCUT_SECTIONS = [
  {
    title: "Global",
    shortcuts: [
      { key: "shift+/", label: "Show shortcuts" },
      { key: "mod+b", label: "Toggle sidebar" },
    ],
  },
  {
    title: "Messages",
    shortcuts: [
      { key: "mod+arrowup", label: "Scroll to top" },
      { key: "mod+arrowdown", label: "Scroll to bottom" },
      { key: "mod+shift+arrowup", label: "Previous thread" },
      { key: "mod+shift+arrowdown", label: "Next thread" },
    ],
  },
  {
    title: "Composer",
    shortcuts: [
      { key: "enter", label: "Send message" },
      { key: "escape", label: "Blur composer" },
      { key: "mod+alt+.", label: "Switch model" },
    ],
  },
] as const;

function HeaderAgentAvatar({ thread }: { thread: ChatThreadSignals }) {
  const agentId = useLastResolved(thread.agentId$);

  if (!agentId) {
    return <Skeleton className="h-8 w-8 rounded-xl" />;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            pathname="/agents/:agentId"
            options={{ pathParams: { agentId } }}
            className="h-8 w-8 shrink-0 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="View agent profile"
          >
            <AgentAvatarImg
              name={agentId}
              alt=""
              className="h-8 w-8 rounded-full object-cover object-top"
            />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">View agent profile</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PinPillButton({ thread }: { thread: ChatThreadSignals }) {
  const pageSignal = useGet(pageSignal$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const pinnedStatus = useLastResolved(thread.agentPinned$);
  const showPinPill = pinnedStatus === false;
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const pinSaving = pinLoadable.state === "loading";
  const agentId = useLastResolved(thread.agentId$) ?? null;

  if (!showPinPill) {
    return null;
  }

  const handlePin = () => {
    if (!agentId) {
      return;
    }
    detach(
      savePinnedIds([...pinnedIds, agentId], pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePin}
            disabled={pinSaving}
            className="absolute -top-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full zero-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground hover:shadow-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Pin to sidebar"
          >
            <IconPin size={10} stroke={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Pin to sidebar</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArtifactsButton({ thread }: { thread: ChatThreadSignals }) {
  return <ArtifactsButtonInner thread={thread} />;
}

function ArtifactsButtonInner({ thread }: { thread: ChatThreadSignals }) {
  const open = useGet(thread.artifactsDrawerOpen$);
  const setOpen = useSet(thread.setArtifactsDrawerOpen$);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
              open
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
            )}
            aria-label="Open artifacts"
            aria-pressed={open}
          >
            <IconPackage size={17} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open artifacts</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ChatThreadHeader({ thread }: { thread: ChatThreadSignals }) {
  const displayName = useLastResolved(thread.agentDisplayName$);
  const threadData = useLastResolved(thread.threadData$);
  const rightThread = useGet(currentRightThread$);
  const autoRead = useGet(autoReadEnabled$);
  const toggleAutoReadFn = useSet(toggleAutoRead$);
  const features = useLastResolved(featureSwitch$);
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;
  const threadTitle = threadData?.title?.trim() ?? "";
  const showThreadTitle = rightThread !== null && threadTitle.length > 0;

  return (
    <header className="hidden sm:flex shrink-0 bg-transparent px-6 py-3 items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <HeaderAgentAvatar thread={thread} />
          <PinPillButton thread={thread} />
        </div>
        <span className="flex min-w-0 items-baseline gap-2">
          {displayName ? (
            <span className="shrink-0 font-semibold text-foreground">
              {displayName}
            </span>
          ) : (
            <Skeleton className="h-5 w-32 shrink-0 rounded" />
          )}
          {showThreadTitle && (
            <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
              {threadTitle}
            </span>
          )}
        </span>
      </div>
      <div className="hidden sm:flex items-center gap-0.5">
        <ArtifactsButton thread={thread} />
        {audioOutputEnabled && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    toggleAutoReadFn();
                  }}
                  className={cn(
                    "p-1.5 rounded-md transition-colors duration-150",
                    autoRead
                      ? "text-primary bg-primary/10"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-accent",
                  )}
                  aria-label="Toggle auto-read"
                  aria-pressed={autoRead}
                >
                  <IconVolume2 size={18} stroke={1.5} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {autoRead ? "Auto-read on" : "Auto-read off"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </header>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!;
    if (value < 1024 || i === units.length - 1) {
      return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    }
    value = value / 1024;
  }
  return `${bytes} B`;
}

function formatArtifactTime(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type ChatArtifactItem = {
  runId: string;
  file: ChatThreadArtifactFile;
};

type ArtifactPreviewKind = "image" | "video" | "audio" | "document" | "file";

function artifactItemKey(item: ChatArtifactItem): string {
  return `${item.runId}:${item.file.id}:${item.file.url}`;
}

function getFileExtension(filename: string): string {
  const ext = filename.split(".").pop();
  return ext && ext !== filename ? ext.toUpperCase() : "FILE";
}

function getArtifactPreviewKind(
  file: ChatThreadArtifactFile,
): ArtifactPreviewKind {
  const contentType = file.contentType.toLowerCase();
  const filename = file.filename.toLowerCase();

  if (contentType.startsWith("image/") || isImageFilename(filename)) {
    return "image";
  }
  if (contentType.startsWith("video/") || isVideoFilename(filename)) {
    return "video";
  }
  if (contentType.startsWith("audio/") || isAudioFilename(filename)) {
    return "audio";
  }
  if (
    contentType === "application/pdf" ||
    contentType === "application/json" ||
    contentType === "text/csv" ||
    (contentType.startsWith("text/") && contentType !== "text/html") ||
    /\.(pdf|txt|md|csv|json|log)$/i.test(filename)
  ) {
    return "document";
  }
  return "file";
}

function flattenArtifactRuns(
  runs: { runId: string; files: ChatThreadArtifactFile[] }[],
): ChatArtifactItem[] {
  return runs.flatMap((run) => {
    return run.files.map((file) => {
      return { runId: run.runId, file };
    });
  });
}

function getArtifactFileIconSrc(file: ChatThreadArtifactFile): string | null {
  const kind = classifyChatAttachment({
    filename: file.filename,
    url: file.url,
    contentType: file.contentType,
  });

  if (kind === "pdf") {
    return docPdfIcon;
  }
  if (kind === "html") {
    return docHtmlIcon;
  }
  if (kind === "csv") {
    return docCsvIcon;
  }
  if (kind === "json") {
    return docJsonIcon;
  }
  if (kind === "text") {
    return docTxtIcon;
  }
  if (kind === "markdown") {
    return docDocIcon;
  }
  if (kind === "video") {
    return docVideoIcon;
  }
  if (kind === "audio") {
    return docAudioIcon;
  }
  return null;
}

function ArtifactFileIcon({
  file,
  className,
}: {
  file: ChatThreadArtifactFile;
  className?: string;
}) {
  const iconSrc = getArtifactFileIconSrc(file);
  if (iconSrc) {
    return (
      <img
        alt=""
        aria-hidden="true"
        src={iconSrc}
        className={cn("h-5 w-5 object-contain opacity-90", className)}
      />
    );
  }

  const previewKind = getArtifactPreviewKind(file);
  if (previewKind === "image") {
    return <IconPhoto size={18} stroke={1.5} />;
  }
  return <IconFile size={18} stroke={1.5} />;
}

function ArtifactPreviewBadge({ file }: { file: ChatThreadArtifactFile }) {
  if (getArtifactPreviewKind(file) === "image") {
    return (
      <img
        src={file.url}
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
      />
    );
  }

  return <ArtifactFileIcon file={file} />;
}

async function copyArtifactLinkToClipboard(
  file: ChatThreadArtifactFile,
): Promise<void> {
  const copied = await writeToClipboard(file.url);
  if (copied) {
    toast.success("Link copied");
    return;
  }
  toast.error("Failed to copy link");
}

async function downloadArtifactItemsAsZip(params: {
  readonly items: readonly ChatArtifactItem[];
  readonly signal: AbortSignal;
  readonly threadId: string;
}): Promise<void> {
  const toastId = toast.loading(`Preparing ${params.items.length} files...`);
  // eslint-disable-next-line no-restricted-syntax -- zip download must replace the loading toast on success or failure
  try {
    const entries = await Promise.all(
      params.items.map((item) => {
        return fetchArtifactZipEntry(item, params.signal);
      }),
    );
    const zip = createZipBlob(entries);
    triggerArtifactZipDownload(zip, `vm0-artifact-${params.threadId}.zip`);
    toast.success("Downloaded artifacts", { id: toastId });
  } catch (error) {
    params.signal.throwIfAborted();
    toast.error(
      error instanceof Error
        ? error.message
        : "Failed to prepare artifact download",
      { id: toastId },
    );
  }
}

async function fetchArtifactZipEntry(
  item: ChatArtifactItem,
  signal: AbortSignal,
): Promise<{
  readonly filename: string;
  readonly data: ArrayBuffer;
  readonly modifiedAt: Date;
}> {
  const response = await fetch(getAttachmentRawUrl(item.file.url), {
    mode: "cors",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${item.file.filename}`);
  }
  const data = await response.arrayBuffer();
  return {
    filename: item.file.filename,
    data,
    modifiedAt: new Date(item.file.createdAt),
  };
}

function triggerArtifactZipDownload(blob: Blob, filename: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

function artifactItemsToGoogleDriveFiles(
  items: readonly ChatArtifactItem[],
): ArtifactGoogleDriveSyncFile[] {
  return items.map((item) => {
    return {
      runId: item.runId,
      fileId: item.file.id,
      filename: item.file.filename,
    };
  });
}

function isArtifactSyncedToGoogleDrive(item: ChatArtifactItem): boolean {
  return item.file.googleDriveSync?.status === "synced";
}

type WaitForGoogleDriveAndSyncArtifactsFn = (
  params: {
    readonly agentId: string;
    readonly threadId: string;
    readonly files: readonly ArtifactGoogleDriveSyncFile[];
  },
  signal: AbortSignal,
) => Promise<unknown>;

function startGoogleDriveConnectAndSync(params: {
  agentId: string | null | undefined;
  apiBase: string | null | undefined;
  files: readonly ArtifactGoogleDriveSyncFile[];
  pageSignal: AbortSignal;
  threadId: string;
  waitForGoogleDriveAndSyncArtifacts: WaitForGoogleDriveAndSyncArtifactsFn;
  onSyncComplete: () => void;
}): void {
  if (params.files.length === 0) {
    return;
  }
  if (!params.agentId) {
    toast.error("Agent is still loading");
    return;
  }
  if (!params.apiBase) {
    toast.error("Google Drive connection page is still loading");
    return;
  }
  const agentId = params.agentId;
  detach(
    (async () => {
      await params.waitForGoogleDriveAndSyncArtifacts(
        {
          agentId,
          threadId: params.threadId,
          files: params.files,
        },
        params.pageSignal,
      );
      params.onSyncComplete();
    })(),
    Reason.DomCallback,
    "artifact google drive connect sync",
  );
  const authWindow = window.open(
    `${params.apiBase}/api/zero/connectors/google-drive/authorize`,
    "_blank",
  );
  if (!authWindow) {
    toast.error("Failed to open Google Drive connection page");
  }
}

function syncArtifactFilesAndRefresh(params: {
  sync: Promise<boolean>;
  onSyncSuccess: () => void;
  reason: string;
}): void {
  detach(
    (async () => {
      const success = await params.sync;
      if (success) {
        params.onSyncSuccess();
      }
    })(),
    Reason.DomCallback,
    params.reason,
  );
}

function ArtifactGoogleDriveConnectMenuItem({
  agentId,
  files,
  label,
  onSyncComplete,
  threadId,
}: {
  agentId: string | null | undefined;
  files: readonly ArtifactGoogleDriveSyncFile[];
  label: string;
  onSyncComplete: () => void;
  threadId: string;
}) {
  const waitForGoogleDriveAndSyncArtifacts = useSet(
    waitForGoogleDriveAndSyncArtifacts$,
  );
  const apiBase = useLastResolved(apiBaseForNavigation$);
  const pageSignal = useGet(pageSignal$);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuItem
            className="text-muted-foreground"
            title={CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP}
            onClick={() => {
              startGoogleDriveConnectAndSync({
                agentId,
                apiBase,
                files,
                pageSignal,
                threadId,
                waitForGoogleDriveAndSyncArtifacts,
                onSyncComplete,
              });
            }}
          >
            <IconBrandGoogleDrive size={14} stroke={1.5} />
            {label}
          </DropdownMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left">
          {CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArtifactPreviewIconButton({
  ariaLabel,
  children,
  disabled = false,
  onClick,
  tooltip,
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  tooltip: string;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-disabled={disabled}
            aria-label={ariaLabel}
            onClick={() => {
              if (!disabled) {
                onClick();
              }
            }}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              disabled &&
                "cursor-not-allowed opacity-45 hover:bg-transparent hover:text-muted-foreground",
            )}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ArtifactPreviewActions({
  item,
  googleDriveConnected,
  agentId,
  threadId,
  onSyncSuccess,
}: {
  item: ChatArtifactItem;
  googleDriveConnected: boolean;
  agentId: string | null | undefined;
  threadId: string;
  onSyncSuccess: () => void;
}) {
  const createClient = useGet(zeroClient$);
  const waitForGoogleDriveAndSyncArtifacts = useSet(
    waitForGoogleDriveAndSyncArtifacts$,
  );
  const apiBase = useLastResolved(apiBaseForNavigation$);
  const pageSignal = useGet(pageSignal$);
  const { file } = item;
  const synced = isArtifactSyncedToGoogleDrive(item);
  const syncTooltip = synced
    ? "Synced to Google Drive"
    : googleDriveConnected
      ? "Sync to Google Drive"
      : CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP;
  const syncAriaLabel = synced
    ? `${file.filename} is synced to Google Drive`
    : `Sync ${file.filename} to Google Drive`;

  return (
    <div className="flex shrink-0 items-center gap-1">
      <ArtifactPreviewIconButton
        ariaLabel={`Copy link for ${file.filename}`}
        tooltip="Copy link"
        onClick={() => {
          detach(
            copyArtifactLinkToClipboard(file),
            Reason.DomCallback,
            "artifact copy link",
          );
        }}
      >
        <IconLink size={16} stroke={1.5} />
      </ArtifactPreviewIconButton>
      <ArtifactPreviewIconButton
        ariaLabel={`Download ${file.filename}`}
        tooltip="Download"
        onClick={() => {
          detach(
            downloadAttachmentUrl(file.url, pageSignal, file.filename),
            Reason.DomCallback,
            "artifact download",
          );
        }}
      >
        <IconDownload size={16} stroke={1.5} />
      </ArtifactPreviewIconButton>
      <ArtifactPreviewIconButton
        ariaLabel={syncAriaLabel}
        disabled={synced}
        tooltip={syncTooltip}
        onClick={() => {
          if (googleDriveConnected) {
            syncArtifactFilesAndRefresh({
              sync: syncArtifactFileToGoogleDrive({
                createClient,
                threadId,
                runId: item.runId,
                fileId: item.file.id,
                filename: item.file.filename,
                signal: pageSignal,
              }),
              onSyncSuccess,
              reason: "artifact google drive sync",
            });
            return;
          }
          startGoogleDriveConnectAndSync({
            agentId,
            apiBase,
            files: artifactItemsToGoogleDriveFiles([item]),
            pageSignal,
            threadId,
            waitForGoogleDriveAndSyncArtifacts,
            onSyncComplete: onSyncSuccess,
          });
        }}
      >
        <IconBrandGoogleDrive size={16} stroke={1.5} />
      </ArtifactPreviewIconButton>
    </div>
  );
}

function ArtifactBulkActionsMenu({
  items,
  googleDriveConnected,
  agentId,
  onSyncSuccess,
  threadId,
}: {
  items: readonly ChatArtifactItem[];
  googleDriveConnected: boolean;
  agentId: string | null | undefined;
  onSyncSuccess: () => void;
  threadId: string;
}) {
  const createClient = useGet(zeroClient$);
  const pageSignal = useGet(pageSignal$);
  const syncableItems = items.filter((item) => {
    return !isArtifactSyncedToGoogleDrive(item);
  });
  const files = artifactItemsToGoogleDriveFiles(syncableItems);
  const allSynced = items.length > 0 && files.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="More artifact actions"
        >
          <IconDots size={15} stroke={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem
          onClick={() => {
            detach(
              downloadArtifactItemsAsZip({
                items,
                signal: pageSignal,
                threadId,
              }),
              Reason.DomCallback,
              "artifact download all",
            );
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          Download all
        </DropdownMenuItem>
        {googleDriveConnected ? (
          <DropdownMenuItem
            disabled={allSynced}
            onClick={() => {
              syncArtifactFilesAndRefresh({
                sync: syncArtifactFilesToGoogleDrive({
                  createClient,
                  threadId,
                  files,
                  signal: pageSignal,
                }),
                onSyncSuccess,
                reason: "artifact google drive sync all",
              });
            }}
          >
            <IconBrandGoogleDrive size={14} stroke={1.5} />
            {allSynced
              ? "Synced all to Google Drive"
              : "Sync all to Google Drive"}
          </DropdownMenuItem>
        ) : (
          <ArtifactGoogleDriveConnectMenuItem
            agentId={agentId}
            files={files}
            label="Sync all to Google Drive"
            onSyncComplete={onSyncSuccess}
            threadId={threadId}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ChatImagePreviewButtonProps = {
  alt: string;
  ariaLabel: string;
  buttonClassName: string;
  imageClassName: string;
  onPreview: () => void;
  overlayIcon?: "eye" | "photo";
  placeholderClassName: string;
  url: string;
};

function ChatImagePreviewButton({
  alt,
  ariaLabel,
  buttonClassName,
  imageClassName,
  onPreview,
  overlayIcon = "photo",
  placeholderClassName,
  url,
}: ChatImagePreviewButtonProps) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageLoadKey = `chat-image-preview:${url}`;
  const imageStatus = imageLoadStatuses[imageLoadKey] ?? "loading";

  const showPlaceholder = imageStatus !== "loaded";

  return (
    <button
      type="button"
      onClick={onPreview}
      className={cn(
        "group/image-preview relative overflow-hidden",
        buttonClassName,
      )}
      aria-label={ariaLabel}
    >
      {showPlaceholder && (
        <span
          data-testid="chat-image-preview-loading"
          className={cn(
            "flex items-center justify-center bg-muted/70 text-muted-foreground",
            placeholderClassName,
          )}
        >
          {imageStatus === "loading" ? (
            <IconLoader2 size={18} stroke={1.8} className="animate-spin" />
          ) : (
            <IconPhoto size={18} stroke={1.5} />
          )}
        </span>
      )}
      <img
        key={imageLoadKey}
        ref={imageLoadStatusRef}
        src={url}
        alt={alt}
        data-image-load-key={imageLoadKey}
        loading="lazy"
        onLoad={() => {
          setImageLoadStatus(imageLoadKey, "loaded");
        }}
        onError={() => {
          setImageLoadStatus(imageLoadKey, "error");
        }}
        className={cn(
          imageClassName,
          showPlaceholder && "absolute inset-0 opacity-0",
        )}
      />
      <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-150 group-hover/image-preview:bg-black/30 group-hover/image-preview:opacity-100">
        {overlayIcon === "eye" ? (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white shadow-lg">
            <IconEye size={18} stroke={1.8} />
          </span>
        ) : (
          <IconPhoto
            size={18}
            className="text-white opacity-0 drop-shadow transition-opacity group-hover/image-preview:opacity-100"
          />
        )}
      </span>
    </button>
  );
}

function ArtifactPreviewFrame({ file }: { file: ChatThreadArtifactFile }) {
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const previewKind = getArtifactPreviewKind(file);

  if (previewKind === "image") {
    return (
      <ChatImagePreviewButton
        alt={`Preview ${file.filename}`}
        ariaLabel={`Preview ${file.filename}`}
        buttonClassName="flex h-full w-full items-center justify-center bg-muted"
        imageClassName="h-full w-full object-contain"
        onPreview={() => {
          openImageLightbox(file.url);
        }}
        overlayIcon="eye"
        placeholderClassName="h-full w-full"
        url={file.url}
      />
    );
  }

  if (previewKind === "video") {
    return (
      <video
        src={file.url}
        controls
        preload="metadata"
        className="h-full w-full bg-black object-contain"
      />
    );
  }

  if (previewKind === "audio") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/40 px-8">
        <audio
          src={file.url}
          controls
          preload="metadata"
          className="w-full max-w-[480px]"
          aria-label={`Audio preview for ${file.filename}`}
        />
      </div>
    );
  }

  if (previewKind === "document") {
    return (
      <iframe
        src={file.url}
        title={`Preview ${file.filename}`}
        className="h-full w-full bg-background"
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/40 p-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-lg border border-border/70 bg-background text-muted-foreground shadow-sm">
        <ArtifactFileIcon file={file} className="h-10 w-10" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          {getFileExtension(file.filename)}
        </p>
        <p className="mt-1 max-w-[260px] truncate text-sm text-foreground">
          {file.filename}
        </p>
      </div>
    </div>
  );
}

function ArtifactPreviewPanel({
  item,
  googleDriveConnected,
  agentId,
  onSyncSuccess,
  threadId,
}: {
  item: ChatArtifactItem;
  googleDriveConnected: boolean;
  agentId: string | null | undefined;
  onSyncSuccess: () => void;
  threadId: string;
}) {
  const { file } = item;

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-background shadow-sm">
      <div className="h-[260px] border-b border-border/60 bg-muted/30">
        <ArtifactPreviewFrame file={file} />
      </div>
      <div className="flex items-start gap-3 px-3 py-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          <ArtifactPreviewBadge file={file} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {file.filename}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{formatBytes(file.size)}</span>
            <span aria-hidden>·</span>
            <span>{getFileExtension(file.filename)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ArtifactPreviewActions
            item={item}
            googleDriveConnected={googleDriveConnected}
            agentId={agentId}
            threadId={threadId}
            onSyncSuccess={onSyncSuccess}
          />
        </div>
      </div>
    </div>
  );
}

function ArtifactThumbnail({
  file,
  selected,
}: {
  file: ChatThreadArtifactFile;
  selected: boolean;
}) {
  const previewKind = getArtifactPreviewKind(file);

  return (
    <div
      className={cn(
        "relative flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/60 transition-colors",
        selected
          ? "border-primary/60 ring-2 ring-primary/15"
          : "border-border/70 hover:border-foreground/25",
      )}
      aria-hidden="true"
    >
      {previewKind === "image" ? (
        <ArtifactThumbnailImage url={file.url} />
      ) : (
        <span className="flex flex-col items-center gap-0.5 text-muted-foreground">
          <ArtifactFileIcon file={file} />
          <span className="max-w-14 truncate text-[10px] font-medium">
            {getFileExtension(file.filename)}
          </span>
        </span>
      )}
    </div>
  );
}

function ArtifactThumbnailImage({ url }: { url: string }) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageLoadKey = `artifact-thumbnail:${url}`;
  const imageStatus = imageLoadStatuses[imageLoadKey] ?? "loading";

  const showPlaceholder = imageStatus !== "loaded";

  return (
    <>
      {showPlaceholder && (
        <span className="flex h-full w-full items-center justify-center bg-muted/70 text-muted-foreground">
          {imageStatus === "loading" ? (
            <IconLoader2 size={14} stroke={1.8} className="animate-spin" />
          ) : (
            <IconPhoto size={14} stroke={1.5} />
          )}
        </span>
      )}
      <img
        key={imageLoadKey}
        ref={imageLoadStatusRef}
        src={url}
        alt=""
        data-image-load-key={imageLoadKey}
        loading="lazy"
        onLoad={() => {
          setImageLoadStatus(imageLoadKey, "loaded");
        }}
        onError={() => {
          setImageLoadStatus(imageLoadKey, "error");
        }}
        className={cn(
          "h-full w-full object-cover",
          showPlaceholder && "absolute inset-0 opacity-0",
        )}
        aria-hidden="true"
      />
    </>
  );
}

function ArtifactFileRow({
  item,
  selected,
  onPreview,
}: {
  item: ChatArtifactItem;
  selected: boolean;
  onPreview: () => void;
}) {
  const { file } = item;

  return (
    <div
      className={cn(
        "flex rounded-lg border transition-colors",
        selected
          ? "border-primary/40 bg-primary/5"
          : "border-border/60 bg-background/70 hover:bg-muted/25",
      )}
    >
      <button
        type="button"
        onClick={onPreview}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-label={`Select ${file.filename}`}
      >
        <ArtifactThumbnail file={file} selected={selected} />
        <div className="min-w-0 flex-1">
          <span
            className="block max-w-full truncate text-sm font-medium text-foreground"
            title={file.filename}
          >
            {file.filename}
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{formatBytes(file.size)}</span>
            <span aria-hidden>·</span>
            <span>{getFileExtension(file.filename)}</span>
            <span aria-hidden>·</span>
            <span>{formatArtifactTime(file.createdAt)}</span>
          </div>
        </div>
      </button>
    </div>
  );
}

function ChatArtifactsDrawerContent({ thread }: { thread: ChatThreadSignals }) {
  const loadable = useLastLoadable(thread.artifacts$);
  const connectorList = useLastResolved(connectors$);
  const agentId = useLastResolved(thread.agentId$);
  const selectedArtifactKey = useGet(thread.artifactPreviewKey$);
  const setSelectedArtifactKey = useSet(thread.setArtifactPreviewKey$);
  const reloadArtifacts = useSet(thread.setArtifactsDrawerOpen$);

  if (loadable.state === "loading") {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, i) => {
          return <Skeleton key={i} className="h-16 rounded-lg" />;
        })}
      </div>
    );
  }

  if (loadable.state === "hasError") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load artifacts
      </div>
    );
  }

  if (loadable.state !== "hasData") {
    return null;
  }

  const runs = loadable.data;
  const items = flattenArtifactRuns(runs);
  const selectedItem =
    items.find((item) => {
      return artifactItemKey(item) === selectedArtifactKey;
    }) ?? items[0];
  const totalFiles = runs.reduce((sum, run) => {
    return sum + run.files.length;
  }, 0);

  if (totalFiles === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/70 p-8 text-center">
        <img
          src={emptyArtifactImg}
          alt=""
          role="presentation"
          loading="lazy"
          className="h-24 w-24 object-contain opacity-80"
        />
        <p className="text-sm text-muted-foreground">
          No uploaded files in this chat yet.
        </p>
      </div>
    );
  }

  const selectedKey = selectedItem ? artifactItemKey(selectedItem) : null;
  const googleDriveConnected =
    connectorList?.connectors.some((connector) => {
      return connector.type === "google-drive" && !connector.needsReconnect;
    }) ?? false;
  const refreshArtifactSyncStatus = () => {
    reloadArtifacts(true);
  };

  return (
    <div className="flex flex-col gap-5">
      {selectedItem && (
        <ArtifactPreviewPanel
          item={selectedItem}
          googleDriveConnected={googleDriveConnected}
          agentId={agentId}
          onSyncSuccess={refreshArtifactSyncStatus}
          threadId={thread.threadId}
        />
      )}
      <div className="flex items-center justify-between border-b border-border/60 pb-3 text-xs text-muted-foreground">
        <span>
          {totalFiles} file{totalFiles === 1 ? "" : "s"}
        </span>
        <ArtifactBulkActionsMenu
          items={items}
          googleDriveConnected={googleDriveConnected}
          agentId={agentId}
          onSyncSuccess={refreshArtifactSyncStatus}
          threadId={thread.threadId}
        />
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => {
          const itemKey = artifactItemKey(item);
          return (
            <ArtifactFileRow
              key={itemKey}
              item={item}
              selected={selectedKey === itemKey}
              onPreview={() => {
                setSelectedArtifactKey(itemKey);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function ChatArtifactsDrawer({ thread }: { thread: ChatThreadSignals }) {
  const open = useGet(thread.artifactsDrawerOpen$);
  const setOpen = useSet(thread.setArtifactsDrawerOpen$);
  const setArtifactsRealtimeRef = useSet(thread.setArtifactsRealtimeRef$);
  const lightboxUrl = useGet(attachmentLightboxUrl$);

  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
      }}
    >
      <SheetContent
        side="right"
        className="w-[420px] sm:max-w-[420px] flex flex-col"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (lightboxUrl) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (lightboxUrl) {
            event.preventDefault();
          }
        }}
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>Artifacts</SheetTitle>
          <SheetDescription>
            Uploaded files from runs in this chat thread.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 overflow-y-auto -mx-6 px-6 -mb-6 pb-6">
          {open && (
            <div ref={setArtifactsRealtimeRef}>
              <ChatArtifactsDrawerContent thread={thread} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

function ChatThread({ thread }: { thread: ChatThreadSignals }) {
  const onKeyDown = useChatThreadKeyDown(thread);

  return (
    <section
      aria-label="Chat thread"
      className="flex min-w-0 basis-0 flex-1 flex-col min-h-0 bg-transparent focus:outline-none"
      data-chat-thread-container-id={thread.threadId}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <ChatThreadContent thread={thread} />
    </section>
  );
}

export function ZeroChatThreadPage() {
  const shortcutHelpOpen = useGet(chatShortcutHelpOpen$);
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const lightboxUrl = useGet(attachmentLightboxUrl$);

  return (
    <>
      <div className="flex flex-1 min-h-0 bg-transparent">
        {leftThread && (
          <ChatThread key={leftThread.threadId} thread={leftThread} />
        )}
        {rightThread && (
          <>
            <div className="w-px shrink-0 bg-border/60" aria-hidden="true" />
            <ChatThread key={rightThread.threadId} thread={rightThread} />
          </>
        )}
      </div>
      {leftThread && <ChatArtifactsDrawer thread={leftThread} />}
      {rightThread && (
        <ChatArtifactsDrawer key={rightThread.threadId} thread={rightThread} />
      )}
      {lightboxUrl && <AttachmentLightbox />}
      <ShortcutHelpDialog
        open={shortcutHelpOpen}
        onOpenChange={setShortcutHelpOpen}
        description="Available shortcuts on this page"
        sections={CHAT_SHORTCUT_SECTIONS}
      />
    </>
  );
}

type LoadableValue<T> =
  | { state: "loading" }
  | { state: "hasData"; data: T }
  | { state: "hasError"; error: unknown };

function resolveSessionError(
  threadDataLoadable: LoadableValue<ChatThread | null>,
  groupsLoadable: LoadableValue<GroupedChatMessageGroup[]>,
): string | null {
  if (threadDataLoadable.state === "hasError") {
    return threadDataLoadable.error instanceof Error
      ? threadDataLoadable.error.message
      : "Failed to load chat";
  }
  if (groupsLoadable.state === "hasError") {
    return groupsLoadable.error instanceof Error
      ? groupsLoadable.error.message
      : "Failed to load messages";
  }
  if (
    threadDataLoadable.state === "hasData" &&
    threadDataLoadable.data === null
  ) {
    return "Chat not found";
  }
  return null;
}

function useChatThreadKeyDown(thread: ChatThreadSignals) {
  const pageSignal = useGet(pageSignal$);
  const scrollCurrentThread = useSet(scrollCurrentThread$);
  const navigateToAdjacentThread = useSet(navigateToAdjacentThread$);
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);
  // Snapshot the sidebar list on the read side so the keyboard command stays
  // sync — awaiting `sidebarChatThreads$` inside the command would block the
  // keypress on whatever async work that signal is currently doing
  // (e.g. an IDB miss + remote refetch).
  const sidebarThreads = useLastResolved(sidebarChatThreads$) ?? [];

  return onDomEventFn(async (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (matchShortcut("mod+arrowup", event)) {
      event.preventDefault();
      scrollCurrentThread(thread, "top");
      return;
    }
    if (matchShortcut("mod+arrowdown", event)) {
      event.preventDefault();
      scrollCurrentThread(thread, "bottom");
      return;
    }
    if (matchShortcut("mod+shift+arrowup", event)) {
      event.preventDefault();
      await navigateToAdjacentThread(
        {
          currentThreadId: thread.threadId,
          direction: "prev",
          threads: sidebarThreads,
        },
        pageSignal,
      );
      return;
    }
    if (matchShortcut("mod+shift+arrowdown", event)) {
      event.preventDefault();
      await navigateToAdjacentThread(
        {
          currentThreadId: thread.threadId,
          direction: "next",
          threads: sidebarThreads,
        },
        pageSignal,
      );
      return;
    }

    if (matchShortcut("shift+/", event) && !isEditableTarget(event.target)) {
      event.preventDefault();
      setShortcutHelpOpen(true);
    }
  });
}

function ChatThreadContent({ thread }: { thread: ChatThreadSignals }) {
  const features = useLastResolved(featureSwitch$);
  const groupsLoadable = useLastLoadable(thread.groupedChatMessages$);
  const hasOlderHistory = useLastResolved(thread.hasOlderHistory$) ?? false;
  const [loadHistoryLoadable, loadHistory] = useLoadableSet(
    thread.loadHistory$,
  );
  const threadDataLoadable = useLastLoadable(thread.threadData$);
  const sessionError = resolveSessionError(threadDataLoadable, groupsLoadable);
  const messagesLoading = groupsLoadable.state === "loading";
  const groups = groupsLoadable.state === "hasData" ? groupsLoadable.data : [];
  const setScrollContainer = useSet(thread.setScrollContainer$);
  const skeletonVisible = useGet(thread.skeletonVisible$);
  const manualHistoryEnabled =
    features?.[FeatureSwitchKey.ChatManualHistory] ?? false;
  const loadingHistory = loadHistoryLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const onLoadHistory = onDomEventFn(() => {
    return loadHistory(pageSignal);
  });

  return (
    <>
      <ChatThreadHeader thread={thread} />

      <div className="flex-1 min-h-0 relative isolate">
        <div
          ref={setScrollContainer}
          data-scroll-container
          className="absolute inset-0 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <main className="px-4 sm:px-6 py-4 items-center @container">
            <div
              data-message-container
              className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4 overflow-visible"
              style={{ visibility: skeletonVisible ? "hidden" : "visible" }}
            >
              {!sessionError &&
                !skeletonVisible &&
                manualHistoryEnabled &&
                hasOlderHistory && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      disabled={loadingHistory}
                      onClick={onLoadHistory}
                      className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Load history
                    </button>
                  </div>
                )}
              {sessionError && (
                <div className="flex-1 flex items-center justify-center py-16">
                  <div className="flex items-center gap-2 text-destructive">
                    <IconAlertCircle size={16} />
                    <p className="text-sm">{sessionError}</p>
                  </div>
                </div>
              )}
              {!sessionError &&
                groups.length === 0 &&
                !messagesLoading &&
                !skeletonVisible && (
                  <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3">
                    <img
                      src={emptyChatImg}
                      alt=""
                      role="presentation"
                      loading="lazy"
                      className="h-24 w-24 object-contain opacity-80"
                    />
                    <p className="text-sm text-muted-foreground">
                      Send a message to start the conversation
                    </p>
                  </div>
                )}
              {groups.map((group) => {
                return (
                  <PagedGroupRow
                    key={group.beginMessageId}
                    group={group}
                    thread={thread}
                  />
                );
              })}
              <ThinkingIndicator thread={thread} />
            </div>
          </main>
        </div>
        {skeletonVisible && !sessionError && (
          <div
            data-chat-skeleton
            className="absolute inset-0 z-10 overflow-hidden pointer-events-none bg-background"
          >
            <main className="px-4 sm:px-6 py-4 items-center @container">
              <div className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4">
                <ChatSkeleton />
              </div>
            </main>
          </div>
        )}
      </div>

      <ChatThreadComposer thread={thread} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Composer wrapper — reads chat signals from thread prop
// ---------------------------------------------------------------------------

function ChatThreadComposer({
  thread,
  autoFocus: autoFocusProp = true,
}: {
  thread: ChatThreadSignals;
  autoFocus?: boolean;
}) {
  const groups = useLastResolved(thread.groupedChatMessages$) ?? [];
  const hasMessages = groups.length > 0;
  const hasUserMessages = groups.some((g) => {
    return g.role === "user";
  });
  const displayName = useLastResolved(thread.agentDisplayName$) ?? "Zero";
  const allFinishedLoadable = useLastLoadable(thread.allFinished$);
  const allFinished =
    allFinishedLoadable.state === "hasData" ? allFinishedLoadable.data : false;
  const [sendLoadable, send] = useLoadableSet(thread.sendMessage$);
  const sending = !allFinished || sendLoadable.state === "loading";
  const input = useGet(thread.draft.input$);
  const setInput = useSet(thread.draft.setInput$);
  const cancelRun = useSet(thread.cancelRun$);
  const setInputRef = useSet(thread.setInputRef$);
  const scheduleDraftSync = useSet(thread.scheduleDraftSync$);
  const pageSignal = useGet(pageSignal$);
  const rootSignal = useGet(rootSignal$);

  // Per-thread composer state lives in ccstate signals on the factory so the
  // initial value seeds from threadData once it resolves (a React useState
  // initializer would snapshot `undefined` on first render). `modelSelection$`
  // internally flips to a user-override once `setModelSelection$` is called,
  // so unsaved edits survive subsequent threadData$ reloads.
  const threadData = useLastResolved(thread.threadData$);
  const orgProviders = useLastResolved(orgModelProviders$);
  const modelSelection = useLastResolved(thread.modelSelection$) ?? null;
  const setModelSelection = useSet(thread.setModelSelection$);
  const agentModelDefault = useLastResolved(thread.agentModelDefault$) ?? null;
  // During thread switch the thread-level skeleton is visible and
  // `threadData` / `allFinished$` may still reflect the previous thread;
  // render the whole action cluster as a skeleton so we don't flash stale
  // picker state or a wrong send/stop button.
  const skeletonVisible = useGet(thread.skeletonVisible$);

  const handleInputChange = (text: string) => {
    setInput(text);
    detach(scheduleDraftSync(pageSignal), Reason.DomCallback);
  };

  const handleDraftChange = () => {
    detach(scheduleDraftSync(pageSignal), Reason.DomCallback);
  };

  const handleSend = (text: string) => {
    setInput("");
    // Use rootSignal so in-run page navigation (e.g. IPA internal nav) doesn't
    // cancel the pending send.
    detach(send(text, modelSelection, rootSignal), Reason.DomCallback);
  };

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 bg-[hsl(var(--background))]"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-[21px] bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div className="overflow-y-auto [scrollbar-gutter:stable] px-4 sm:px-6 pt-3 pb-2">
        <div className="mx-auto max-w-[900px]">
          <ZeroChatComposer
            className="w-full min-w-0"
            input={input}
            onInputChange={handleInputChange}
            onSend={handleSend}
            sending={sending}
            onCancel={() => {
              detach(cancelRun(pageSignal), Reason.DomCallback);
            }}
            displayName={displayName}
            autoFocus={
              autoFocusProp &&
              !hasMessages &&
              !window.matchMedia("(pointer: coarse)").matches
            }
            onDraftChange={handleDraftChange}
            draft={thread.draft}
            composerFileInput$={thread.composerFileInput$}
            setComposerFileInput$={thread.setComposerFileInput$}
            setInputRef={setInputRef}
            actionsLoading={skeletonVisible}
            modelPicker={
              orgProviders && orgProviders.modelProviders.length > 0
                ? {
                    providers: orgProviders.modelProviders,
                    value: modelSelection,
                    onChange: setModelSelection,
                    sessionProviderType:
                      threadData?.latestSessionProviderType ?? null,
                    // Lock as soon as the thread has a user message — provider
                    // must stay consistent within a session to maintain
                    // continuity.
                    disabled: hasUserMessages,
                    agentDefault: agentModelDefault,
                  }
                : undefined
            }
          />
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Skeleton placeholder while session loads
// ---------------------------------------------------------------------------

function ChatSkeleton() {
  return (
    <>
      {/* User bubble skeleton */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-[60%] rounded-xl" />
      </div>
      {/* Assistant bubble skeleton */}
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-[90%] rounded-lg" />
          <Skeleton className="h-4 w-[75%] rounded-lg" />
          <Skeleton className="h-4 w-[40%] rounded-lg" />
        </div>
      </div>
      {/* User bubble skeleton */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-[45%] rounded-xl" />
      </div>
      {/* Assistant bubble skeleton */}
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-[85%] rounded-lg" />
          <Skeleton className="h-4 w-[60%] rounded-lg" />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Thinking indicator — shown the entire time a run is active
// ---------------------------------------------------------------------------

function ThinkingIndicator({ thread }: { thread: ChatThreadSignals }) {
  const groups = useLastResolved(thread.groupedChatMessages$) ?? [];
  const allFinishedLoadable = useLastLoadable(thread.allFinished$);
  const runActive =
    allFinishedLoadable.state === "hasData" && !allFinishedLoadable.data;
  const [c1, c2, c3] = useGet(thread.blockColors$);
  const blockStyle = {
    "--zb-c1": c1,
    "--zb-c2": c2,
    "--zb-c3": c3,
  } as CSSProperties;

  const lastGroup = groups[groups.length - 1];
  const lastIsAssistant = lastGroup?.role === "assistant";
  const waitingForAssistant = !!lastGroup && !lastIsAssistant;
  const running = runActive || waitingForAssistant;
  const rotatingLabel = useGet(thread.rotatingPhrase$);
  const donePhrase = useGet(thread.donePhrase$);
  const latestRunStatus = useLastResolved(thread.latestRunStatus$);
  const isQueued = latestRunStatus === "queued";
  const openQueueDrawer = useSet(openQueueDrawer$);
  const pageSignal = useGet(pageSignal$);

  const thinkingLabel = isQueued ? (
    <p className="zero-shimmer-text text-xs truncate">
      Waiting in{" "}
      <button
        type="button"
        onClick={() => {
          openQueueDrawer(pageSignal);
        }}
        className="cursor-pointer underline underline-offset-2"
      >
        queue...
      </button>
    </p>
  ) : (
    <p className="zero-shimmer-text text-xs truncate">{rotatingLabel}</p>
  );

  if (!lastGroup) {
    return null;
  }

  // Shared inline row with fixed h-5 to prevent layout jump on transition
  if (lastIsAssistant || !running) {
    return (
      <div
        data-role="assistant-thinking"
        className="-mt-5 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start"
      >
        <div className="hidden @[900px]:block" />
        <div className="min-w-0">
          {running ? (
            <div className="flex items-center gap-2 h-5">
              <span className="zero-blocks shrink-0" style={blockStyle}>
                <span />
                <span />
                <span />
              </span>
              {thinkingLabel}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 h-5 justify-center">
              <div className="h-px w-full bg-border/40" />
              <div className="flex items-center gap-2">
                <p className="text-[11px] italic text-muted-foreground/40 font-serif shrink-0">
                  {donePhrase}
                </p>
                <div className="h-px flex-1 bg-border/40" />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Waiting for first assistant response — show bubble with avatar
  return (
    <div
      data-role="assistant"
      className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="zero-blocks shrink-0" style={blockStyle}>
              <span />
              <span />
              <span />
            </span>
            {thinkingLabel}
          </div>
        </div>
      </div>
      <div
        aria-hidden
        className="@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]"
      >
        <div className="hidden @[900px]:block" />
        <div className="flex items-center py-2 gap-1 -ml-1" />
      </div>
    </div>
  );
}

/**
 * Parse inline attachment lines from message content.
 * Matches `[Attached file: name](url)` optionally followed by a curl line.
 * Returns the cleaned content and parsed attachments.
 */
function parseInlineAttachments(content: string): {
  cleanContent: string;
  parsed: { filename: string; url: string }[];
} {
  const parsed: { filename: string; url: string }[] = [];
  const cleaned = content.replace(
    /\[Attached file: ([^\]]+)\]\(([^)]+)\)(?:\nDownload with: curl [^\n]*)?\n?/g,
    (_match, filename: string, url: string) => {
      parsed.push({ filename, url });
      return "";
    },
  );
  return { cleanContent: cleaned.trim(), parsed };
}

function BodyContentBlocks({
  blocks,
  openLightbox,
  hardBreaks,
}: {
  blocks: BodyRenderBlock[];
  openLightbox: (url: string) => void;
  hardBreaks: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => {
        if (block.type === "markdown") {
          return (
            <Markdown
              key={block.id}
              source={
                hardBreaks
                  ? block.content.replace(/\n/g, "  \n")
                  : block.content
              }
              mediaPreview
              onImageClick={openLightbox}
            />
          );
        }

        if (block.preview.kind === "image") {
          return (
            <ChatImagePreviewButton
              key={block.id}
              alt={block.preview.filename}
              ariaLabel={`Preview ${block.preview.filename}`}
              buttonClassName="w-fit max-w-full rounded-lg border border-foreground/10"
              imageClassName="max-h-48 max-w-full object-contain"
              onPreview={() => {
                openLightbox(block.preview.url);
              }}
              placeholderClassName="h-48 w-64 max-w-full"
              url={block.preview.url}
            />
          );
        }

        if (block.preview.kind === "video") {
          return (
            <video
              key={block.id}
              src={block.preview.url}
              controls
              className="max-h-48 max-w-full rounded-lg border border-foreground/10"
            />
          );
        }

        return (
          <AttachmentPreview
            key={block.id}
            attachment={{
              filename: block.preview.filename,
              url: block.preview.url,
              contentType: contentTypeForBodyPreviewKind(block.preview.kind),
            }}
            text$={block.preview.text$}
          />
        );
      })}
    </div>
  );
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
}

function isVideoFilename(filename: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(filename);
}

function isAudioFilename(filename: string): boolean {
  return /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|mpga)$/i.test(filename);
}

function AssistantErrorContent({ error }: { error: string }) {
  const setOrgManageOpen = useSet(setOrgManageDialogOpen$);
  const setTab = useSet(setActiveOrgManageTab$);
  const pageSignal = useGet(pageSignal$);

  if (error.trim().toLowerCase() === "run cancelled") {
    return (
      <div
        className="inline-flex items-center gap-2 bg-muted/50 px-3 py-1.5 text-[13px] text-muted-foreground"
        style={{
          border: "0.7px solid hsl(var(--border))",
          borderRadius: "12px",
        }}
      >
        <IconHandStop size={14} stroke={1.75} className="shrink-0" />
        <span>Paused mid-thought — pick it back up whenever.</span>
      </div>
    );
  }

  const noProviderGuidance = RUN_ERROR_GUIDANCE.NO_MODEL_PROVIDER;
  const isNoModelProvider =
    noProviderGuidance !== undefined &&
    error.toLowerCase().includes(noProviderGuidance.title.toLowerCase());

  if (isNoModelProvider) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          No model provider configured yet.{" "}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
            onClick={() => {
              setTab("providers");
              detach(setOrgManageOpen(true, pageSignal), Reason.DomCallback);
            }}
          >
            Set one up in Workspace Settings
          </button>{" "}
          to get started.
        </span>
      </div>
    );
  }

  const incompatibleGuidance = RUN_ERROR_GUIDANCE.PROVIDER_INCOMPATIBLE;
  const isProviderIncompatible =
    (incompatibleGuidance !== undefined &&
      error.toLowerCase().includes(incompatibleGuidance.title.toLowerCase())) ||
    error.includes("Cannot continue session") ||
    error.includes("Invalid signature in thinking block");

  if (isProviderIncompatible) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          This session was started with a different model provider and
          can&apos;t be continued with the current one.{" "}
          <Link
            pathname="/"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
          >
            Start a new session
          </Link>
        </span>
      </div>
    );
  }

  const deletedGuidance = RUN_ERROR_GUIDANCE.PROVIDER_DELETED;
  const isProviderDeleted =
    deletedGuidance !== undefined &&
    (error.toLowerCase().includes(deletedGuidance.title.toLowerCase()) ||
      error.toLowerCase().includes(deletedGuidance.guidance.toLowerCase()));

  if (isProviderDeleted) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          The model provider used by this thread has been deleted.{" "}
          <Link
            pathname="/"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
          >
            Start a new chat thread
          </Link>{" "}
          to continue.
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 text-destructive">
      <IconAlertCircle size={16} className="shrink-0 mt-[3px]" />
      <Markdown source={error} />
    </div>
  );
}

function AssistantBubbleAvatar({ thread }: { thread: ChatThreadSignals }) {
  const agentId = useLastResolved(thread.agentId$) ?? "";
  return (
    <Link
      pathname="/agents/:agentId"
      options={{ pathParams: { agentId } }}
      className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="View agent profile"
    >
      <AgentAvatarImg
        name={agentId}
        alt=""
        className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-full object-cover object-top"
      />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Paged message rendering — renders from groupedChatMessages$ (flat data,
// no signal-based run loops).
// ---------------------------------------------------------------------------

function PagedGroupRow({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  if (group.role === "user") {
    return <PagedUserGroup group={group} thread={thread} />;
  }
  return <PagedAssistantGroup group={group} thread={thread} />;
}

function PagedUserGroup({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  return (
    <>
      {group.messages.map((msg) => {
        return <PagedUserMessage key={msg.id} message={msg} thread={thread} />;
      })}
    </>
  );
}

function resolveAttachments(
  message: PagedChatMessage,
  parsed: { filename: string; url: string }[],
) {
  const source =
    message.attachFiles && message.attachFiles.length > 0
      ? message.attachFiles
      : parsed;
  return source.map((f) => {
    const contentType =
      "contentType" in f && typeof f.contentType === "string"
        ? f.contentType
        : undefined;
    const kind = classifyChatAttachment({
      filename: f.filename,
      url: f.url,
      contentType,
    });
    return {
      filename: f.filename,
      url: f.url,
      contentType,
      isImage: kind === "image" || isImageFilename(f.filename),
      isVideo: kind === "video" || isVideoFilename(f.filename),
      isAudio: kind === "audio" || isAudioFilename(f.filename),
      kind,
    };
  });
}

function attachmentIdFromUrl(url: string): string | null {
  if (!URL.canParse(url, window.location.origin)) {
    return null;
  }
  const parsed = new URL(url, window.location.origin);
  const match = parsed.pathname.match(/^\/f\/[^/]+\/([^/]+)\/[^/]+$/);
  return match?.[1] ?? null;
}

function inferAttachmentContentType(filename: string, kind: string): string {
  const contentTypesByExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mpga: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/opus",
    flac: "audio/flac",
  };
  const lower = filename.toLowerCase();
  const extension = lower.includes(".") ? lower.split(".").pop() : undefined;
  const contentType =
    extension === undefined ? undefined : contentTypesByExtension[extension];
  if (contentType !== undefined) {
    return contentType;
  }
  switch (kind) {
    case "markdown": {
      return "text/markdown";
    }
    case "text": {
      return "text/plain";
    }
    case "json": {
      return "application/json";
    }
    case "csv": {
      return "text/csv";
    }
    case "pdf": {
      return "application/pdf";
    }
    case "html": {
      return "text/html";
    }
    default: {
      return "application/octet-stream";
    }
  }
}

function clipboardAttachmentsFromMessage(
  message: PagedChatMessage,
  parsed: { filename: string; url: string }[],
): ChatClipboardAttachment[] {
  const source =
    message.attachFiles && message.attachFiles.length > 0
      ? message.attachFiles
      : parsed;
  return source.map((f) => {
    const contentType =
      "contentType" in f && typeof f.contentType === "string"
        ? f.contentType
        : undefined;
    const kind = classifyChatAttachment({
      filename: f.filename,
      url: f.url,
      contentType,
    });
    return {
      id:
        "id" in f && typeof f.id === "string"
          ? f.id
          : attachmentIdFromUrl(f.url),
      filename: f.filename,
      url: f.url,
      contentType: contentType ?? inferAttachmentContentType(f.filename, kind),
      size: "size" in f && typeof f.size === "number" ? f.size : 0,
    };
  });
}

function UserMessageAttachments({
  attachments,
  onImageClick,
}: {
  attachments: ReturnType<typeof resolveAttachments>;
  onImageClick: (url: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-foreground/10 px-3 py-2.5 flex flex-wrap gap-2">
      {attachments.map((a) => {
        if (a.isImage) {
          return (
            <ChatImagePreviewButton
              key={a.url}
              alt={a.filename}
              ariaLabel={`Preview ${a.filename}`}
              buttonClassName="rounded-lg border border-foreground/10 transition-colors hover:border-foreground/25"
              imageClassName="h-9 max-w-[72px] object-cover"
              onPreview={() => {
                onImageClick(a.url);
              }}
              placeholderClassName="h-9 w-[72px]"
              url={a.url}
            />
          );
        }
        if (a.isVideo) {
          return (
            <video
              key={a.url}
              src={a.url}
              controls
              className="max-h-48 max-w-full rounded-lg border border-foreground/10"
            />
          );
        }
        if (a.isAudio) {
          return (
            <audio
              key={a.url}
              src={a.url}
              controls
              preload="metadata"
              className="w-full max-w-md"
              aria-label={`Audio preview for ${a.filename}`}
            />
          );
        }
        if (
          a.kind === "markdown" ||
          a.kind === "text" ||
          a.kind === "json" ||
          a.kind === "csv" ||
          a.kind === "pdf" ||
          a.kind === "html"
        ) {
          return (
            <PreviewableFileAttachmentChip
              key={a.url}
              filename={a.filename}
              url={a.url}
              kind={a.kind}
            />
          );
        }
        return (
          <FileAttachmentChip key={a.url} filename={a.filename} url={a.url} />
        );
      })}
    </div>
  );
}

function PagedUserMessage({
  message,
  thread,
}: {
  message: EnrichedChatMessage;
  thread: ChatThreadSignals;
}) {
  const content = message.content ?? "";
  // Two attachment sources coexist: the structured `attachFiles` field
  // (current flow) and legacy `[Attached file: ...](url)` inline lines left
  // over from messages sent before #10243 split the flows. Use the structured
  // source when it's present and fall back to inline parsing otherwise.
  const { cleanContent, parsed } = parseInlineAttachments(content);
  // `ATTACH_ONLY_PLACEHOLDER` is the server-side placeholder stored when the
  // user sent only files with no typed text — strip it so the bubble shows
  // just the attachments.
  const strippedContent =
    message.attachFiles &&
    message.attachFiles.length > 0 &&
    cleanContent.trim() === ATTACH_ONLY_PLACEHOLDER
      ? ""
      : cleanContent;
  const bodyBlocks = enrichBlocksWithTextPreviews(
    parseBodyRenderBlocks(strippedContent).blocks,
  );
  const pageSignal = useGet(pageSignal$);
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = (url: string) => {
    openImageLightbox(url);
  };
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === message.id;
  const copyMessage = useSet(thread.copyMessage$);
  const allAttachments = resolveAttachments(message, parsed);
  const clipboardAttachments = clipboardAttachmentsFromMessage(message, parsed);
  const copyText = strippedContent;
  const canCopy = copyText.trim().length > 0 || clipboardAttachments.length > 0;

  const handleCopy = () => {
    if (!canCopy) {
      return;
    }
    detach(
      copyMessage(
        message.id,
        { text: copyText, attachments: clipboardAttachments },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div data-role="user" className="group">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-sm leading-relaxed [overflow-wrap:anywhere] overflow-hidden">
            {bodyBlocks.length > 0 && (
              <div className="px-4 py-3">
                <BodyContentBlocks
                  blocks={bodyBlocks}
                  openLightbox={openLightbox}
                  hardBreaks
                />
              </div>
            )}
            <UserMessageAttachments
              attachments={allAttachments}
              onImageClick={openLightbox}
            />
          </div>
          {canCopy && (
            <div className="flex justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <button
                type="button"
                onClick={handleCopy}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="Copy message"
              >
                {copied ? (
                  <IconCheck size={18} stroke={1.5} />
                ) : (
                  <IconCopy size={18} stroke={1.5} />
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PagedAssistantGroup({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  const groupElementId = `chat-message-group-${group.beginMessageId}`;
  const fullContent = group.messages
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");

  return (
    <div
      id={groupElementId}
      data-role="assistant"
      className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="relative flex flex-col gap-3">
          {group.messages.map((msg) => {
            return <PagedAssistantMessageItem key={msg.id} message={msg} />;
          })}
        </div>
      </div>
      <PagedGroupActions
        group={group}
        content={fullContent}
        thread={thread}
        onScrollToMessageStart={() => {
          document.getElementById(groupElementId)?.scrollIntoView({
            block: "start",
            behavior: "smooth",
          });
        }}
      />
    </div>
  );
}

function PagedAssistantMessageItem({
  message,
}: {
  message: EnrichedChatMessage;
}) {
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = (url: string) => {
    openImageLightbox(url);
  };

  if (message.error) {
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 [overflow-wrap:anywhere]">
        <AssistantErrorContent error={message.error} />
      </div>
    );
  }

  if (message.content) {
    const { blocks } = message;
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 [overflow-wrap:anywhere]">
        {blocks.length > 0 ? (
          <BodyContentBlocks
            blocks={blocks}
            openLightbox={openLightbox}
            hardBreaks={false}
          />
        ) : null}
      </div>
    );
  }

  return null;
}

function PagedGroupPrimaryActions({
  firstRunId,
  hasContent,
  copied,
  audioOutputEnabled,
  isPlayingThis,
  onCopy,
  onTts,
}: {
  firstRunId: string | undefined;
  hasContent: boolean;
  copied: boolean;
  audioOutputEnabled: boolean;
  isPlayingThis: boolean;
  onCopy: () => void;
  onTts: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {firstRunId && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/activities/:activityRunId"
                options={{
                  pathParams: { activityRunId: firstRunId },
                }}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="View run logs"
              >
                <IconChartLine size={18} stroke={1.5} />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">View activity logs</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasContent && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCopy}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="Copy message"
              >
                {copied ? (
                  <IconCheck size={18} stroke={1.5} />
                ) : (
                  <IconCopy size={18} stroke={1.5} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {copied ? "Copied!" : "Copy message"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasContent && firstRunId && audioOutputEnabled && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onTts}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label={isPlayingThis ? "Stop reading" : "Read aloud"}
              >
                {isPlayingThis ? (
                  <IconPlayerStop size={18} stroke={1.5} />
                ) : (
                  <IconVolume2 size={18} stroke={1.5} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isPlayingThis ? "Stop reading" : "Read aloud"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function MessageStartButton({ onClick }: { onClick: () => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
            aria-label="Scroll to message start"
          >
            <IconArrowBarToUp size={18} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Scroll to start</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PagedGroupActions({
  group,
  content,
  thread,
  onScrollToMessageStart,
}: {
  group: GroupedChatMessageGroup;
  content: string;
  thread: ChatThreadSignals;
  onScrollToMessageStart: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === group.beginMessageId;
  const copyMessage = useSet(thread.copyMessage$);

  const features = useLastResolved(featureSwitch$);
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;
  const messageStartButtonEnabled =
    features?.[FeatureSwitchKey.ChatMessageStartButton] ?? false;
  const firstRunId = group.messages.find((m) => {
    return m.runId;
  })?.runId;
  const hasContent = content.length > 0;
  const [ttsLoadable, playTts] = useLoadableSet(playTts$);
  const isPlayingThis = ttsLoadable.state === "loading";
  const stopTts = useSet(stopTts$);

  if (group.role === "user") {
    return null;
  }

  const handleCopy = () => {
    if (!content) {
      return;
    }
    detach(
      copyMessage(
        group.beginMessageId,
        { text: content, attachments: [] },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const handleTts = () => {
    if (!firstRunId) {
      return;
    }
    if (isPlayingThis) {
      stopTts();
    } else {
      detach(playTts(content, pageSignal), Reason.DomCallback);
    }
  };

  return (
    <div className="@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]">
      <div className="hidden @[900px]:block" />
      <div className="flex items-center justify-between pt-2 pb-1 gap-2 -ml-1">
        <PagedGroupPrimaryActions
          firstRunId={firstRunId}
          hasContent={hasContent}
          copied={copied}
          audioOutputEnabled={audioOutputEnabled}
          isPlayingThis={isPlayingThis}
          onCopy={handleCopy}
          onTts={handleTts}
        />
        {messageStartButtonEnabled && (
          <MessageStartButton onClick={onScrollToMessageStart} />
        )}
      </div>
    </div>
  );
}
