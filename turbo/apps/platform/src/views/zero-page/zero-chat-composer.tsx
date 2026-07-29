// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  useGet,
  useSet,
  useLoadable,
  useLoadableState,
  useLastLoadable,
  useLastResolved,
  type Loadable,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
import { useLoadableSet } from "ccstate-react/experimental";
import { equalArrays } from "../../lib/equality.ts";
import { ensurePushSubscription$ } from "../../lib/push-notifications.ts";
import {
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconArrowUp,
  IconBolt,
  IconColorSwatch,
  IconDeviceDesktop,
  IconDownload,
  IconDots,
  IconPresentation,
  IconLoader2,
  IconLink,
  IconMicrophone,
  IconPaperclip,
  IconPalette,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlug,
  IconPhoto,
  IconPlus,
  IconRoute,
  IconSearch,
  IconTarget,
  IconTemplate,
  IconUpload,
  IconVideo,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  Button,
  Card,
  CardContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  processShortcut,
  type KeyboardEventLike,
} from "@vm0/ui";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
  tapError,
} from "../../signals/utils.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import {
  activeGoalDialogGoal$,
  activeGoalDialogThreadId$,
  closeChatThreadGoalDialog$,
  openChatThreadGoalDialog$,
} from "../../signals/chat-page/chat-goal.ts";
import type { DraftSignals } from "../../signals/chat-page/create-chat-thread.ts";
import type {
  ComposerTemplateAttachment,
  WorkflowComposerSubmissionSnapshot,
  WorkflowComposerSignals,
} from "../../signals/zero-page/tiptap-workflow-composer.ts";
import type { TemplatePreviewRuntime } from "../../signals/zero-page/template-preview-runtime.ts";
import { isVisualAttachment } from "../../signals/chat-page/resolve-draft-attachments.ts";
import type { Command, Computed } from "ccstate";
import {
  composerFileInput$ as singletonComposerFileInput$,
  setComposerFileInput$ as singletonSetComposerFileInput$,
} from "../../signals/chat-page/chat-event.ts";
import type {
  GenerationTemplateRequest,
  PersistedAttachment,
  UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import { TiptapWorkflowComposer } from "./tiptap-workflow-composer.tsx";
import { computerUseIllustrationImg } from "./platform-assets.ts";
import type { ComposerPasteEvent } from "./composer-input-types.ts";
import {
  previewPresentationHtml,
  type PresentationPreviewDraft,
} from "./presentation-html-preview.ts";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS,
  WORKFLOW_TEMPLATE_CATEGORIES,
  WORKFLOW_TEMPLATE_ITEMS,
  findWebsiteTemplateItem,
  findVideoTemplateItem,
  findWorkflowTemplateItem,
  r2ImageTransformUrl,
  type IllustrationTemplateItem,
  type PresentationTemplateItem,
  type VideoTemplateItem,
  type WebsiteTemplateItem,
  type WorkflowTemplateItem,
} from "@vm0/core";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import type { ConnectorSlug } from "@vm0/api-contracts/contracts/connector-identity";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { getModelImageInputSupport } from "@vm0/api-contracts/contracts/model-providers";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ConnectorCard } from "./components/settings/connector-card.tsx";
import type { ConnectorConnectHandlers } from "./components/settings/launch-connector-connect.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  allConnectorCatalogItems$,
  connectConnectorNoAuth$,
  connectConnectorOAuthAuthCode$,
  connectFlowConnectorSlug$,
  matchesConnectorSearch,
  justConnectedSlugs$,
  pollingOAuthAuthCodeConnectorSlug$,
  pollingOAuthDeviceAuthConnectorSlug$,
} from "../../signals/zero-page/settings/connectors.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  codexFastModeEnabled$,
  composerUploadPopoverEnabled$,
  composerConnectorPermissionsEnabled$,
  featureSwitch$,
} from "../../signals/external/feature-switch.ts";
import {
  zeroDesktopDownloadSupportStatus$,
  ZERO_DESKTOP_MACOS_REQUIREMENT_LABEL,
  ZERO_DESKTOP_UNSUPPORTED_INTEL_MAC_LABEL,
} from "../../signals/zero-page/computer-use-hosts.ts";
import type { ComposerConnectorSignals } from "../../signals/zero-page/zero-connectors.ts";
import type { AgentConnectorAuthorizations } from "../../signals/zero-page/agent-connector-authorizations.ts";
import { applyUserPermissionGrants$ } from "../../signals/permission-allow/permission-allow-signals.ts";
import { activeUserPermissionGrantSnapshot } from "../../signals/user-permission-grants.ts";
import { savePermissionDraftPolicies } from "../../signals/zero-page/settings/permission-grant-save.ts";
import { PermissionsDialog } from "./components/settings/permissions-dialog.tsx";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  modelPickerOpen$,
  setModelPickerOpen$,
  uploadPopoverOpen$,
  setUploadPopoverOpen$,
  templatePickerOpen$,
  templatePickerSkipEnterAnimation$,
  setTemplatePickerOpen$,
  templatePickerReferenceValue$,
  setTemplatePickerReferenceValue$,
  openWebsiteTemplatePreview$,
  templatePickerCategory$,
  setTemplatePickerCategory$,
  templatePickerSearch$,
  setTemplatePickerSearch$,
  templatePickerWorkflowCategory$,
  setTemplatePickerWorkflowCategory$,
  templatePickerPreviewSlug$,
  setTemplatePickerPreviewSlug$,
  restoreTemplatePickerPresentationScroll$,
  setTemplatePickerPresentationScrollTop$,
  illustrationVariantIndex$,
  setIllustrationVariantIndex$,
  templateCardHover$,
  setTemplateCardHover$,
  templateCardLoadedHtmlFrameUrls$,
  setTemplateCardLoadedHtmlFrameUrl$,
  templateCardThemeIdBySlug$,
  setTemplateCardThemeId$,
  templateCardHtmlPreview$,
  setTemplateCardHtmlPreview$,
  type TemplateCardHtmlPreviewState,
  templateDetailHtmlPreview$,
  closePresentationTemplateDetailPreview$,
  loadPresentationTemplateHtmlPreview,
  ownTemplatePickerPreviewResources$,
  openPresentationTemplateDetailPreview$,
  releaseTemplatePickerPreviewResources$,
  selectPresentationTemplateDetailPreview$,
  settlePresentationTemplateDetailPreviewFrame$,
} from "../../signals/zero-page/zero-chat-composer.ts";
import {
  audioInputAvailable$,
  audioInputQuota$,
  openAudioInputQuotaRecovery$,
  sttRecording$,
  sttStarting$,
  sttTranscribing$,
  sttVoiceLevel$,
  startRecording$,
  stopAndTranscribe$,
} from "../../signals/voice-io/voice-io-stt.ts";
import { readChatMessageFromClipboard } from "../../signals/zero-page/clipboard.ts";
import { shouldUseUserMessage } from "../../signals/zero-page/user-message-document-codec.ts";
import { Markdown } from "../components/markdown.tsx";
import { WebsiteTemplatePreviewDialogSlot } from "./website-template-preview-dialog.tsx";

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB — keep in sync with web constants
const COMPOSER_CONTROL_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function isHappyDomTestEnvironment(): boolean {
  return (
    typeof globalThis.window !== "undefined" && "happyDOM" in globalThis.window
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ZeroChatComposerProps {
  composer: WorkflowComposerSignals;
  composerConnectors: ComposerConnectorSignals;
  onSend: (
    message: string,
    generationTemplate: GenerationTemplateRequest | undefined,
    editorDocument: WorkflowComposerSubmissionSnapshot["editorDocument"],
  ) => void;
  onQueue?: (
    message: string,
    generationTemplate: GenerationTemplateRequest | undefined,
    editorDocument: WorkflowComposerSubmissionSnapshot["editorDocument"],
  ) => void;
  sending?: boolean;
  queueWhileSending?: boolean;
  /** Blocks send and queue submission while an async composer command settles. */
  submissionLoading?: boolean;
  /**
   * Cancel the active run. When provided, the Send button switches to a Stop
   * button while sending and the composer is empty; with content present the
   * Send button stays visible and clicks queue the message instead.
   * Clicking Stop while a queue exists recalls the queued messages.
   */
  onCancel?: () => void;
  displayName: string;
  className?: string;
  /** Auto-focus the textarea when mounted. */
  autoFocus?: boolean;
  /** When set, reduces this instance to a single-line resting height on mobile. */
  enableMobileSingleLine?: boolean;
  /** Per-instance draft signals (from ChatThreadSignals factory). When omitted, falls back to singleton signals. */
  draft: DraftSignals;
  /** Composer file input element reference. When omitted, falls back to singleton. */
  composerFileInput$?: Computed<HTMLElement | null>;
  /** Set the composer file input element. When omitted, falls back to singleton. */
  setComposerFileInput$?: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  /** Current chat thread id. Used by thread-scoped goal controls. */
  chatThreadId?: string;
  /** Called after attachment upload/remove mutations so the caller can trigger side-effects (e.g. draft sync). */
  onDraftChange?: () => void;
  /**
   * When true, keep the send control in its disabled empty-composer state.
   * Model and voice controls resolve independently and should not be hidden by
   * message list loading.
   */
  actionsLoading?: boolean;
  /**
   * Per-run model picker wiring. When present, a compact picker is rendered
   * immediately to the left of the Send button; the parent owns the selected
   * value and decides when to include it in the send payload. Undefined
   * hides the picker entirely (e.g. callers that haven't opted in).
   */
  modelPicker?: {
    value: ModelProviderSelection | null;
    onChange: (value: ModelProviderSelection | null) => void;
    // When true, picker is read-only for the current composer state.
    disabled?: boolean;
  };
  templatePicker?: {
    value: GenerationTemplateRequest | undefined;
    onChange: (value: GenerationTemplateRequest | undefined) => void;
  };
  onCreateWorkflowPrompt?: () => void;
  computerUse?: {
    hosts: readonly ComposerComputerUseHost[];
    loading: boolean;
    selectedHostId: string | null;
    onChange: (hostId: string | null) => void;
    cloudBrowserAvailable: boolean;
    cloudBrowserEnabled: boolean;
    onCloudBrowserChange: (enabled: boolean) => void;
    downloadUrl: string;
  };
  /** When true, hide the model picker until the selected model resolves. */
  modelPickerLoading?: boolean;
  submitBlocker?: {
    message: string;
    actionLabel: string;
    onAction: () => void;
  };
  /**
   * Pending sends that landed while a run was active. Rendered as a compact
   * strip above the textarea so the user can see what's queued without
   * having those messages re-appear as bubbles in the conversation.
   */
  queuedItems?: QueuedComposerItem[];
  /** Cancels a queued message (routed to the recall flow by the caller). */
  onRemoveQueuedItem?: (id: string) => void;
  /** Pending workflow events, rendered after queued messages. */
  workflowEventItems?: WorkflowEventComposerItem[];
  /** Skips one pending workflow event. */
  onRemoveWorkflowEvent?: (id: string) => void;
  /** Whether workflow event processing is paused for this thread. */
  workflowEventsPaused?: boolean;
  /** Optional server-provided reason for the paused workflow event queue. */
  workflowEventsPauseReason?: string | null;
  /** Pauses or resumes workflow event processing without affecting messages. */
  onSetWorkflowEventsPaused?: (paused: boolean) => void;
  /** Clears every pending workflow event without affecting messages. */
  onClearWorkflowEvents?: () => void;
  /**
   * The thread's active goal. Rendered as a row beneath the queued messages in
   * the strip above the composer — a goal runs only once the queue drains, so it
   * sits closest to the composer to read as lower priority than the queue.
   * Absent when the thread has no in-progress goal.
   */
  activeGoal?: ActiveGoalComposerItem;
  /** Cancels the active goal through the goal API. */
  onCancelActiveGoal?: () => void;
}

export interface ComposerConnectorReadState {
  readonly catalogItems: Loadable<readonly PublicConnectorCatalogStatusItem[]>;
  readonly agentId: Loadable<string | null>;
  readonly authorizations: Loadable<AgentConnectorAuthorizations | null>;
}

export interface QueuedComposerItem {
  id: string;
  text: string;
}

export interface WorkflowEventComposerItem {
  id: string;
  text: string;
}

interface ActiveGoalComposerItem {
  /** The goal's brief objective — the human-readable text shown in the row. */
  objective: string;
}

interface ComposerComputerUseHost {
  id: string;
  hostName: string;
  displayName: string;
  status: "online" | "offline";
}

type ComposerModelPicker = NonNullable<ZeroChatComposerProps["modelPicker"]>;
type ComposerTemplatePicker = NonNullable<
  ZeroChatComposerProps["templatePicker"]
>;
type ComposerComputerUse = NonNullable<ZeroChatComposerProps["computerUse"]>;

const TEMPLATE_CARD_PREVIEW_SIZE = { width: 480, height: 270 } as const;
const TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE = {
  width: 708,
  height: 398,
} as const;
const TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE = {
  width: 224,
  height: 126,
} as const;
const PRESENTATION_GALLERY_PREVIEW_BASE_URL =
  "https://static.vm0.io/web/assets/presentation-gallery/2026-07-04";
const PRESENTATION_GALLERY_SLIDE_COUNT = 15;
const TEMPLATE_PREWARM_IMAGE_COUNT = 15;
const ILLUSTRATION_PREWARM_IMAGE_COUNT = 24;
const ILLUSTRATION_EAGER_IMAGE_COUNT = 24;
const ILLUSTRATION_SCROLL_PREWARM_LOOKAHEAD_COUNT = 12;
const ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT = 24;
const ILLUSTRATION_CARD_PREVIEW_SIZE = {
  width: 1024,
  quality: 72,
} as const;
const ILLUSTRATION_VARIANT_THUMB_SIZE = {
  width: 96,
  height: 96,
  fit: "cover",
  quality: 65,
} as const;
const SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE = {
  width: 40,
  height: 40,
  fit: "cover",
} as const;
type TemplatePreviewImageSize = Parameters<typeof r2ImageTransformUrl>[1];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ComposerConnectorItem = PublicConnectorCatalogStatusItem & {
  readonly authorized: boolean;
};

function resolveComposerModelForSelection(
  modelPicker: ComposerModelPicker | undefined,
  selection: ModelProviderSelection | null,
): ModelProviderSelection | null {
  if (!modelPicker) {
    return null;
  }
  if (selection) {
    return selection;
  }
  return null;
}

interface VisualAttachmentUnsupportedState {
  currentModelName: string;
}

interface VisualAttachmentCandidate {
  contentType: string;
  filename: string;
}

function getVisualAttachmentUnsupportedState(
  modelPicker: ComposerModelPicker | undefined,
  selection: ModelProviderSelection | null = modelPicker?.value ?? null,
): VisualAttachmentUnsupportedState | null {
  const currentModel = resolveComposerModelForSelection(modelPicker, selection);
  if (
    getModelImageInputSupport(currentModel?.selectedModel) !== "unsupported" ||
    !currentModel
  ) {
    return null;
  }
  return {
    currentModelName: getModelDisplayName(currentModel.selectedModel),
  };
}

function isVisualAttachmentFile(file: File): boolean {
  return isVisualAttachment({
    contentType: file.type,
    filename: file.name,
  });
}

function showVisualAttachmentUnsupportedToast(
  state: VisualAttachmentUnsupportedState,
): void {
  toast.error(
    `${state.currentModelName} cannot recognize images or videos. Switch to a vision-capable model to attach them.`,
    { id: "visual-attachment-unsupported" },
  );
}

function resolveVisibleAttachments<T extends VisualAttachmentCandidate>(
  attachments: T[],
  visualAttachmentUnsupported: VisualAttachmentUnsupportedState | null,
): T[] {
  if (!visualAttachmentUnsupported) {
    return attachments;
  }
  return attachments.filter((attachment) => {
    return !isVisualAttachment(attachment);
  });
}

function resolveComposerCanSend({
  hasInput,
  visibleAttachmentCount,
  uploadsReady,
}: {
  hasInput: boolean;
  visibleAttachmentCount: number;
  uploadsReady: boolean;
}): boolean {
  return uploadsReady && (hasInput || visibleAttachmentCount > 0);
}

// ---------------------------------------------------------------------------
// Queued messages strip — separate card stacked behind the composer with a
// vertical-only stagger. The composer card sits on top (z-10) and covers the
// strip's bottom edge so it reads as one tucked-behind queue layer.
// ---------------------------------------------------------------------------

// The three-bar "queue" mark, sized to sit inline beside the goal's target so a
// queued row and the goal row differ only by their leading icon.
function ComposerQueueGlyph() {
  return (
    <span
      className="inline-flex h-4 w-4 items-center justify-center gap-[2px]"
      aria-hidden="true"
    >
      <span className="h-3 w-[3px] rounded-sm bg-emerald-800" />
      <span className="h-3 w-[3px] rounded-sm bg-emerald-800/60" />
      <span className="h-3 w-[3px] rounded-sm bg-emerald-800/30" />
    </span>
  );
}

// A single strip row — a queued message, workflow event, or active goal. All
// share one layout so they read as the same kind of pending item; only the
// leading icon distinguishes them. Goals open a modal because their full
// objective is fetched lazily by thread.
function ComposerStripRow({
  kind,
  text,
  onRemove,
  onOpenDetail,
  removeAriaLabel,
}: {
  kind: "queued" | "workflow-event" | "goal";
  text: string;
  onRemove?: () => void;
  onOpenDetail?: () => void;
  removeAriaLabel: string;
}) {
  const isGoal = kind === "goal";
  const isWorkflowEvent = kind === "workflow-event";
  const itemAriaLabel = isGoal
    ? "Active goal"
    : isWorkflowEvent
      ? "Pending automation event"
      : "Queued message";
  const aboutAriaLabel = isGoal
    ? "About this goal"
    : isWorkflowEvent
      ? "About this automation event"
      : "About this queued message";
  const itemTitle = isGoal
    ? "Goal"
    : isWorkflowEvent
      ? "Automation event"
      : "Queued message";
  const itemDescription = isGoal
    ? "Runs after the queue drains and keeps running until you cancel it."
    : isWorkflowEvent
      ? "Waits behind queued messages and runs once the current run finishes."
      : "Waits in line and sends once the current run finishes.";
  return (
    <div
      role="listitem"
      aria-label={itemAriaLabel}
      className="group flex items-center gap-2 rounded-md pl-2 pr-1 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent"
    >
      {isGoal && onOpenDetail ? (
        <button
          type="button"
          className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-[hsl(var(--gray-200))] hover:text-sidebar-foreground focus-visible:bg-[hsl(var(--gray-200))] focus-visible:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onOpenDetail}
          aria-label="Open goal details"
        >
          <IconTarget
            size={16}
            stroke={1.5}
            className="shrink-0 text-emerald-800"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{text}</span>
        </button>
      ) : (
        <>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded-md p-1 text-emerald-800 transition-colors hover:bg-[hsl(var(--gray-200))] focus-visible:bg-[hsl(var(--gray-200))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={aboutAriaLabel}
              >
                {isGoal ? (
                  <IconTarget size={16} stroke={1.5} aria-hidden="true" />
                ) : isWorkflowEvent ? (
                  <IconBolt size={16} stroke={1.5} aria-hidden="true" />
                ) : (
                  <ComposerQueueGlyph />
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              className="w-80 rounded-lg p-3"
            >
              <p className="text-xs font-semibold text-foreground">
                {itemTitle}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {itemDescription}
              </p>
              <div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-2 text-sm text-foreground">
                {text}
              </div>
            </PopoverContent>
          </Popover>
          <span className="min-w-0 flex-1 truncate">{text}</span>
        </>
      )}
      <button
        type="button"
        className="shrink-0 rounded-lg p-1.5 text-muted-foreground/45 transition-colors hover:bg-[hsl(var(--gray-200))] hover:text-sidebar-foreground focus-visible:bg-[hsl(var(--gray-200))] focus-visible:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => {
          onRemove?.();
        }}
        aria-label={removeAriaLabel}
      >
        <IconX size={16} stroke={1.5} />
      </button>
    </div>
  );
}

function ActiveGoalObjectiveDialog({ threadId }: { threadId?: string }) {
  const dialogThreadId = useGet(activeGoalDialogThreadId$);
  const goalLoadable = useLoadable(activeGoalDialogGoal$);
  const closeDialog = useSet(closeChatThreadGoalDialog$);
  const open = threadId !== undefined && dialogThreadId === threadId;
  const goal = goalLoadable.state === "hasData" ? goalLoadable.data : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closeDialog();
        }
      }}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-2xl gap-5 p-5 sm:p-6"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle className="text-base">Goal</DialogTitle>
          <DialogDescription className="leading-6">
            Runs after the queue drains and keeps running until you cancel it.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60vh,520px)] overflow-y-auto rounded-lg bg-muted/40 px-3 py-3 text-sm text-foreground sm:px-4">
          {goalLoadable.state === "loading" ? (
            <div className="flex min-h-28 items-center justify-center gap-2 text-muted-foreground">
              <IconLoader2
                size={16}
                stroke={1.7}
                className="animate-spin"
                aria-hidden="true"
              />
              <span>Loading goal...</span>
            </div>
          ) : goalLoadable.state === "hasError" ? (
            <div className="flex min-h-28 flex-col justify-center gap-1 text-muted-foreground">
              <p className="font-medium text-foreground">
                Couldn&apos;t load this goal
              </p>
              <p className="text-xs">
                Close the dialog and open it again to retry.
              </p>
            </div>
          ) : goal ? (
            <Markdown
              source={goal.objective}
              escapeHtml
              mathEnabled
              style={{ fontSize: "inherit", lineHeight: "inherit" }}
            />
          ) : (
            <div className="flex min-h-28 items-center text-muted-foreground">
              This goal is no longer available.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PendingItemsStripHeader({
  count,
  label,
  workflowEventCount,
  workflowEventsPaused,
  onSetWorkflowEventsPaused,
  onClearWorkflowEvents,
}: {
  count: number;
  label: string;
  workflowEventCount: number;
  workflowEventsPaused: boolean;
  onSetWorkflowEventsPaused?: (paused: boolean) => void;
  onClearWorkflowEvents?: () => void;
}) {
  const showWorkflowControls =
    onSetWorkflowEventsPaused !== undefined &&
    (workflowEventCount > 0 || workflowEventsPaused);
  return (
    <div className="flex items-center gap-2 px-5 pt-3 pb-2">
      <div className="min-w-0 flex-1">
        <span className="text-sm text-muted-foreground">
          {count > 0 ? label : "Automation events paused"}
        </span>
      </div>
      {showWorkflowControls ? (
        <button
          type="button"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-[hsl(var(--gray-200))] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={
            workflowEventsPaused
              ? "Resume automation events"
              : "Pause automation events"
          }
          onClick={() => {
            onSetWorkflowEventsPaused?.(!workflowEventsPaused);
          }}
        >
          {workflowEventsPaused ? (
            <IconPlayerPlay size={14} stroke={1.5} />
          ) : (
            <IconPlayerPause size={14} stroke={1.5} />
          )}
          {workflowEventsPaused ? "Resume events" : "Pause events"}
        </button>
      ) : null}
      {workflowEventCount > 0 && onClearWorkflowEvents ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--gray-200))] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Automation event queue actions"
            >
              <IconDots size={16} stroke={1.5} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onClearWorkflowEvents}
            >
              Clear automation events ({workflowEventCount})
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function PendingItemsStrip({
  items,
  onRemove,
  workflowEvents,
  onRemoveWorkflowEvent,
  workflowEventsPaused,
  workflowEventsPauseReason,
  onSetWorkflowEventsPaused,
  onClearWorkflowEvents,
  activeGoal,
  onCancelGoal,
  onOpenGoal,
}: {
  items: QueuedComposerItem[] | undefined;
  onRemove?: (id: string) => void;
  workflowEvents: WorkflowEventComposerItem[] | undefined;
  onRemoveWorkflowEvent?: (id: string) => void;
  workflowEventsPaused: boolean;
  workflowEventsPauseReason?: string | null;
  onSetWorkflowEventsPaused?: (paused: boolean) => void;
  onClearWorkflowEvents?: () => void;
  activeGoal?: ActiveGoalComposerItem;
  onCancelGoal?: () => void;
  onOpenGoal?: () => void;
}) {
  const queued = items ?? [];
  const events = workflowEvents ?? [];
  const count = queued.length + events.length;
  const messageLabel = `${queued.length} ${queued.length === 1 ? "message" : "messages"}`;
  const eventLabel = `${events.length} ${events.length === 1 ? "event" : "events"}`;
  const label =
    queued.length > 0 && events.length > 0
      ? `${messageLabel} and ${eventLabel} waiting`
      : `${queued.length > 0 ? messageLabel : eventLabel} waiting`;
  if (count === 0 && !activeGoal && !workflowEventsPaused) {
    return null;
  }
  return (
    <div className="relative z-0 mx-5 -mb-6 overflow-hidden rounded-xl bg-gray-50 dark:bg-gray-100">
      {count > 0 || workflowEventsPaused ? (
        <PendingItemsStripHeader
          count={count}
          label={label}
          workflowEventCount={events.length}
          workflowEventsPaused={workflowEventsPaused}
          onSetWorkflowEventsPaused={onSetWorkflowEventsPaused}
          onClearWorkflowEvents={onClearWorkflowEvents}
        />
      ) : null}
      {workflowEventsPaused ? (
        <div className="mx-4 mb-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
          Automation events paused
          {workflowEventsPauseReason ? `: ${workflowEventsPauseReason}` : ""}.
          New events keep queueing and run after you resume.
        </div>
      ) : null}
      <div className="max-h-[200px] overflow-y-auto px-2 pb-7 pt-1" role="list">
        {queued.map((item) => {
          return (
            <ComposerStripRow
              key={item.id}
              kind="queued"
              text={item.text}
              onRemove={() => {
                onRemove?.(item.id);
              }}
              removeAriaLabel="Remove queued message"
            />
          );
        })}
        {events.map((event) => {
          return (
            <ComposerStripRow
              key={event.id}
              kind="workflow-event"
              text={event.text}
              onRemove={() => {
                onRemoveWorkflowEvent?.(event.id);
              }}
              removeAriaLabel="Skip automation event"
            />
          );
        })}
        {/* The active goal sits last — below queued messages and workflow events
            — because it only runs once the queue drains. Like other pending
            items it can be cancelled from the strip. */}
        {activeGoal ? (
          <ComposerStripRow
            kind="goal"
            text={activeGoal.objective}
            onOpenDetail={onOpenGoal}
            onRemove={() => {
              onCancelGoal?.();
            }}
            removeAriaLabel="Cancel goal"
          />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connector sub-components
// ---------------------------------------------------------------------------

function isSelectedPresentationTemplate(
  item: PresentationTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "presentation" &&
    value.selection.templateId === item.templateId
  );
}

function toPresentationGenerationTemplate(
  item: PresentationTemplateItem,
  colorSystemId = presentationTemplateColorSystemId(
    defaultPresentationTemplateThemeId(item),
  ),
): GenerationTemplateRequest {
  return {
    type: "presentation",
    selection: {
      templateId: item.templateId,
      colorSystemId,
      previewUrl: item.embedUrl,
    },
  };
}

function selectedTemplateTitle(
  value: GenerationTemplateRequest | undefined,
): string | undefined {
  if (value?.type === "video") {
    return selectedVideoTemplateItem(value)?.title;
  }
  if (value?.type === "workflow") {
    return selectedWorkflowTemplateItem(value)?.title;
  }
  if (value?.type === "website") {
    return selectedWebsiteTemplateItem(value)?.title;
  }
  return (
    selectedPresentationTemplateItem(value)?.title ??
    selectedIllustrationTemplateItem(value)?.title
  );
}

function selectedPresentationTemplateItem(
  value: GenerationTemplateRequest | undefined,
): PresentationTemplateItem | undefined {
  if (value?.type !== "presentation") {
    return undefined;
  }
  return PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
    return isSelectedPresentationTemplate(item, value);
  });
}

function isSelectedIllustrationTemplate(
  item: IllustrationTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "illustration" &&
    value.selection.illustrationStyleId === item.illustrationStyleId
  );
}

function toIllustrationGenerationTemplate(
  item: IllustrationTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "illustration",
    selection: {
      illustrationStyleId: item.illustrationStyleId,
    },
  };
}

function selectedIllustrationTemplateItem(
  value: GenerationTemplateRequest | undefined,
): IllustrationTemplateItem | undefined {
  if (value?.type !== "illustration") {
    return undefined;
  }
  return ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
    return isSelectedIllustrationTemplate(item, value);
  });
}

function isSelectedVideoTemplate(
  item: VideoTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "video" &&
    findVideoTemplateItem(value.selection.stylePresetId)?.id === item.id
  );
}

function toVideoGenerationTemplate(
  item: VideoTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "video",
    selection: { stylePresetId: item.id },
  };
}

function selectedVideoTemplateItem(
  value: GenerationTemplateRequest | undefined,
): VideoTemplateItem | undefined {
  if (value?.type !== "video") {
    return undefined;
  }
  return findVideoTemplateItem(value.selection.stylePresetId);
}

function isSelectedWorkflowTemplate(
  item: WorkflowTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "workflow" && value.selection.workflowTemplateId === item.id
  );
}

function toWorkflowGenerationTemplate(
  item: WorkflowTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "workflow",
    selection: { workflowTemplateId: item.id },
  };
}

function selectedWorkflowTemplateItem(
  value: GenerationTemplateRequest | undefined,
): WorkflowTemplateItem | undefined {
  if (value?.type !== "workflow") {
    return undefined;
  }
  return findWorkflowTemplateItem(value.selection.workflowTemplateId);
}

function workflowTemplateMatchesSearch(
  item: WorkflowTemplateItem,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const searchable = [
    item.title,
    item.id,
    item.description,
    item.connectors.join(" "),
  ].join(" ");
  return searchable.toLowerCase().includes(normalizedQuery);
}

function isSelectedWebsiteTemplate(
  item: WebsiteTemplateItem,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return (
    value?.type === "website" &&
    findWebsiteTemplateItem(value.selection.websiteTemplateId)?.id === item.id
  );
}

function toWebsiteGenerationTemplate(
  item: WebsiteTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "website",
    selection: { websiteTemplateId: item.id },
  };
}

function selectedWebsiteTemplateItem(
  value: GenerationTemplateRequest | undefined,
): WebsiteTemplateItem | undefined {
  if (value?.type !== "website") {
    return undefined;
  }
  return findWebsiteTemplateItem(value.selection.websiteTemplateId);
}

function websiteTemplateCardImageUrl(item: WebsiteTemplateItem): string {
  return r2ImageTransformUrl(item.previewImageUrl, TEMPLATE_CARD_PREVIEW_SIZE);
}

function playVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  detach(video.play(), Reason.DomCallback);
}

function markVideoTemplatePreviewPlaying(
  video: HTMLVideoElement | null,
  playing: boolean,
): void {
  if (!video) {
    return;
  }
  video.dataset.previewPlaying = playing ? "true" : "false";
}

function resetVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  video.pause();
  video.currentTime = 0;
  markVideoTemplatePreviewPlaying(video, false);
}

function toggleVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video || (!video.paused && !video.ended)) {
    return;
  }
  playVideoTemplatePreview(video);
}

function videoTemplatePosterImage(item: VideoTemplateItem): string {
  if (item.cardPreviewImage !== undefined) {
    return r2ImageTransformUrl(
      item.cardPreviewImage,
      TEMPLATE_CARD_PREVIEW_SIZE,
    );
  }
  return r2ImageTransformUrl(item.previewImage, TEMPLATE_CARD_PREVIEW_SIZE);
}

function VideoTemplatePreview({ item }: { item: VideoTemplateItem }) {
  const { t } = useTranslation();
  const posterImage = videoTemplatePosterImage(item);
  return (
    <div
      data-video-template-preview=""
      className="group/video-template-preview relative h-full w-full overflow-hidden bg-muted"
      onMouseEnter={(event) => {
        toggleVideoTemplatePreview(event.currentTarget.querySelector("video"));
      }}
      onMouseLeave={(event) => {
        resetVideoTemplatePreview(event.currentTarget.querySelector("video"));
      }}
    >
      <video
        poster={posterImage}
        className="peer h-full w-full object-cover"
        preload="none"
        playsInline
        muted
        loop
        onPlaying={(event) => {
          markVideoTemplatePreviewPlaying(event.currentTarget, true);
        }}
        onPause={(event) => {
          markVideoTemplatePreviewPlaying(event.currentTarget, false);
        }}
        onEnded={(event) => {
          resetVideoTemplatePreview(event.currentTarget);
        }}
        onError={(event) => {
          markVideoTemplatePreviewPlaying(event.currentTarget, false);
        }}
      >
        <source src={item.previewWebm} type="video/webm; codecs=vp9" />
        <source src={item.previewVideo} type="video/mp4" />
      </video>
      <img
        src={posterImage}
        alt=""
        aria-hidden="true"
        data-video-template-poster=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-200 peer-data-[preview-playing=true]:opacity-0"
      />
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.playVideo;
          },
          {
            title: item.title,
          },
        )}
        className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/0 text-white opacity-100 transition-colors duration-200 hover:bg-black/25 focus-visible:bg-black/25 focus-visible:outline-none peer-data-[preview-playing=true]:pointer-events-none peer-data-[preview-playing=true]:!opacity-0"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleVideoTemplatePreview(
            event.currentTarget.parentElement?.querySelector("video") ?? null,
          );
        }}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition-transform group-hover/video-template-preview:scale-105">
          <IconPlayerPlay size={20} stroke={1.8} />
        </span>
      </button>
    </div>
  );
}

/**
 * Soft, cool-tinted card shadow matching the home chat composer
 * (`--zero-card-shadow`). The token is scoped to `.zero-app`, but the template
 * picker renders through a Radix portal on `document.body` — outside that
 * scope — so the value is inlined here instead of referencing the CSS var.
 * Replaces Tailwind `shadow-sm`, whose hard black tint reads muddy on white.
 */
const TEMPLATE_CARD_SHADOW =
  "shadow-[0_2px_12px_hsl(220_12%_50%/0.04),0_0_0_0.5px_hsl(220_12%_50%/0.02)]";

function VideoTemplateCard({
  item,
  selected,
  onSelect,
}: {
  item: VideoTemplateItem;
  selected: boolean;
  onSelect: (item: VideoTemplateItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "group flex h-64 flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/20",
        TEMPLATE_CARD_SHADOW,
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <div className="relative h-44 shrink-0 overflow-hidden bg-muted">
        <VideoTemplatePreview item={item} />
      </div>
      <div className="flex flex-1 items-center justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {item.title}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={t(
              ($) => {
                return $.artifacts.templates.selectVideo;
              },
              {
                title: item.title,
              },
            )}
            aria-pressed={selected}
            onClick={() => {
              onSelect(item);
            }}
            className={cn(
              "h-8 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-background text-foreground hover:bg-muted",
            )}
          >
            {t(($) => {
              return $.artifacts.templates.use;
            })}
          </button>
        </div>
      </div>
    </div>
  );
}

function VideoTemplateGrid({
  items,
  value,
  onSelect,
}: {
  items: readonly VideoTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: VideoTemplateItem) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <VideoTemplateCard
            key={item.id}
            item={item}
            selected={isSelectedVideoTemplate(item, value)}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

function WebsiteTemplateCard({
  item,
  selected,
  onSelect,
  onPreview,
}: {
  item: WebsiteTemplateItem;
  selected: boolean;
  onSelect: (item: WebsiteTemplateItem) => void;
  onPreview: (item: WebsiteTemplateItem) => void;
}) {
  const { t } = useTranslation();
  const previewImageUrl = websiteTemplateCardImageUrl(item);
  const preview = () => {
    onPreview(item);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t(
        ($) => {
          return $.artifacts.templates.previewWebsite;
        },
        {
          title: item.title,
        },
      )}
      onClick={preview}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          preview();
        }
      }}
      className={cn(
        "group flex cursor-zoom-in flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        TEMPLATE_CARD_SHADOW,
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <div className="relative aspect-[16/9] shrink-0 overflow-hidden bg-muted">
        <img
          alt={t(
            ($) => {
              return $.artifacts.templates.websitePreview;
            },
            {
              title: item.title,
            },
          )}
          title={t(
            ($) => {
              return $.artifacts.templates.websitePreview;
            },
            {
              title: item.title,
            },
          )}
          src={previewImageUrl}
          loading="eager"
          decoding="async"
          fetchPriority="high"
          draggable={false}
          className="pointer-events-none h-full w-full bg-background object-cover"
        />
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-2 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {item.title}
          </p>
        </div>
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectWebsite;
            },
            {
              title: item.title,
            },
          )}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(item);
          }}
          className={cn(
            "h-8 shrink-0 cursor-pointer rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-background text-foreground hover:bg-muted",
          )}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
    </div>
  );
}

function WebsiteTemplateGrid({
  items,
  value,
  onSelect,
  onPreview,
}: {
  items: readonly WebsiteTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: WebsiteTemplateItem) => void;
  onPreview: (item: WebsiteTemplateItem) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <WebsiteTemplateCard
            key={item.id}
            item={item}
            selected={isSelectedWebsiteTemplate(item, value)}
            onSelect={onSelect}
            onPreview={onPreview}
          />
        );
      })}
    </div>
  );
}

function WorkflowTemplateConnectorIcons({
  connectors,
  compact = false,
  limit = compact ? 3 : 5,
  withDivider = false,
}: {
  connectors: readonly string[];
  compact?: boolean;
  limit?: number;
  withDivider?: boolean;
}) {
  const catalogConnectors = useLastResolved(allConnectorCatalogItems$);
  const visibleConnectors = connectors.flatMap((connectorSlug) => {
    const connector = catalogConnectors?.find((candidate) => {
      return candidate.connectorRef === connectorSlug;
    });
    return connector ? [connector] : [];
  });
  if (visibleConnectors.length === 0) {
    return null;
  }

  const displayedConnectors = visibleConnectors.slice(0, limit);
  const remainingCount = visibleConnectors.length - displayedConnectors.length;
  return (
    <>
      {withDivider ? (
        <span className="h-3.5 w-px shrink-0 bg-border/70" />
      ) : null}
      <span
        className={cn(
          "flex min-w-0 items-center",
          compact ? "gap-1" : "gap-1.5",
        )}
      >
        {displayedConnectors.map((connector) => {
          return (
            <span
              key={connector.connectorRef}
              className={cn(
                "flex shrink-0 items-center justify-center border border-border/60 bg-background",
                compact ? "h-5 w-5 rounded" : "h-7 w-7 rounded-md",
              )}
            >
              <ConnectorIcon icon={connector.icon} size={compact ? 12 : 14} />
            </span>
          );
        })}
        {remainingCount > 0 ? (
          <span
            className={cn(
              "flex shrink-0 items-center justify-center rounded border border-border/60 bg-background text-[10px] font-medium text-muted-foreground",
              compact ? "h-5 min-w-5 px-1" : "h-7 min-w-7 px-1.5",
            )}
          >
            +{remainingCount}
          </span>
        ) : null}
      </span>
    </>
  );
}

function WorkflowTemplateCard({
  item,
  selected,
  onSelect,
}: {
  item: WorkflowTemplateItem;
  selected: boolean;
  onSelect: (item: WorkflowTemplateItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "group flex flex-col rounded-lg border bg-card p-4 transition-colors hover:bg-muted/20",
        TEMPLATE_CARD_SHADOW,
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <p className="text-sm font-semibold text-foreground">{item.title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        {item.description}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-3.5">
        <WorkflowTemplateConnectorIcons
          connectors={item.connectors}
          limit={4}
        />
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectWorkflow;
            },
            {
              title: item.title,
            },
          )}
          aria-pressed={selected}
          onClick={() => {
            onSelect(item);
          }}
          className={cn(
            "ml-auto h-8 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-background text-foreground hover:bg-muted",
          )}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
    </div>
  );
}

// Resolves the workflow template tab's data in one place: the persona pills
// present in the catalog, the active pill (falling back to "all"), and the
// items after both the pill and the search filter. Kept out of
// TemplatePickerDialog so that component stays under its complexity budget.
function resolveWorkflowCatalog({
  categoryFilter,
  search,
}: {
  categoryFilter: string;
  search: string;
}): ResolvedWorkflowTemplateCatalog {
  const pills = WORKFLOW_TEMPLATE_CATEGORIES.filter((categoryName) => {
    return WORKFLOW_TEMPLATE_ITEMS.some((item) => {
      return item.category === categoryName;
    });
  });
  const active = pills.includes(categoryFilter) ? categoryFilter : "all";
  const items = WORKFLOW_TEMPLATE_ITEMS.filter((item) => {
    const matchesCategory = active === "all" || item.category === active;
    return matchesCategory && workflowTemplateMatchesSearch(item, search);
  });
  return { pills, active, items };
}

interface ResolvedWorkflowTemplateCatalog {
  pills: readonly string[];
  active: string;
  items: readonly WorkflowTemplateItem[];
}

// Persona pill filter for the workflow template tab, styled like the in-app
// Ideas & Use Cases gallery: an "All" pill plus one pill per persona.
function WorkflowTemplatePillRow({
  pills,
  active,
  onSelect,
}: {
  pills: readonly string[];
  active: string;
  onSelect: (category: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-5 pt-4">
      {["all", ...pills].map((pill) => {
        const isActive = active === pill;
        return (
          <button
            key={pill}
            type="button"
            aria-pressed={isActive}
            className={cn(
              "h-7 shrink-0 rounded-md border border-border px-2.5 text-sm font-medium leading-none transition-colors cursor-pointer",
              isActive
                ? "bg-muted text-foreground"
                : "bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
            onClick={() => {
              onSelect(pill);
            }}
          >
            {pill === "all"
              ? t(($) => {
                  return $.artifacts.templates.all;
                })
              : pill}
          </button>
        );
      })}
    </div>
  );
}

// Renders the (already search + pill filtered) templates as a flat grid.
// Categorization is handled by the persona pill row above, so there are no
// per-persona section headers — items stay in catalog order (General first)
// so related cards still cluster.
function WorkflowTemplateGrid({
  items,
  value,
  onSelect,
}: {
  items: readonly WorkflowTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: WorkflowTemplateItem) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <WorkflowTemplateCard
            key={item.id}
            item={item}
            selected={isSelectedWorkflowTemplate(item, value)}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

function TemplateEmptyPanel() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-40 flex-1 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
      <div className="flex max-w-xl flex-col items-center">
        <IconSearch
          className="mb-4 h-8 w-8 text-muted-foreground/70"
          stroke={1.7}
        />
        <p className="text-sm font-semibold text-muted-foreground">
          {t(($) => {
            return $.artifacts.templates.noMatches;
          })}
        </p>
        <p className="mt-2 text-sm text-muted-foreground/80">
          {t(($) => {
            return $.artifacts.templates.tryDifferentSearch;
          })}
        </p>
      </div>
    </div>
  );
}

function presentationTemplateSlideCount(
  item: PresentationTemplateItem,
): number {
  return Math.max(item.slideCount ?? item.previewImages.length, 1);
}

function presentationTemplateThemedCardPreviewSource(
  item: PresentationTemplateItem,
  theme: PresentationTemplateThemeOption | undefined,
): string | undefined {
  if (theme === undefined) {
    return item.cardPreviewImage;
  }
  return item.cardPreviewImagesByTheme?.[theme.id] ?? item.cardPreviewImage;
}

function presentationTemplateCardSlideImage(
  item: PresentationTemplateItem,
  index: number,
  theme?: PresentationTemplateThemeOption,
  size: TemplatePreviewImageSize = TEMPLATE_CARD_PREVIEW_SIZE,
): string {
  const cardPreviewSource =
    index === 0
      ? presentationTemplateThemedCardPreviewSource(item, theme)
      : undefined;
  if (cardPreviewSource !== undefined) {
    return r2ImageTransformUrl(cardPreviewSource, size);
  }
  return presentationTemplateGallerySlideImage(item, index, size);
}

function presentationTemplateGallerySlideImage(
  item: PresentationTemplateItem,
  index: number,
  size: TemplatePreviewImageSize = TEMPLATE_CARD_PREVIEW_SIZE,
): string {
  return r2ImageTransformUrl(
    presentationTemplateGallerySlideUrl(item, index),
    size,
  );
}

function presentationTemplateGallerySlideUrl(
  item: PresentationTemplateItem,
  index: number,
): string {
  const safeIndex = Math.max(
    0,
    Math.min(index, PRESENTATION_GALLERY_SLIDE_COUNT - 1),
  );
  const slideNumber = String(safeIndex + 1).padStart(3, "0");
  return `${PRESENTATION_GALLERY_PREVIEW_BASE_URL}/${item.slug}/slide-${slideNumber}.webp`;
}

function presentationTemplateHighResolutionSlideImage(
  item: PresentationTemplateItem,
  index: number,
  theme: PresentationTemplateThemeOption,
  size: TemplatePreviewImageSize = TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE,
): string {
  if (index === 0) {
    return presentationTemplateCardSlideImage(item, index, theme, size);
  }
  return presentationTemplateGallerySlideImage(item, index, size);
}

function presentationTemplateDetailSlideImageSource(
  item: PresentationTemplateItem,
  index: number,
  theme: PresentationTemplateThemeOption,
  htmlPreviewFailed: boolean,
): string {
  if (index === 0) {
    return (
      presentationTemplateThemedCardPreviewSource(item, theme) ??
      presentationTemplateGallerySlideUrl(item, index)
    );
  }
  if (htmlPreviewFailed) {
    return presentationTemplateGallerySlideUrl(item, index);
  }
  return (
    item.previewImages[index] ??
    presentationTemplateGallerySlideUrl(item, index)
  );
}

function prewarmTemplatePreviewImage(
  runtime: TemplatePreviewRuntime,
  url: string,
): void {
  if (typeof Image === "undefined") {
    return;
  }

  const cachedImage = runtime.imagePreloads.get(url);
  if (cachedImage !== undefined) {
    return;
  }

  const image = new Image();
  image.decoding = "async";
  image.loading = "eager";
  image.fetchPriority = "high";
  image.src = url;
  runtime.imagePreloads.set(url, image);
  if (image.decode !== undefined) {
    detach(bestEffort(image.decode()), Reason.DomCallback);
  }
}

function uniqueTemplatePreviewImageUrls(
  imageUrls: readonly string[],
): string[] {
  const uniqueUrls: string[] = [];
  const seenUrls = new Set<string>();
  for (const imageUrl of imageUrls) {
    if (seenUrls.has(imageUrl)) {
      continue;
    }
    seenUrls.add(imageUrl);
    uniqueUrls.push(imageUrl);
  }
  return uniqueUrls;
}

function prewarmTemplatePreviewImages(
  runtime: TemplatePreviewRuntime,
  imageUrls: readonly string[],
  count = TEMPLATE_PREWARM_IMAGE_COUNT,
): void {
  const uniqueUrls = uniqueTemplatePreviewImageUrls(imageUrls);
  for (const imageUrl of uniqueUrls.slice(0, count)) {
    prewarmTemplatePreviewImage(runtime, imageUrl);
  }
}

function presentationPreviewImageUrlsForItems(
  items: readonly PresentationTemplateItem[],
  themeIdBySlug: Readonly<Record<string, string>> = {},
): string[] {
  return items.map((item) => {
    const theme = findPresentationTemplateTheme(
      themeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
    );
    return presentationTemplateCardSlideImage(item, 0, theme);
  });
}

function illustrationPreviewImageUrlsForItems({
  items,
  variantIndexBySlug,
}: {
  items: readonly IllustrationTemplateItem[];
  variantIndexBySlug: Readonly<Record<string, number>>;
}): string[] {
  return items.map((item) => {
    const images = item.previewImages;
    const activeIndex = Math.max(
      0,
      Math.min(variantIndexBySlug[item.slug] ?? 0, images.length - 1),
    );
    return illustrationHeroImageUrl(images[activeIndex] ?? item.previewImage);
  });
}

function videoPreviewImageUrlsForItems(
  items: readonly VideoTemplateItem[],
): string[] {
  return items.map((item) => {
    return videoTemplatePosterImage(item);
  });
}

function websitePreviewImageUrlsForItems(
  items: readonly WebsiteTemplateItem[],
): string[] {
  return items.map((item) => {
    return websiteTemplateCardImageUrl(item);
  });
}

function initialTemplatePreviewImageUrlsForCategory({
  category,
  hasPptTab,
  hasIllustrationTab,
  hasVideoTab,
  presentationThemeIdBySlug,
}: {
  category: string;
  hasPptTab: boolean;
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
  presentationThemeIdBySlug?: Readonly<Record<string, string>>;
}): string[] {
  if (category === "slides" && hasPptTab) {
    return presentationPreviewImageUrlsForItems(
      PRESENTATION_TEMPLATE_PICKER_ITEMS,
      presentationThemeIdBySlug,
    );
  }
  if (category === "illustration" && hasIllustrationTab) {
    return illustrationPreviewImageUrlsForItems({
      items: ILLUSTRATION_TEMPLATE_ITEMS,
      variantIndexBySlug: {},
    });
  }
  if (category === "video" && hasVideoTab) {
    return videoPreviewImageUrlsForItems(VIDEO_TEMPLATE_ITEMS);
  }
  if (category === "website") {
    return websitePreviewImageUrlsForItems(WEBSITE_TEMPLATE_ITEMS);
  }
  return [];
}

function templatePreviewPrewarmImageCountForCategory(category: string): number {
  if (category === "illustration") {
    return ILLUSTRATION_PREWARM_IMAGE_COUNT;
  }
  return TEMPLATE_PREWARM_IMAGE_COUNT;
}

function prewarmIllustrationPreviewImagesNearScroll({
  items,
  runtime,
  scrollContainer,
  variantIndexBySlug,
}: {
  items: readonly IllustrationTemplateItem[];
  runtime: TemplatePreviewRuntime;
  scrollContainer: HTMLElement;
  variantIndexBySlug: Readonly<Record<string, number>>;
}): void {
  const scrollableHeight =
    scrollContainer.scrollHeight - scrollContainer.clientHeight;
  if (items.length === 0 || scrollableHeight <= 0) {
    return;
  }

  const progress = Math.min(
    1,
    Math.max(0, scrollContainer.scrollTop / scrollableHeight),
  );
  const lookaheadIndex =
    Math.floor(progress * items.length) +
    ILLUSTRATION_SCROLL_PREWARM_LOOKAHEAD_COUNT;
  const bucket = Math.floor(
    lookaheadIndex / ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
  );
  const startIndex = Math.min(
    items.length,
    Math.max(
      ILLUSTRATION_PREWARM_IMAGE_COUNT,
      bucket * ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
    ),
  );
  const firstPrewarmItem = items[startIndex];
  const key = [
    String(items.length),
    String(bucket),
    firstPrewarmItem?.slug ?? "",
  ].join(":");
  if (scrollContainer.dataset.illustrationPreviewPrewarmBucket === key) {
    return;
  }
  scrollContainer.dataset.illustrationPreviewPrewarmBucket = key;

  prewarmTemplatePreviewImages(
    runtime,
    illustrationPreviewImageUrlsForItems({
      items: items.slice(
        startIndex,
        startIndex + ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
      ),
      variantIndexBySlug,
    }),
    ILLUSTRATION_SCROLL_PREWARM_IMAGE_COUNT,
  );
}

interface PresentationTemplateThemeOption {
  readonly id: string;
  readonly name: string;
  readonly group: "multi-accent" | "single-accent";
  readonly paletteName: string;
  readonly colors: readonly [
    bg: string,
    surface: string,
    ink: string,
    inkSoft: string,
    accent: string,
    support1: string,
    support2: string,
    support3: string,
    placeholder: string,
  ];
}

const PRESENTATION_TEMPLATE_THEME_OPTIONS: readonly PresentationTemplateThemeOption[] =
  [
    {
      id: "prism",
      name: "Prism",
      group: "multi-accent",
      paletteName: "Prism",
      colors: [
        "#FFFFFF",
        "#F7F7FA",
        "#1A1726",
        "#5C5870",
        "#7257E6",
        "#FF6B4A",
        "#AEE63E",
        "#3FA9F5",
        "#ECECF2",
      ],
    },
    {
      id: "carnival",
      name: "Carnival",
      group: "multi-accent",
      paletteName: "Carnival",
      colors: [
        "#FFFDF7",
        "#FFFFFF",
        "#221C14",
        "#5E564A",
        "#FF7A1A",
        "#E5388E",
        "#F5B73E",
        "#1FB6A6",
        "#EFEADF",
      ],
    },
    {
      id: "pop-art",
      name: "Pop Art",
      group: "multi-accent",
      paletteName: "Pop Art",
      colors: [
        "#111016",
        "#1B1A22",
        "#F4F2FA",
        "#A09CB0",
        "#3D7BFF",
        "#FF3D9A",
        "#C6FF4A",
        "#FF7A1A",
        "#26242E",
      ],
    },
    {
      id: "warm-sand",
      name: "Warm Sand",
      group: "single-accent",
      paletteName: "Warm Sand",
      colors: [
        "#FFFDF8",
        "#FFFFFF",
        "#262626",
        "#5A5A5A",
        "#F19B3A",
        "#8DACE5",
        "#DDB8D9",
        "#516049",
        "#ECECEC",
      ],
    },
    {
      id: "bauhaus-primary",
      name: "Bauhaus Primary",
      group: "single-accent",
      paletteName: "Bauhaus Primary",
      colors: [
        "#F5F1E6",
        "#FFFFFF",
        "#1A1A1A",
        "#4A4A4A",
        "#E63327",
        "#2C5BD6",
        "#F2B705",
        "#1A1A1A",
        "#E2DDD0",
      ],
    },
    {
      id: "nordic-frost",
      name: "Nordic Frost",
      group: "single-accent",
      paletteName: "Nordic Frost",
      colors: [
        "#FBFCFD",
        "#FFFFFF",
        "#1F2933",
        "#5B6B7B",
        "#3E8EDE",
        "#7BC6C9",
        "#B8C4D0",
        "#1F2933",
        "#E8EDF1",
      ],
    },
    {
      id: "forest-editorial",
      name: "Forest Editorial",
      group: "single-accent",
      paletteName: "Forest Editorial",
      colors: [
        "#F7F6F1",
        "#FFFFFF",
        "#1E2B22",
        "#4F5C52",
        "#5B7553",
        "#C97B4A",
        "#E4DFD0",
        "#1E2B22",
        "#E6E8E1",
      ],
    },
    {
      id: "coral-studio",
      name: "Coral Studio",
      group: "single-accent",
      paletteName: "Coral Studio",
      colors: [
        "#FFF9F6",
        "#FFFFFF",
        "#3A2A26",
        "#6E5B55",
        "#FF6F5E",
        "#FFB199",
        "#2BB3A3",
        "#3A2A26",
        "#F0E7E2",
      ],
    },
    {
      id: "slate-corporate",
      name: "Slate Corporate",
      group: "single-accent",
      paletteName: "Slate Corporate",
      colors: [
        "#FFFFFF",
        "#F6F8FB",
        "#16243B",
        "#5A6678",
        "#2F5BD0",
        "#6E8BB8",
        "#F0A03A",
        "#16243B",
        "#E9EDF3",
      ],
    },
    {
      id: "terracotta-clay",
      name: "Terracotta Clay",
      group: "single-accent",
      paletteName: "Terracotta Clay",
      colors: [
        "#FBF4EC",
        "#FFFFFF",
        "#3B2A20",
        "#6B5546",
        "#C36A3F",
        "#D9A441",
        "#7A7A52",
        "#EAD9C6",
        "#ECE0D2",
      ],
    },
    {
      id: "berry-pop",
      name: "Berry Pop",
      group: "single-accent",
      paletteName: "Berry Pop",
      colors: [
        "#FFFAFC",
        "#FFFFFF",
        "#2E1A2C",
        "#6A5566",
        "#D63A8E",
        "#8E5BD0",
        "#F4B8D4",
        "#2E1A2C",
        "#F0E6EC",
      ],
    },
    {
      id: "citrus-fresh",
      name: "Citrus Fresh",
      group: "single-accent",
      paletteName: "Citrus Fresh",
      colors: [
        "#FFFFFB",
        "#FFFFFF",
        "#232318",
        "#5C5C4E",
        "#FF8A1E",
        "#FFD23E",
        "#8FB339",
        "#4FA3A3",
        "#EDEDE3",
      ],
    },
    {
      id: "mauve-dusk",
      name: "Mauve Dusk",
      group: "single-accent",
      paletteName: "Mauve Dusk",
      colors: [
        "#FAF7FB",
        "#FFFFFF",
        "#2B2533",
        "#635B70",
        "#9C7BB8",
        "#8AA0C9",
        "#E0B6C9",
        "#2B2533",
        "#ECE7F0",
      ],
    },
    {
      id: "mono-ink",
      name: "Mono Ink",
      group: "single-accent",
      paletteName: "Mono Ink",
      colors: [
        "#FFFFFF",
        "#FAFAFA",
        "#0A0A0A",
        "#6B6B6B",
        "#E5392E",
        "#0A0A0A",
        "#BFBFBF",
        "#0A0A0A",
        "#EEEEEE",
      ],
    },
    {
      id: "sunset-maroon",
      name: "Sunset Maroon",
      group: "single-accent",
      paletteName: "Sunset Maroon",
      colors: [
        "#FFF7F2",
        "#FFFFFF",
        "#3A1F22",
        "#6E4A4C",
        "#F26B3A",
        "#E0457B",
        "#F2A93B",
        "#3A1F22",
        "#F0E2DA",
      ],
    },
    {
      id: "mint-tech",
      name: "Mint Tech",
      group: "single-accent",
      paletteName: "Mint Tech",
      colors: [
        "#FBFFFD",
        "#FFFFFF",
        "#1B2A26",
        "#56655F",
        "#16B981",
        "#4FA3E0",
        "#9AE6C8",
        "#3A4A45",
        "#E6F0EB",
      ],
    },
    {
      id: "midnight-mono",
      name: "Midnight Mono",
      group: "single-accent",
      paletteName: "Midnight Mono",
      colors: [
        "#121316",
        "#1C1E22",
        "#F2F2F0",
        "#A0A3A8",
        "#C6FF4A",
        "#6B7280",
        "#3A3D44",
        "#C6FF4A",
        "#2A2C31",
      ],
    },
    {
      id: "ocean-deep",
      name: "Ocean Deep",
      group: "single-accent",
      paletteName: "Ocean Deep",
      colors: [
        "#0E2A33",
        "#143840",
        "#EAF6F4",
        "#9DB8B8",
        "#38C7B4",
        "#5A93A8",
        "#1F4A52",
        "#38C7B4",
        "#1B454E",
      ],
    },
    {
      id: "gold-luxe",
      name: "Gold Luxe",
      group: "single-accent",
      paletteName: "Gold Luxe",
      colors: [
        "#16140F",
        "#211E16",
        "#F3EEE2",
        "#ADA48E",
        "#C9A24B",
        "#8A6E3A",
        "#3A352A",
        "#C9A24B",
        "#2A271E",
      ],
    },
  ];

function defaultPresentationTemplateThemeId(
  item: PresentationTemplateItem,
): string {
  return item.colorSystemId?.replace("color-system:", "") ?? "warm-sand";
}

function presentationTemplateColorSystemId(themeId: string): string {
  return `color-system:${themeId}`;
}

function findPresentationTemplateTheme(
  themeId: string,
): PresentationTemplateThemeOption {
  return (
    PRESENTATION_TEMPLATE_THEME_OPTIONS.find((theme) => {
      return theme.id === themeId;
    }) ?? PRESENTATION_TEMPLATE_THEME_OPTIONS[0]!
  );
}

function presentationTemplateThemePreviewSwatches(
  theme: PresentationTemplateThemeOption,
): readonly { readonly color: string; readonly id: string }[] {
  const background = theme.colors[0];
  const accents = theme.colors.slice(4, 8);
  return [
    { id: "background", color: background },
    ...accents.slice(0, 3).map((accent, accentIndex) => {
      return { id: `accent-${accentIndex + 1}`, color: accent };
    }),
  ];
}

function isPresentationTemplateSupport2SwatchSlug(slug: string): boolean {
  return (
    slug === "playful-launch-presentation" ||
    slug === "crayon-learning-deck" ||
    slug === "mosaic-geometric-pitch"
  );
}

function presentationTemplateAccentSwatchColor(
  item: PresentationTemplateItem,
  theme: PresentationTemplateThemeOption,
): { readonly color: string; readonly id: string } {
  if (item.slug === "landing-consulting-deck") {
    return { id: "support-1", color: theme.colors[5] };
  }
  if (isPresentationTemplateSupport2SwatchSlug(item.slug)) {
    return { id: "support-2", color: theme.colors[6] };
  }
  return { id: "accent", color: theme.colors[4] };
}

function presentationTemplateThemeAccentSwatches(
  item: PresentationTemplateItem,
  theme: PresentationTemplateThemeOption,
): readonly { readonly color: string; readonly id: string }[] {
  return [
    { id: "background", color: theme.colors[0] },
    presentationTemplateAccentSwatchColor(item, theme),
  ];
}

function hexLuminance(hexColor: string): number {
  const normalized = hexColor.replace("#", "");
  const channels = [0, 2, 4].map((index) => {
    const value = Number.parseInt(normalized.slice(index, index + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

function contrastRatio(colorA: string, colorB: string): number {
  const luminanceA = hexLuminance(colorA);
  const luminanceB = hexLuminance(colorB);
  return (
    (Math.max(luminanceA, luminanceB) + 0.05) /
    (Math.min(luminanceA, luminanceB) + 0.05)
  );
}

function hexToRgb(hexColor: string): readonly [number, number, number] {
  const normalized = hexColor.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb
    .map((value) => {
      return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
    })
    .join("")}`;
}

function mixRgb(
  colorA: readonly [number, number, number],
  colorB: readonly [number, number, number],
  amount: number,
): readonly [number, number, number] {
  return [
    Math.round(colorA[0] * (1 - amount) + colorB[0] * amount),
    Math.round(colorA[1] * (1 - amount) + colorB[1] * amount),
    Math.round(colorA[2] * (1 - amount) + colorB[2] * amount),
  ];
}

function previewTextColorOn(background: string): string {
  return hexLuminance(background) > 0.45 ? "#15151A" : "#FFFFFF";
}

function safePreviewGround(accent: string): readonly [string, string] {
  const text = hexLuminance(accent) < 0.5 ? "#FFFFFF" : "#15131C";
  const target: readonly [number, number, number] =
    text === "#FFFFFF" ? [10, 9, 14] : [255, 255, 255];
  const accentRgb = hexToRgb(accent);
  for (let amount = 0; amount <= 1.0001; amount += 0.04) {
    const ground = rgbToHex(mixRgb(accentRgb, target, amount));
    if (contrastRatio(text, ground) >= 4.6) {
      return [ground, text];
    }
  }
  return [accent, text];
}

function presentationTemplateThemeCss(
  theme: PresentationTemplateThemeOption,
): string {
  const [bg, surface, ink, soft, accent, s1, s2, s3, ph] = theme.colors;
  const accents = [accent, s1, s2, s3] as const;
  const accentVariables = accents
    .map((accent, index) => {
      const [ground, text] = safePreviewGround(accent);
      return `--g${index}:${ground};--t${index}:${text};`;
    })
    .join("");
  return `
    :root {
      --bg:${bg};
      --surface:${surface};
      --ink:${ink};
      --soft:${soft};
      --ph:${ph};
      --accent:${accent};
      --s1:${s1};
      --s2:${s2};
      --s3:${s3};
      --oa:${previewTextColorOn(accent)};
      --o1:${previewTextColorOn(s1)};
      --o2:${previewTextColorOn(s2)};
      --o3:${previewTextColorOn(s3)};
      --ka:${contrastRatio(accent, bg) >= 4.5 ? accent : ink};
      --kad:${contrastRatio(accent, ink) >= 4.5 ? accent : bg};
      --k1:${contrastRatio(s1, bg) >= 4.5 ? s1 : ink};
      --k2:${contrastRatio(s2, bg) >= 4.5 ? s2 : ink};
      --k3:${contrastRatio(s3, bg) >= 4.5 ? s3 : ink};
      ${accentVariables}
    }
    #sw {
      display: none !important;
    }
  `;
}

function themedPreviewPresentationHtml(params: {
  readonly activeSlideId: string;
  readonly draft: PresentationPreviewDraft;
  readonly theme: PresentationTemplateThemeOption;
}): string {
  return previewPresentationHtml({
    activeSlideId: params.activeSlideId,
    additionalHeadStyle: presentationTemplateThemeCss(params.theme),
    html: params.draft.html,
  });
}

function schedulePresentationTemplateCardSlideIndex(params: {
  readonly apply: (index: number) => void;
  readonly embedUrl: string;
  readonly index: number;
  readonly runtime: TemplatePreviewRuntime;
}): void {
  const cache = params.runtime.presentation;
  cache.pendingSlideIndexes.set(params.embedUrl, params.index);
  if (cache.pendingSlideAnimationFrames.has(params.embedUrl)) {
    return;
  }

  const frameId = window.requestAnimationFrame(() => {
    const nextIndex = cache.pendingSlideIndexes.get(params.embedUrl);
    cache.pendingSlideAnimationFrames.delete(params.embedUrl);
    cache.pendingSlideIndexes.delete(params.embedUrl);
    if (nextIndex === undefined) {
      return;
    }
    cache.activeIndexes.set(params.embedUrl, nextIndex);
    params.apply(nextIndex);
  });
  cache.pendingSlideAnimationFrames.set(params.embedUrl, frameId);
}

function cancelPresentationTemplateCardSlideIndex(
  runtime: TemplatePreviewRuntime,
  embedUrl: string,
): void {
  const cache = runtime.presentation;
  const frameId = cache.pendingSlideAnimationFrames.get(embedUrl);
  if (frameId !== undefined) {
    window.cancelAnimationFrame(frameId);
  }
  cache.pendingSlideAnimationFrames.delete(embedUrl);
  cache.pendingSlideIndexes.delete(embedUrl);
}

function revokePresentationTemplateHtmlPreviewUrl(url: string | null): void {
  if (url !== null) {
    URL.revokeObjectURL(url);
  }
}

type PresentationTemplateThemeVariables = CSSProperties &
  Record<`--${string}`, string>;

function presentationTemplateThemeVariables(
  theme: PresentationTemplateThemeOption,
): PresentationTemplateThemeVariables {
  const [bg, surface, ink, soft, accent, s1, s2, s3, ph] = theme.colors;
  const [g0, t0] = safePreviewGround(accent);
  const [g1, t1] = safePreviewGround(s1);
  const [g2, t2] = safePreviewGround(s2);
  const [g3, t3] = safePreviewGround(s3);
  return {
    "--bg": bg,
    "--surface": surface,
    "--ink": ink,
    "--soft": soft,
    "--ph": ph,
    "--accent": accent,
    "--s1": s1,
    "--s2": s2,
    "--s3": s3,
    "--oa": previewTextColorOn(accent),
    "--o1": previewTextColorOn(s1),
    "--o2": previewTextColorOn(s2),
    "--o3": previewTextColorOn(s3),
    "--ka": contrastRatio(accent, bg) >= 4.5 ? accent : ink,
    "--kad": contrastRatio(accent, ink) >= 4.5 ? accent : bg,
    "--k1": contrastRatio(s1, bg) >= 4.5 ? s1 : ink,
    "--k2": contrastRatio(s2, bg) >= 4.5 ? s2 : ink,
    "--k3": contrastRatio(s3, bg) >= 4.5 ? s3 : ink,
    "--g0": g0,
    "--t0": t0,
    "--g1": g1,
    "--t1": t1,
    "--g2": g2,
    "--t2": t2,
    "--g3": g3,
    "--t3": t3,
  };
}

function getPresentationTemplateThumbnailThemeVariables(
  theme: PresentationTemplateThemeOption,
): PresentationTemplateThemeVariables {
  return presentationTemplateThemeVariables(theme);
}

function getPresentationTemplateThumbnailPreviewHtml(
  draft: PresentationPreviewDraft,
  slideId: string,
): string {
  return previewPresentationHtml({
    activeSlideId: slideId,
    html: draft.html,
  });
}

function applyPresentationTemplateThumbnailTheme(
  host: HTMLDivElement,
  themeVariables: PresentationTemplateThemeVariables,
): void {
  const root = host.shadowRoot?.querySelector<HTMLElement>(
    ".vm0-shadow-preview-root",
  );
  if (root === undefined || root === null) {
    return;
  }

  for (const [name, value] of Object.entries(themeVariables)) {
    if (name.startsWith("--")) {
      root.style.setProperty(name, value);
    }
  }
}

function renderPresentationTemplateShadowThumbnail(
  runtime: TemplatePreviewRuntime,
  host: HTMLDivElement,
  html: string,
  themeVariables: PresentationTemplateThemeVariables,
): void {
  const htmlByHost = runtime.presentation.thumbnailHtmlByHost;
  if (htmlByHost.get(host) === html) {
    applyPresentationTemplateThumbnailTheme(host, themeVariables);
    return;
  }
  htmlByHost.set(host, html);

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const doc = new DOMParser().parseFromString(html, "text/html");
  shadow.replaceChildren();

  const resetStyle = document.createElement("style");
  resetStyle.textContent = `
    :host {
      all: initial;
      contain: strict;
      display: block;
      height: 100%;
      overflow: hidden;
      position: relative;
      width: 100%;
    }
    .vm0-shadow-preview-root {
      background: #fff;
      height: 100%;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      position: absolute;
      user-select: none;
      width: 100%;
    }
    .vm0-shadow-preview-root *,
    .vm0-shadow-preview-root *:hover,
    .vm0-shadow-preview-root *:focus,
    .vm0-shadow-preview-root *:focus-visible {
      caret-color: transparent !important;
      outline: 0 !important;
      pointer-events: none !important;
      user-select: none !important;
    }
  `;
  shadow.append(resetStyle);
  for (const node of Array.from(doc.head.childNodes)) {
    const clone = node.cloneNode(true);
    if (clone instanceof HTMLStyleElement && clone.textContent !== null) {
      clone.textContent = clone.textContent.replaceAll(
        ":root",
        ":host, .vm0-shadow-preview-root",
      );
    }
    shadow.append(clone);
  }
  const root = document.createElement("div");
  root.className = "vm0-shadow-preview-root";
  root.append(
    ...Array.from(doc.body.childNodes).map((node) => {
      return node.cloneNode(true);
    }),
  );
  for (const element of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    element.removeAttribute("contenteditable");
    element.removeAttribute("tabindex");
  }
  shadow.append(root);
  applyPresentationTemplateThumbnailTheme(host, themeVariables);
}

function PresentationTemplateShadowThumbnail({
  draft,
  imageUrl,
  runtime,
  slideId,
  themeVariables,
  title,
}: {
  readonly draft: PresentationPreviewDraft | undefined;
  readonly imageUrl: string;
  readonly runtime: TemplatePreviewRuntime;
  readonly slideId: string | null;
  readonly themeVariables: PresentationTemplateThemeVariables;
  readonly title: string;
}) {
  const hasHtmlThumbnail = draft !== undefined && slideId !== null;
  return (
    <>
      <img
        src={imageUrl}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover"
      />
      {hasHtmlThumbnail ? (
        <div
          ref={(node) => {
            if (node !== null) {
              renderPresentationTemplateShadowThumbnail(
                runtime,
                node,
                getPresentationTemplateThumbnailPreviewHtml(draft, slideId),
                themeVariables,
              );
            }
          }}
          aria-label={title}
          className="pointer-events-none absolute inset-0"
          style={themeVariables}
        />
      ) : null}
    </>
  );
}

function createPresentationTemplateHtmlPreviewState(params: {
  readonly draft: PresentationPreviewDraft;
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly previousFrameUrl: string | null;
  readonly theme: PresentationTemplateThemeOption;
}): TemplateCardHtmlPreviewState | null {
  const slide =
    params.draft.slides[Math.min(params.index, params.draft.slides.length - 1)];
  if (slide === undefined) {
    return null;
  }

  revokePresentationTemplateHtmlPreviewUrl(params.previousFrameUrl);
  const frameUrl = URL.createObjectURL(
    new Blob(
      [
        themedPreviewPresentationHtml({
          activeSlideId: slide.id,
          draft: params.draft,
          theme: params.theme,
        }),
      ],
      { type: "text/html;charset=utf-8" },
    ),
  );

  return {
    slug: params.item.slug,
    embedUrl: params.item.embedUrl,
    themeId: params.theme.id,
    loading: false,
    frameUrl,
    slideCount: params.draft.slides.length,
  };
}

function createPresentationTemplateCardHtmlPreviewState(params: {
  readonly draft: PresentationPreviewDraft;
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly previousFrameUrl: string | null;
  readonly theme: PresentationTemplateThemeOption;
}): TemplateCardHtmlPreviewState | null {
  if (params.index === 0) {
    revokePresentationTemplateHtmlPreviewUrl(params.previousFrameUrl);
    return null;
  }
  return createPresentationTemplateHtmlPreviewState(params);
}

function presentationTemplateCardFrameUrls(params: {
  readonly currentFrameUrl: string | null;
  readonly loadedFrameUrl: string | null;
}): {
  readonly overlayFrameUrl: string | null;
  readonly primaryFrameUrl: string | null;
} {
  if (
    params.currentFrameUrl === null ||
    params.loadedFrameUrl === null ||
    params.loadedFrameUrl === params.currentFrameUrl
  ) {
    return {
      overlayFrameUrl: null,
      primaryFrameUrl: params.currentFrameUrl,
    };
  }

  return {
    overlayFrameUrl: params.currentFrameUrl,
    primaryFrameUrl: params.loadedFrameUrl,
  };
}

function revokeLoadedTemplateCardFrameAfterReplacement(params: {
  readonly frameUrl: string;
  readonly previousLoadedFrameUrl: string | null;
}): void {
  if (
    params.previousLoadedFrameUrl === null ||
    params.previousLoadedFrameUrl === params.frameUrl
  ) {
    return;
  }
  revokePresentationTemplateHtmlPreviewUrl(params.previousLoadedFrameUrl);
}

function presentationTemplateCardActiveFrameUrlForImmediateRevocation(params: {
  readonly activeFrameUrl: string | null;
  readonly loadedFrameUrl: string | null;
}): string | null {
  if (
    params.activeFrameUrl === null ||
    params.activeFrameUrl === params.loadedFrameUrl
  ) {
    return null;
  }
  return params.activeFrameUrl;
}

function revealTemplatePreviewFrameAfterPaint(params: {
  readonly frame: HTMLIFrameElement;
  readonly frameUrl: string;
  readonly onFrameLoad: (frameUrl: string) => void;
}): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!params.frame.isConnected) {
        return;
      }
      params.onFrameLoad(params.frameUrl);
    });
  });
}

function startProgressiveTemplatePreviewImageLoad(
  lowResolutionImage: HTMLImageElement,
): void {
  const highResolutionImage =
    lowResolutionImage.parentElement?.querySelector<HTMLImageElement>(
      '[data-template-preview-image="high"]',
    );
  if (highResolutionImage === null || highResolutionImage === undefined) {
    return;
  }

  const highResolutionUrl = highResolutionImage.dataset.src;
  if (
    highResolutionUrl === undefined ||
    highResolutionImage.getAttribute("src") === highResolutionUrl
  ) {
    return;
  }
  delete highResolutionImage.dataset.loaded;
  highResolutionImage.src = highResolutionUrl;
}

function ProgressiveTemplatePreviewImage({
  alt,
  className,
  dataTestId,
  fetchPriority,
  highResolutionUrl,
  loading,
  lowResolutionUrl,
}: {
  readonly alt: string;
  readonly className: string;
  readonly dataTestId?: string;
  readonly fetchPriority?: "high" | "low" | "auto";
  readonly highResolutionUrl: string;
  readonly loading?: "eager" | "lazy";
  readonly lowResolutionUrl: string;
}) {
  const hasHighResolutionImage = lowResolutionUrl !== highResolutionUrl;

  return (
    <>
      <img
        src={lowResolutionUrl}
        alt={alt}
        aria-hidden={alt === "" ? "true" : undefined}
        data-template-preview-image="low"
        data-testid={dataTestId}
        className={className}
        loading={loading}
        decoding="async"
        fetchPriority={fetchPriority}
        onLoad={(event) => {
          if (hasHighResolutionImage) {
            startProgressiveTemplatePreviewImageLoad(event.currentTarget);
          }
        }}
        onError={(event) => {
          if (hasHighResolutionImage) {
            startProgressiveTemplatePreviewImageLoad(event.currentTarget);
          }
        }}
      />
      {hasHighResolutionImage ? (
        <img
          src={undefined}
          data-template-preview-image="high"
          data-src={highResolutionUrl}
          alt={alt}
          aria-hidden={alt === "" ? "true" : undefined}
          className={cn(
            className,
            "opacity-0 transition-opacity duration-150 data-[loaded=true]:opacity-100",
          )}
          loading={loading}
          decoding="async"
          fetchPriority={fetchPriority}
          onLoad={(event) => {
            const highResolutionImage = event.currentTarget;
            highResolutionImage.dataset.loaded = "true";
          }}
        />
      ) : null}
    </>
  );
}

function TemplatePreviewFrames({
  highResolutionImageUrl,
  loadedFrameUrl,
  loading,
  lowResolutionImageUrl,
  onFrameLoad,
  overlayFrameUrl,
  primaryFrameUrl,
  title,
}: {
  readonly highResolutionImageUrl: string;
  readonly loadedFrameUrl: string | null;
  readonly loading: boolean;
  readonly lowResolutionImageUrl: string;
  readonly onFrameLoad: (frameUrl: string) => void;
  readonly overlayFrameUrl: string | null;
  readonly primaryFrameUrl: string | null;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const frameUrls: readonly string[] =
    primaryFrameUrl === null
      ? []
      : [
          primaryFrameUrl,
          ...(overlayFrameUrl === null ? [] : [overlayFrameUrl]),
        ];

  return (
    <>
      <ProgressiveTemplatePreviewImage
        alt=""
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        dataTestId={`${title} card image preview`}
        fetchPriority="high"
        highResolutionUrl={highResolutionImageUrl}
        loading="eager"
        lowResolutionUrl={lowResolutionImageUrl}
      />
      {frameUrls.map((frameUrl) => {
        return (
          <iframe
            key={frameUrl}
            title={
              frameUrl === overlayFrameUrl
                ? t(
                    ($) => {
                      return $.artifacts.templates.activeHtmlPreview;
                    },
                    { title },
                  )
                : t(
                    ($) => {
                      return $.artifacts.templates.htmlPreview;
                    },
                    { title },
                  )
            }
            data-testid={
              frameUrl === overlayFrameUrl || overlayFrameUrl === null
                ? `${title} card HTML preview`
                : undefined
            }
            data-loaded={frameUrl === loadedFrameUrl ? "true" : undefined}
            src={frameUrl}
            sandbox="allow-same-origin"
            tabIndex={-1}
            className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-background opacity-0 data-[loaded=true]:opacity-100"
            onLoad={(event) => {
              revealTemplatePreviewFrameAfterPaint({
                frame: event.currentTarget,
                frameUrl,
                onFrameLoad,
              });
            }}
          />
        );
      })}
      {loading ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
        </div>
      ) : null}
    </>
  );
}

function TemplatePreview({
  item,
  onPreview,
  runtime,
  theme,
}: {
  item: PresentationTemplateItem;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
  priority?: boolean;
  runtime: TemplatePreviewRuntime;
  theme?: PresentationTemplateThemeOption;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const hover = useGet(templateCardHover$);
  const setHover = useSet(setTemplateCardHover$);
  const htmlPreview = useGet(templateCardHtmlPreview$);
  const setHtmlPreview = useSet(setTemplateCardHtmlPreview$);
  const loadedHtmlFrameUrls = useGet(templateCardLoadedHtmlFrameUrls$);
  const setLoadedHtmlFrameUrl = useSet(setTemplateCardLoadedHtmlFrameUrl$);
  const slideCount = presentationTemplateSlideCount(item);
  const hoverSlideIndex = Math.max(
    0,
    Math.min(hover?.slug === item.slug ? hover.index : 0, slideCount - 1),
  );
  const previewTheme =
    theme ??
    findPresentationTemplateTheme(defaultPresentationTemplateThemeId(item));
  const lowResolutionImageUrl = presentationTemplateCardSlideImage(
    item,
    hoverSlideIndex,
    previewTheme,
  );
  const highResolutionImageUrl = presentationTemplateHighResolutionSlideImage(
    item,
    hoverSlideIndex,
    previewTheme,
    TEMPLATE_HIGH_RESOLUTION_PREVIEW_SIZE,
  );
  const activeHtmlPreview =
    htmlPreview?.slug === item.slug &&
    htmlPreview.embedUrl === item.embedUrl &&
    htmlPreview.themeId === previewTheme.id
      ? htmlPreview
      : null;
  const loadedHtmlFrameKey = `card:${item.embedUrl}:${previewTheme.id}:loaded`;
  const loadedFrameUrl = loadedHtmlFrameUrls[loadedHtmlFrameKey] ?? null;
  const previousActiveFrameUrlForImmediateRevocation =
    presentationTemplateCardActiveFrameUrlForImmediateRevocation({
      activeFrameUrl: activeHtmlPreview?.frameUrl ?? null,
      loadedFrameUrl,
    });
  const scrubSlideCount = activeHtmlPreview?.slideCount ?? slideCount;
  const currentPreviewSlideIndex = () => {
    const cache = runtime.presentation;
    const index =
      cache.pendingSlideIndexes.get(item.embedUrl) ??
      cache.activeIndexes.get(item.embedUrl) ??
      hoverSlideIndex;
    return Math.max(0, Math.min(index, scrubSlideCount - 1));
  };
  const currentFrameUrl =
    currentPreviewSlideIndex() === 0
      ? null
      : (activeHtmlPreview?.frameUrl ?? null);
  const { overlayFrameUrl, primaryFrameUrl } =
    presentationTemplateCardFrameUrls({
      currentFrameUrl,
      loadedFrameUrl,
    });
  const openPreview = () => {
    onPreview(item, currentPreviewSlideIndex());
  };
  const handleFrameLoad = (frameUrl: string) => {
    revokeLoadedTemplateCardFrameAfterReplacement({
      frameUrl,
      previousLoadedFrameUrl: loadedFrameUrl,
    });
    setLoadedHtmlFrameUrl(loadedHtmlFrameKey, frameUrl);
  };

  const startHtmlPreviewLoad = () => {
    const cache = runtime.presentation;
    const activeIndex = cache.activeIndexes.get(item.embedUrl) ?? 0;
    const cachedDraft = cache.drafts.get(item.embedUrl);
    if (cachedDraft !== undefined) {
      const previewState = createPresentationTemplateCardHtmlPreviewState({
        draft: cachedDraft,
        index: activeIndex,
        item,
        previousFrameUrl: previousActiveFrameUrlForImmediateRevocation,
        theme: previewTheme,
      });
      setHtmlPreview(previewState);
      return;
    }

    if (cache.failed.has(item.embedUrl)) {
      setHtmlPreview({
        slug: item.slug,
        embedUrl: item.embedUrl,
        themeId: previewTheme.id,
        loading: false,
        frameUrl: null,
        slideCount,
      });
      return;
    }

    let pendingLoad = cache.pendingLoads.get(item.embedUrl);
    if (pendingLoad === undefined) {
      pendingLoad = loadPresentationTemplateHtmlPreview({
        item,
        signal: pageSignal,
      });
      cache.pendingLoads.set(item.embedUrl, pendingLoad);
    }

    const activeToken = Symbol(item.embedUrl);
    cache.activeTokens.set(item.embedUrl, activeToken);
    setHtmlPreview({
      slug: item.slug,
      embedUrl: item.embedUrl,
      themeId: previewTheme.id,
      loading: true,
      frameUrl: null,
      slideCount,
    });
    detach(
      (async () => {
        const result = await tapError(
          pendingLoad.finally(() => {
            if (cache.pendingLoads.get(item.embedUrl) === pendingLoad) {
              cache.pendingLoads.delete(item.embedUrl);
            }
          }),
        );

        if (result === undefined || result === null) {
          cache.failed.add(item.embedUrl);
          if (cache.activeTokens.get(item.embedUrl) === activeToken) {
            setHtmlPreview({
              slug: item.slug,
              embedUrl: item.embedUrl,
              themeId: previewTheme.id,
              loading: false,
              frameUrl: null,
              slideCount,
            });
          }
          return;
        }

        cache.drafts.set(item.embedUrl, result);
        if (cache.activeTokens.get(item.embedUrl) === activeToken) {
          setHtmlPreview(
            createPresentationTemplateCardHtmlPreviewState({
              draft: result,
              index: cache.activeIndexes.get(item.embedUrl) ?? 0,
              item,
              previousFrameUrl: previousActiveFrameUrlForImmediateRevocation,
              theme: previewTheme,
            }),
          );
        }
      })(),
      Reason.DomCallback,
    );
  };

  const applySlideIndex = (index: number) => {
    const cachedDraft = runtime.presentation.drafts.get(item.embedUrl);
    setHover({ slug: item.slug, index });
    if (cachedDraft !== undefined) {
      setHtmlPreview(
        createPresentationTemplateCardHtmlPreviewState({
          draft: cachedDraft,
          index,
          item,
          previousFrameUrl: previousActiveFrameUrlForImmediateRevocation,
          theme: previewTheme,
        }),
      );
    }
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const cache = runtime.presentation;
    if (!cache.drafts.has(item.embedUrl)) {
      return;
    }
    if (scrubSlideCount < 2) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }
    const offsetX = Math.min(
      rect.width - 1,
      Math.max(0, event.clientX - rect.left),
    );
    const nextIndex = Math.min(
      scrubSlideCount - 1,
      Math.round((offsetX / rect.width) * (scrubSlideCount - 1)),
    );
    const currentIndex =
      cache.pendingSlideIndexes.get(item.embedUrl) ??
      currentPreviewSlideIndex();
    if (nextIndex === currentIndex) {
      return;
    }
    schedulePresentationTemplateCardSlideIndex({
      apply: applySlideIndex,
      embedUrl: item.embedUrl,
      index: nextIndex,
      runtime,
    });
    event.currentTarget.dataset.targetSlideIndex = String(nextIndex);
  };

  return (
    <div
      className="relative aspect-[16/9] shrink-0 overflow-hidden bg-muted"
      onMouseEnter={() => {
        cancelPresentationTemplateCardSlideIndex(runtime, item.embedUrl);
        runtime.presentation.activeIndexes.set(item.embedUrl, 0);
        setHover({ slug: item.slug, index: 0 });
        startHtmlPreviewLoad();
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={(event) => {
        delete event.currentTarget.dataset.targetSlideIndex;
        const cache = runtime.presentation;
        cancelPresentationTemplateCardSlideIndex(runtime, item.embedUrl);
        cache.activeIndexes.delete(item.embedUrl);
        cache.activeTokens.delete(item.embedUrl);
        setHover(null);
        revokePresentationTemplateHtmlPreviewUrl(
          previousActiveFrameUrlForImmediateRevocation,
        );
        setHtmlPreview(null);
      }}
    >
      <TemplatePreviewFrames
        highResolutionImageUrl={highResolutionImageUrl}
        loadedFrameUrl={loadedFrameUrl}
        loading={activeHtmlPreview?.loading === true}
        lowResolutionImageUrl={lowResolutionImageUrl}
        onFrameLoad={handleFrameLoad}
        overlayFrameUrl={overlayFrameUrl}
        primaryFrameUrl={primaryFrameUrl}
        title={item.title}
      />
      <button
        type="button"
        aria-label={t(
          ($) => {
            return $.artifacts.templates.previewCurrentSlide;
          },
          {
            title: item.title,
          },
        )}
        className="absolute inset-0 z-10 cursor-zoom-in bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={openPreview}
      />
    </div>
  );
}

const TEMPLATE_DETAIL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  '[tabindex]:not([tabindex="-1"]):not([role="group"])',
].join(",");

function templateDetailFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(TEMPLATE_DETAIL_FOCUSABLE_SELECTOR),
  ).filter((element) => {
    return (
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      !element.closest("[inert]")
    );
  });
}

function handleTemplateDetailTabKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
): void {
  if (event.key !== "Tab") {
    return;
  }

  const candidates = templateDetailFocusableElements(event.currentTarget);
  if (candidates.length === 0) {
    return;
  }

  const target =
    event.target instanceof HTMLElement ? event.target : document.activeElement;
  const currentIndex = candidates.findIndex((candidate) => {
    return target instanceof Node && candidate.contains(target);
  });
  const direction = event.shiftKey ? -1 : 1;
  const nextIndex =
    currentIndex === -1
      ? event.shiftKey
        ? candidates.length - 1
        : 0
      : (currentIndex + direction + candidates.length) % candidates.length;

  event.preventDefault();
  candidates[nextIndex]?.focus();
}

function TemplateDetailPreviewFrame({
  frameLoaded,
  frameUrl,
  onFrameLoad,
  previousFrameSlideIndex,
  previousFrameUrl,
  slideIndex,
  title,
}: {
  readonly frameLoaded: boolean;
  readonly frameUrl: string | null;
  readonly onFrameLoad: (frameUrl: string) => void;
  readonly previousFrameSlideIndex: number | null;
  readonly previousFrameUrl: string | null;
  readonly slideIndex: number;
  readonly title: string;
}) {
  const { t } = useTranslation();
  const frames: readonly {
    readonly active: boolean;
    readonly slideIndex: number;
    readonly url: string;
  }[] = [
    ...(previousFrameUrl === null || previousFrameUrl === frameUrl
      ? []
      : [
          {
            active: false,
            slideIndex: previousFrameSlideIndex ?? slideIndex,
            url: previousFrameUrl,
          },
        ]),
    ...(frameUrl === null ? [] : [{ active: true, slideIndex, url: frameUrl }]),
  ];

  return frames.map((candidateFrame) => {
    const previousFrameShowsActiveSlide =
      !candidateFrame.active && candidateFrame.slideIndex === slideIndex;
    return (
      <iframe
        key={candidateFrame.url}
        title={
          candidateFrame.active
            ? t(
                ($) => {
                  return $.artifacts.templates.htmlPreview;
                },
                { title },
              )
            : t(
                ($) => {
                  return $.artifacts.templates.previousHtmlPreview;
                },
                { title },
              )
        }
        data-template-detail-frame={
          candidateFrame.active ? "active" : "previous"
        }
        data-loaded={!candidateFrame.active || frameLoaded ? "true" : undefined}
        data-testid={
          candidateFrame.active ? `${title} detail HTML preview` : undefined
        }
        src={candidateFrame.url}
        sandbox="allow-same-origin"
        tabIndex={-1}
        className={cn(
          "pointer-events-none absolute inset-0 h-full w-full border-0 bg-background opacity-0 data-[loaded=true]:opacity-100",
          candidateFrame.active
            ? "z-40"
            : previousFrameShowsActiveSlide
              ? "z-30"
              : "z-10",
        )}
        onLoad={(event) => {
          if (!candidateFrame.active) {
            return;
          }
          revealTemplatePreviewFrameAfterPaint({
            frame: event.currentTarget,
            frameUrl: candidateFrame.url,
            onFrameLoad,
          });
        }}
      />
    );
  });
}

function templateDetailPreviewMatchesItem(
  preview: {
    readonly embedUrl: string;
    readonly slug: string;
  } | null,
  item: PresentationTemplateItem,
): boolean {
  return preview?.slug === item.slug && preview.embedUrl === item.embedUrl;
}

function TemplatePreviewPage({
  item,
  onBack,
  onSelect,
  runtime,
}: {
  item: PresentationTemplateItem;
  onBack: () => void;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const detailPreview = useGet(templateDetailHtmlPreview$);
  const setCardThemeId = useSet(setTemplateCardThemeId$);
  const selectDetailPreview = useSet(selectPresentationTemplateDetailPreview$);
  const settleDetailPreviewFrame = useSet(
    settlePresentationTemplateDetailPreviewFrame$,
  );
  const visibleDetailPreview = templateDetailPreviewMatchesItem(
    detailPreview,
    item,
  )
    ? detailPreview
    : null;
  const selectedThemeId =
    visibleDetailPreview?.themeId ?? defaultPresentationTemplateThemeId(item);
  const selectedTheme = findPresentationTemplateTheme(selectedThemeId);
  const activeSlideIndex = visibleDetailPreview?.index ?? 0;
  const defaultSlideCount = presentationTemplateSlideCount(item);
  const detailSlideCount =
    visibleDetailPreview?.slideCount ?? defaultSlideCount;
  const cachedDetailDraft = runtime.presentation.drafts.get(item.embedUrl);
  const htmlPreviewFailed = runtime.presentation.failed.has(item.embedUrl);
  const thumbnailThemeVariables =
    getPresentationTemplateThumbnailThemeVariables(selectedTheme);
  const detailImageSource = presentationTemplateDetailSlideImageSource(
    item,
    activeSlideIndex,
    selectedTheme,
    htmlPreviewFailed,
  );
  const detailLowResolutionImage = r2ImageTransformUrl(
    detailImageSource,
    TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE,
  );
  const detailHighResolutionImage = detailImageSource;
  const selectDetailSlide = (index: number) => {
    selectDetailPreview({
      item,
      runtime,
      index: Math.max(0, Math.min(detailSlideCount - 1, index)),
      themeCss: presentationTemplateThemeCss(selectedTheme),
      themeId: selectedTheme.id,
    });
  };

  const selectDetailTheme = (theme: PresentationTemplateThemeOption) => {
    selectDetailPreview({
      item,
      runtime,
      index: activeSlideIndex,
      themeCss: presentationTemplateThemeCss(theme),
      themeId: theme.id,
    });
  };
  const handleDetailSlideKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "ArrowLeft" && activeSlideIndex > 0) {
      event.preventDefault();
      selectDetailSlide(activeSlideIndex - 1);
    }
    if (event.key === "ArrowRight" && activeSlideIndex < detailSlideCount - 1) {
      event.preventDefault();
      selectDetailSlide(activeSlideIndex + 1);
    }
  };
  const multiAccentThemes = PRESENTATION_TEMPLATE_THEME_OPTIONS.filter(
    (theme) => {
      return theme.group === "multi-accent";
    },
  );
  const singleAccentThemes = PRESENTATION_TEMPLATE_THEME_OPTIONS.filter(
    (theme) => {
      return theme.group === "single-accent";
    },
  );

  return (
    <>
      <DialogHeader
        data-presentation-template-detail-header=""
        className="shrink-0 border-b border-border py-4 pl-5 pr-14 text-left sm:pr-16"
      >
        <DialogTitle className="flex min-w-0 max-w-full items-center justify-start gap-1.5 text-left text-base leading-none">
          <button
            type="button"
            className="inline-flex shrink-0 items-center p-0 leading-none text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onBack}
          >
            {t(($) => {
              return $.artifacts.templates.template;
            })}
          </button>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="block min-w-0 truncate leading-none">
            {item.title}
          </span>
        </DialogTitle>
      </DialogHeader>
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto bg-muted/20 p-3 sm:gap-4 sm:p-5 lg:max-h-[72vh] lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
        <div className="rounded-lg border border-border bg-background p-2.5 sm:p-3">
          <div
            role="group"
            aria-label={t(
              ($) => {
                return $.artifacts.templates.slidePreview;
              },
              {
                title: item.title,
              },
            )}
            tabIndex={0}
            onKeyDown={handleDetailSlideKeyDown}
            className="relative aspect-[16/9] overflow-hidden rounded-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ProgressiveTemplatePreviewImage
              alt=""
              className="pointer-events-none absolute inset-0 z-20 h-full w-full object-cover"
              dataTestId={`${item.title} detail image preview`}
              fetchPriority="high"
              highResolutionUrl={detailHighResolutionImage}
              loading="eager"
              lowResolutionUrl={detailLowResolutionImage}
            />
            <TemplateDetailPreviewFrame
              frameLoaded={visibleDetailPreview?.frameLoaded ?? false}
              frameUrl={visibleDetailPreview?.frameUrl ?? null}
              onFrameLoad={(frameUrl) => {
                settleDetailPreviewFrame(frameUrl);
              }}
              previousFrameSlideIndex={
                visibleDetailPreview?.previousFrameSlideIndex ?? null
              }
              previousFrameUrl={visibleDetailPreview?.previousFrameUrl ?? null}
              slideIndex={activeSlideIndex}
              title={item.title}
            />
            <button
              type="button"
              aria-label={t(($) => {
                return $.artifacts.templates.previousSlide;
              })}
              disabled={activeSlideIndex === 0}
              tabIndex={-1}
              onClick={() => {
                selectDetailSlide(activeSlideIndex - 1);
              }}
              className="absolute inset-y-0 left-0 w-1/2 cursor-w-resize bg-transparent focus:outline-none disabled:cursor-default"
            />
            <button
              type="button"
              aria-label={t(($) => {
                return $.artifacts.templates.nextSlide;
              })}
              disabled={activeSlideIndex >= detailSlideCount - 1}
              tabIndex={-1}
              onClick={() => {
                selectDetailSlide(activeSlideIndex + 1);
              }}
              className="absolute inset-y-0 right-0 w-1/2 cursor-e-resize bg-transparent focus:outline-none disabled:cursor-default"
            />
            {visibleDetailPreview?.loading ||
            !visibleDetailPreview?.frameUrl ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
                <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
              </div>
            ) : null}
          </div>
          <div
            className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(96px,1fr))] gap-1.5 lg:grid-cols-8"
            onKeyDown={handleDetailSlideKeyDown}
          >
            {Array.from(
              { length: Math.min(detailSlideCount, 15) },
              (_, index) => {
                return index + 1;
              },
            ).map((slideNumber) => {
              const slideIndex = slideNumber - 1;
              const active = slideIndex === activeSlideIndex;
              const thumbnailImage = r2ImageTransformUrl(
                presentationTemplateDetailSlideImageSource(
                  item,
                  slideIndex,
                  selectedTheme,
                  htmlPreviewFailed,
                ),
                TEMPLATE_DETAIL_THUMBNAIL_PREVIEW_SIZE,
              );
              const thumbnailSlide =
                cachedDetailDraft?.slides[slideIndex] ?? null;
              return (
                <button
                  key={slideNumber}
                  type="button"
                  aria-label={t(
                    ($) => {
                      return $.artifacts.templates.previewSlide;
                    },
                    {
                      slideNumber,
                    },
                  )}
                  aria-pressed={active}
                  onClick={() => {
                    selectDetailSlide(slideIndex);
                  }}
                  className={cn(
                    "relative aspect-[16/9] overflow-hidden rounded-md border bg-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-ring ring-1 ring-ring"
                      : "border-border hover:border-muted-foreground/50",
                  )}
                >
                  <PresentationTemplateShadowThumbnail
                    draft={cachedDetailDraft}
                    imageUrl={thumbnailImage}
                    runtime={runtime}
                    slideId={thumbnailSlide?.id ?? null}
                    themeVariables={thumbnailThemeVariables}
                    title={t(
                      ($) => {
                        return $.artifacts.templates.slideThumbnail;
                      },
                      {
                        title: item.title,
                        slideNumber,
                      },
                    )}
                  />
                  <span className="absolute bottom-1 right-1 rounded border border-border bg-background/90 px-1.5 py-0.5 text-[10px] font-semibold text-foreground shadow-sm backdrop-blur">
                    {slideNumber}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col lg:sticky lg:top-0">
          <div className="rounded-lg border border-border bg-background p-4 shadow-sm">
            <h3 className="text-xl font-semibold text-foreground">
              {item.title}
            </h3>
            <div className="my-5 border-t border-border" />
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <IconPalette size={14} stroke={1.9} />
              <span>
                {t(($) => {
                  return $.artifacts.templates.theme;
                })}
              </span>
            </p>
            <div className="mt-3 space-y-4">
              <div className="space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  {t(($) => {
                    return $.artifacts.templates.multiAccent;
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {multiAccentThemes.map((theme) => {
                    const active = theme.id === selectedTheme.id;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        aria-label={t(
                          ($) => {
                            return $.artifacts.templates.selectStyle;
                          },
                          { style: theme.name },
                        )}
                        aria-pressed={active}
                        onClick={() => {
                          selectDetailTheme(theme);
                        }}
                        className={cn(
                          "relative h-7 w-14 overflow-hidden rounded-lg border bg-background transition-colors hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-ring ring-1 ring-ring"
                            : "border-border hover:border-muted-foreground/60",
                        )}
                      >
                        <span className="flex h-full overflow-hidden rounded-md">
                          {presentationTemplateThemePreviewSwatches(theme).map(
                            (swatch) => {
                              return (
                                <span
                                  key={`${theme.id}-${swatch.id}`}
                                  className="flex-1"
                                  style={{ backgroundColor: swatch.color }}
                                />
                              );
                            },
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  {t(($) => {
                    return $.artifacts.templates.singleAccent;
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {singleAccentThemes.map((theme) => {
                    const active = theme.id === selectedTheme.id;
                    const swatches = presentationTemplateThemeAccentSwatches(
                      item,
                      theme,
                    );
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        aria-label={t(
                          ($) => {
                            return $.artifacts.templates.selectStyle;
                          },
                          { style: theme.name },
                        )}
                        aria-pressed={active}
                        onClick={() => {
                          selectDetailTheme(theme);
                        }}
                        className={cn(
                          "relative h-7 w-7 overflow-hidden rounded-md border transition-colors hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "border-ring ring-1 ring-ring"
                            : "border-border hover:border-muted-foreground/60",
                        )}
                      >
                        <span className="flex h-full">
                          {swatches.map((swatch) => {
                            return (
                              <span
                                key={`${theme.id}-${swatch.id}`}
                                className="flex-1"
                                style={{ backgroundColor: swatch.color }}
                              />
                            );
                          })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label={t(
                ($) => {
                  return $.artifacts.templates.selectTemplate;
                },
                {
                  title: item.title,
                },
              )}
              className="mt-4 h-12 w-full rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => {
                setCardThemeId(item.slug, selectedTheme.id);
                onSelect(
                  item,
                  presentationTemplateColorSystemId(selectedTheme.id),
                );
              }}
            >
              {t(($) => {
                return $.artifacts.templates.useThisTemplate;
              })}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function PptCard({
  item,
  selected,
  onSelect,
  onPreview,
  runtime,
}: {
  item: PresentationTemplateItem;
  selected: boolean;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
  priority?: boolean;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const themeIdBySlug = useGet(templateCardThemeIdBySlug$);
  const selectedTheme = findPresentationTemplateTheme(
    themeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
  );

  return (
    <div
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:bg-muted/20",
        TEMPLATE_CARD_SHADOW,
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <TemplatePreview
        item={item}
        onPreview={onPreview}
        runtime={runtime}
        theme={selectedTheme}
      />
      <div className="flex flex-1 flex-wrap items-center gap-2 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="min-w-0 cursor-default truncate text-sm font-semibold leading-5 text-foreground">
                  {item.title}
                </p>
              </TooltipTrigger>
              <TooltipContent side="bottom">{item.title}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectTemplate;
            },
            {
              title: item.title,
            },
          )}
          aria-pressed={selected}
          onClick={() => {
            onSelect(item, presentationTemplateColorSystemId(selectedTheme.id));
          }}
          className={cn(
            "h-8 shrink-0 rounded-md border border-border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "bg-primary/10 text-primary"
              : "bg-background text-foreground hover:bg-muted",
          )}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
    </div>
  );
}

function IllustrationTemplateHero({
  item,
  images,
  activeIndex,
  priority = false,
  source,
  onVariantChange,
  runtime,
}: {
  item: IllustrationTemplateItem;
  images: readonly string[];
  activeIndex: number;
  priority?: boolean;
  source: string;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const heroImage = illustrationHeroImageUrl(source);
  const navigable = images.length > 1;
  const variantAt = (direction: -1 | 1): number => {
    return (activeIndex + direction + images.length) % images.length;
  };
  const preloadNeighbors = (): void => {
    preloadIllustrationVariant(runtime, images, variantAt(1));
    preloadIllustrationVariant(runtime, images, variantAt(-1));
  };

  return (
    <div
      className="relative w-full overflow-hidden bg-muted"
      style={{ aspectRatio: `${String(item.width)} / ${String(item.height)}` }}
    >
      <img
        key={source}
        src={heroImage}
        alt={t(
          ($) => {
            return $.artifacts.templates.illustrationPreview;
          },
          {
            title: item.title,
          },
        )}
        className={cn(
          "absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150 data-[loaded=true]:opacity-100",
          navigable && "cursor-pointer",
        )}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : "low"}
        onMouseEnter={navigable ? preloadNeighbors : undefined}
        onClick={
          navigable
            ? (event) => {
                // Navigate by clicking the image halves instead of overlay
                // buttons, so the native context menu (copy image) stays usable.
                const rect = event.currentTarget.getBoundingClientRect();
                const direction =
                  event.clientX - rect.left < rect.width / 2 ? -1 : 1;
                selectIllustrationVariant({
                  card: event.currentTarget.closest<HTMLElement>(
                    "[data-illustration-template-card]",
                  ),
                  index: variantAt(direction),
                  item,
                  onVariantChange,
                  runtime,
                });
              }
            : undefined
        }
        onLoad={(event) => {
          const image = event.currentTarget;
          detach(
            markIllustrationPreviewImageLoaded(runtime, heroImage, image),
            Reason.DomCallback,
          );
        }}
        onError={(event) => {
          event.currentTarget.parentElement
            ?.querySelector<HTMLElement>("[data-illustration-preview-error]")
            ?.removeAttribute("hidden");
        }}
      />
      <div
        data-illustration-preview-error=""
        hidden
        className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground"
      >
        <IconTemplate size={28} stroke={1.5} />
      </div>
    </div>
  );
}

function illustrationHeroImageUrl(source: string): string {
  return r2ImageTransformUrl(source, ILLUSTRATION_CARD_PREVIEW_SIZE);
}

function preloadIllustrationPreviewImage(
  runtime: TemplatePreviewRuntime,
  url: string,
): HTMLImageElement | undefined {
  if (typeof Image === "undefined") {
    return undefined;
  }

  const cache = runtime.illustration;
  const cachedImage = cache.preloads.get(url);
  if (cachedImage !== undefined) {
    return cachedImage;
  }

  const image = new Image();
  image.decoding = "async";
  image.loading = "eager";
  image.fetchPriority = "high";
  image.src = url;
  cache.preloads.set(url, image);
  return image;
}

async function decodeIllustrationPreviewImage(
  runtime: TemplatePreviewRuntime,
  url: string,
): Promise<void> {
  const cache = runtime.illustration;
  if (cache.decoded.has(url)) {
    return;
  }

  if (isHappyDomTestEnvironment()) {
    cache.decoded.add(url);
    return;
  }

  const pendingDecode = cache.pendingDecodes.get(url);
  if (pendingDecode !== undefined) {
    await pendingDecode;
    return;
  }

  const image = preloadIllustrationPreviewImage(runtime, url);
  if (image === undefined) {
    return;
  }

  if (image.decode === undefined) {
    if (image.complete && image.naturalWidth > 0) {
      cache.decoded.add(url);
    }
    return;
  }

  const decode = markIllustrationPreviewImageDecoded(runtime, url, image);
  cache.pendingDecodes.set(url, decode);
  await decode;
}

async function markIllustrationPreviewImageDecoded(
  runtime: TemplatePreviewRuntime,
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = runtime.illustration;
  await tapError(image.decode(), () => {});
  if (image.complete && image.naturalWidth > 0) {
    cache.decoded.add(url);
  }
  cache.pendingDecodes.delete(url);
}

async function markIllustrationPreviewImageLoaded(
  runtime: TemplatePreviewRuntime,
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = runtime.illustration;
  if (image.decode !== undefined) {
    await tapError(image.decode(), () => {});
  }
  if (image.complete && image.naturalWidth > 0) {
    cache.decoded.add(url);
  }
  image.dataset.loaded = "true";
  image.parentElement
    ?.querySelector<HTMLElement>("[data-illustration-preview-error]")
    ?.setAttribute("hidden", "");
}

function illustrationPreviewImageDecoded(
  runtime: TemplatePreviewRuntime,
  url: string,
): boolean {
  return runtime.illustration.decoded.has(url);
}

async function selectDecodedIllustrationVariant({
  card,
  imageUrl,
  index,
  item,
  onVariantChange,
  runtime,
}: {
  card: HTMLElement;
  imageUrl: string;
  index: number;
  item: IllustrationTemplateItem;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}): Promise<void> {
  await decodeIllustrationPreviewImage(runtime, imageUrl);
  if (
    card.dataset.targetVariantIndex === String(index) &&
    illustrationPreviewImageDecoded(runtime, imageUrl)
  ) {
    onVariantChange(item.slug, index);
  }
}

function selectIllustrationVariant({
  card,
  index,
  item,
  onVariantChange,
  runtime,
}: {
  card: HTMLElement | null;
  index: number;
  item: IllustrationTemplateItem;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}): void {
  const image = item.previewImages[index];
  if (image === undefined) {
    return;
  }

  const imageUrl = illustrationHeroImageUrl(image);
  // Swap immediately only when the target hero is already decoded; otherwise
  // decode it off-screen first so the hero never flashes a blank/loading frame.
  if (card === null || illustrationPreviewImageDecoded(runtime, imageUrl)) {
    onVariantChange(item.slug, index);
    return;
  }

  card.dataset.targetVariantIndex = String(index);
  detach(
    selectDecodedIllustrationVariant({
      card,
      imageUrl,
      index,
      item,
      onVariantChange,
      runtime,
    }),
    Reason.DomCallback,
  );
}

function preloadIllustrationVariant(
  runtime: TemplatePreviewRuntime,
  images: readonly string[],
  index: number,
): void {
  const image = images[index];
  if (image === undefined) {
    return;
  }

  detach(
    decodeIllustrationPreviewImage(runtime, illustrationHeroImageUrl(image)),
    Reason.DomCallback,
  );
}

type IllustrationThumbnailScrollDirection = -1 | 1;

const ILLUSTRATION_THUMBNAIL_REVEAL_COUNT = 2;
const ILLUSTRATION_THUMBNAIL_EDGE_TOLERANCE_PX = 1;

type IllustrationThumbnailScrollTarget = {
  element: HTMLElement;
  targetIsBoundary: boolean;
};

function illustrationThumbnailScrollTarget(
  node: HTMLElement,
  direction: IllustrationThumbnailScrollDirection,
): IllustrationThumbnailScrollTarget {
  let target = node;
  for (let i = 0; i < ILLUSTRATION_THUMBNAIL_REVEAL_COUNT; i += 1) {
    const sibling =
      direction > 0 ? target.nextElementSibling : target.previousElementSibling;
    if (!(sibling instanceof HTMLElement)) {
      return {
        element: target,
        targetIsBoundary: true,
      };
    }
    target = sibling;
  }
  const boundarySibling =
    direction > 0 ? target.nextElementSibling : target.previousElementSibling;
  return {
    element: target,
    targetIsBoundary: !(boundarySibling instanceof HTMLElement),
  };
}

function maxIllustrationThumbnailScrollLeft(
  thumbnailStrip: HTMLElement,
): number {
  return Math.max(0, thumbnailStrip.scrollWidth - thumbnailStrip.clientWidth);
}

function scrollIllustrationThumbnailIntoView(
  node: HTMLButtonElement | null,
  direction: IllustrationThumbnailScrollDirection,
): void {
  if (node === null) {
    return;
  }

  const thumbnailStrip = node.closest<HTMLElement>(
    "[data-illustration-variant-strip]",
  );
  if (thumbnailStrip === null) {
    return;
  }

  const { element: target, targetIsBoundary } =
    illustrationThumbnailScrollTarget(node, direction);

  if (direction < 0) {
    if (targetIsBoundary) {
      if (thumbnailStrip.scrollLeft > 0) {
        thumbnailStrip.scrollTo({
          left: 0,
        });
      }
      return;
    }

    const thumbnailStripRect = thumbnailStrip.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const leftOverflow = thumbnailStripRect.left - targetRect.left;
    if (leftOverflow > 0) {
      thumbnailStrip.scrollTo({
        left: Math.max(0, thumbnailStrip.scrollLeft - leftOverflow),
      });
    }
    return;
  }

  if (targetIsBoundary) {
    const maxScrollLeft = maxIllustrationThumbnailScrollLeft(thumbnailStrip);
    if (thumbnailStrip.scrollLeft < maxScrollLeft) {
      thumbnailStrip.scrollTo({
        left: maxScrollLeft,
      });
    }
    return;
  }

  const thumbnailStripRect = thumbnailStrip.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const rightOverflow = targetRect.right - thumbnailStripRect.right;
  if (rightOverflow > 0) {
    thumbnailStrip.scrollTo({
      left: Math.max(0, thumbnailStrip.scrollLeft + rightOverflow),
    });
  }
}

function activeIllustrationThumbnailScrollDirection(
  node: HTMLButtonElement,
): IllustrationThumbnailScrollDirection | null {
  const thumbnailStrip = node.closest<HTMLElement>(
    "[data-illustration-variant-strip]",
  );
  if (thumbnailStrip === null) {
    return null;
  }

  const thumbnailStripRect = thumbnailStrip.getBoundingClientRect();
  const thumbnailRect = node.getBoundingClientRect();
  const maxScrollLeft = maxIllustrationThumbnailScrollLeft(thumbnailStrip);

  if (
    thumbnailRect.right >=
      thumbnailStripRect.right - ILLUSTRATION_THUMBNAIL_EDGE_TOLERANCE_PX &&
    (node.nextElementSibling instanceof HTMLElement ||
      thumbnailStrip.scrollLeft < maxScrollLeft)
  ) {
    return 1;
  }

  if (
    thumbnailRect.left <=
      thumbnailStripRect.left + ILLUSTRATION_THUMBNAIL_EDGE_TOLERANCE_PX &&
    (node.previousElementSibling instanceof HTMLElement ||
      thumbnailStrip.scrollLeft > 0)
  ) {
    return -1;
  }

  return null;
}

function IllustrationTemplateCard({
  item,
  selected,
  activeIndex,
  priority = false,
  onSelect,
  onVariantChange,
  runtime,
}: {
  item: IllustrationTemplateItem;
  selected: boolean;
  activeIndex: number;
  priority?: boolean;
  onSelect: (item: IllustrationTemplateItem) => void;
  onVariantChange: (slug: string, index: number) => void;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const images = item.previewImages;
  const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1));
  const heroSource = images[safeIndex] ?? item.previewImage;
  const hasMultipleVariants = images.length > 1;

  return (
    <div
      data-illustration-template-card=""
      className={cn(
        "group mb-4 break-inside-avoid overflow-hidden rounded-xl border bg-card transition-colors",
        TEMPLATE_CARD_SHADOW,
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-border hover:border-muted-foreground/30",
      )}
    >
      <IllustrationTemplateHero
        item={item}
        images={images}
        activeIndex={safeIndex}
        priority={priority}
        source={heroSource}
        onVariantChange={onVariantChange}
        runtime={runtime}
      />
      {hasMultipleVariants && (
        <div
          data-illustration-variant-strip=""
          className="flex items-center gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {images.map((image, index) => {
            const active = index === safeIndex;
            const thumbnailImage = r2ImageTransformUrl(
              image,
              ILLUSTRATION_VARIANT_THUMB_SIZE,
            );
            return (
              <button
                key={image}
                type="button"
                aria-label={t(
                  ($) => {
                    return $.artifacts.templates.showVariant;
                  },
                  {
                    variantNumber: index + 1,
                  },
                )}
                aria-pressed={active}
                className={cn(
                  "relative h-12 w-12 shrink-0 overflow-hidden rounded-md border-2 bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary" : "border-border",
                )}
                onFocus={() => {
                  preloadIllustrationPreviewImage(
                    runtime,
                    illustrationHeroImageUrl(image),
                  );
                }}
                onMouseEnter={() => {
                  preloadIllustrationPreviewImage(
                    runtime,
                    illustrationHeroImageUrl(image),
                  );
                }}
                onClick={(event) => {
                  selectIllustrationVariant({
                    card: event.currentTarget.closest<HTMLElement>(
                      "[data-illustration-template-card]",
                    ),
                    index,
                    item,
                    onVariantChange,
                    runtime,
                  });
                  const scrollDirection = active
                    ? activeIllustrationThumbnailScrollDirection(
                        event.currentTarget,
                      )
                    : index > safeIndex
                      ? 1
                      : -1;
                  if (scrollDirection !== null) {
                    scrollIllustrationThumbnailIntoView(
                      event.currentTarget,
                      scrollDirection,
                    );
                  }
                }}
              >
                <img
                  src={thumbnailImage}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </button>
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 px-3.5 py-3">
        <p className="min-w-0 truncate text-sm font-semibold text-foreground">
          {item.title}
        </p>
        <button
          type="button"
          aria-label={t(
            ($) => {
              return $.artifacts.templates.selectTemplate;
            },
            {
              title: item.title,
            },
          )}
          aria-pressed={selected}
          onClick={() => {
            onSelect(item);
          }}
          className={cn(
            "h-8 shrink-0 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-background text-foreground hover:bg-muted",
          )}
        >
          {t(($) => {
            return $.artifacts.templates.use;
          })}
        </button>
      </div>
    </div>
  );
}

function resolveTemplatePickerCategory({
  category,
  hasPptTab,
  hasIllustrationTab,
  hasVideoTab,
  hasWorkflowTab,
}: {
  category: string;
  hasPptTab: boolean;
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
  hasWorkflowTab: boolean;
}): string {
  const categories: string[] = [];
  if (hasPptTab) {
    categories.push("slides");
  }
  categories.push("website");
  if (hasIllustrationTab) {
    categories.push("illustration");
  }
  if (hasVideoTab) {
    categories.push("video");
  }
  if (hasWorkflowTab) {
    categories.push("workflow");
  }
  const defaultCategory = categories[0] ?? "slides";
  return categories.includes(category) ? category : defaultCategory;
}

function TemplatePickerCategoryNav({
  selectedCategory,
  hasPptTab,
  hasIllustrationTab,
  hasVideoTab,
  hasWorkflowTab,
  onChange,
}: {
  selectedCategory: string;
  hasPptTab: boolean;
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
  hasWorkflowTab: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const categoryOptions: {
    value: string;
    label: string;
    Icon: typeof IconPresentation;
  }[] = [];
  if (hasPptTab) {
    categoryOptions.push({
      value: "slides",
      label: t(($) => {
        return $.artifacts.kinds.presentation;
      }),
      Icon: IconPresentation,
    });
  }
  categoryOptions.push({
    value: "website",
    label: t(($) => {
      return $.artifacts.templates.website;
    }),
    Icon: IconWorld,
  });
  if (hasIllustrationTab) {
    categoryOptions.push({
      value: "illustration",
      label: t(($) => {
        return $.artifacts.templates.illustration;
      }),
      Icon: IconPhoto,
    });
  }
  if (hasVideoTab) {
    categoryOptions.push({
      value: "video",
      label: t(($) => {
        return $.artifacts.kinds.video;
      }),
      Icon: IconVideo,
    });
  }
  if (hasWorkflowTab) {
    categoryOptions.push({
      value: "workflow",
      label: t(($) => {
        return $.artifacts.templates.workflow;
      }),
      Icon: IconRoute,
    });
  }

  return (
    <>
      <div className="shrink-0 border-b border-border bg-gray-50 px-4 pb-4 pr-14 pt-4 sm:hidden">
        <Select value={selectedCategory} onValueChange={onChange}>
          <SelectTrigger
            aria-label={t(($) => {
              return $.artifacts.templates.category;
            })}
            className="h-9 w-full bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {categoryOptions.map(({ value, label, Icon }) => {
              return (
                <SelectItem key={value} value={value}>
                  <span className="flex items-center gap-2">
                    <Icon className="h-4 w-4" stroke={1.8} />
                    {label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <nav
        role="tablist"
        aria-label={t(($) => {
          return $.artifacts.templates.categories;
        })}
        aria-orientation="vertical"
        data-template-picker-sidebar=""
        className="hidden w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-gray-50 p-3 sm:flex"
      >
        <div className="flex min-h-[50px] items-center px-2">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.artifacts.templates.template;
            })}
          </h2>
        </div>
        {categoryOptions.map(({ value, label, Icon }, categoryIndex) => {
          const selected = value === selectedCategory;
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                onChange(value);
              }}
              onKeyDown={(event) => {
                let nextIndex: number | null = null;
                if (event.key === "ArrowDown") {
                  nextIndex = (categoryIndex + 1) % categoryOptions.length;
                } else if (event.key === "ArrowUp") {
                  nextIndex =
                    (categoryIndex - 1 + categoryOptions.length) %
                    categoryOptions.length;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = categoryOptions.length - 1;
                }
                if (nextIndex === null) {
                  return;
                }
                event.preventDefault();
                const nextTab = event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLElement>("[role=tab]")
                  .item(nextIndex);
                nextTab?.focus();
                onChange(categoryOptions[nextIndex]?.value ?? value);
              }}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected
                  ? "bg-gray-200 font-medium text-sidebar-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent focus-visible:bg-sidebar-accent",
              )}
            >
              <Icon className="h-4 w-4 shrink-0 text-gray-700" stroke={1.8} />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}

function TemplatePickerCategoryHeader({
  selectedCategory,
}: {
  selectedCategory: string;
}) {
  const { t } = useTranslation();
  const title =
    selectedCategory === "slides"
      ? t(($) => {
          return $.artifacts.kinds.presentation;
        })
      : selectedCategory === "website"
        ? t(($) => {
            return $.artifacts.templates.website;
          })
        : selectedCategory === "illustration"
          ? t(($) => {
              return $.artifacts.templates.illustration;
            })
          : selectedCategory === "video"
            ? t(($) => {
                return $.artifacts.kinds.video;
              })
            : selectedCategory === "workflow"
              ? t(($) => {
                  return $.artifacts.templates.workflow;
                })
              : t(($) => {
                  return $.artifacts.templates.template;
                });
  return (
    <header
      className={cn(
        "hidden min-h-[74px] shrink-0 items-center border-b border-border px-5 py-4 sm:flex",
        selectedCategory === "workflow" ? "pr-[21rem]" : "pr-14",
      )}
    >
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h2>
      </div>
    </header>
  );
}

function TemplatePickerWorkflowSearch({
  selectedCategory,
  search,
  onSearchChange,
}: {
  selectedCategory: string;
  search: string;
  onSearchChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (selectedCategory !== "workflow") {
    return null;
  }
  return (
    <div className="shrink-0 border-b border-border px-4 py-3 sm:absolute sm:right-14 sm:top-[21px] sm:z-10 sm:w-64 sm:border-0 sm:p-0">
      <div className="relative">
        <IconSearch
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          stroke={1.8}
        />
        <Input
          aria-label={t(($) => {
            return $.artifacts.templates.searchConnectors;
          })}
          className="h-9 pl-9 text-sm sm:h-8"
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
          }}
          placeholder={t(($) => {
            return $.artifacts.templates.searchConnector;
          })}
        />
      </div>
    </div>
  );
}

function IllustrationTemplateGrid({
  items,
  runtime,
  value,
  variantIndexBySlug,
  onSelect,
  onVariantChange,
}: {
  items: readonly IllustrationTemplateItem[];
  runtime: TemplatePreviewRuntime;
  value: GenerationTemplateRequest | undefined;
  variantIndexBySlug: Readonly<Record<string, number>>;
  onSelect: (item: IllustrationTemplateItem) => void;
  onVariantChange: (slug: string, index: number) => void;
}) {
  // CSS multi-column masonry mirrors www.vm0.ai/illustration: each tile renders
  // the full illustration at its native aspect ratio (no cropping, letterbox,
  // or fixed height), and the column count adapts to the dialog width.
  return (
    <div className="columns-[244px] gap-4">
      {items.map((item, index) => {
        return (
          <IllustrationTemplateCard
            key={item.illustrationStyleId}
            item={item}
            selected={isSelectedIllustrationTemplate(item, value)}
            activeIndex={variantIndexBySlug[item.slug] ?? 0}
            priority={index < ILLUSTRATION_EAGER_IMAGE_COUNT}
            onSelect={onSelect}
            onVariantChange={onVariantChange}
            runtime={runtime}
          />
        );
      })}
    </div>
  );
}

function PptTemplateGrid({
  items,
  runtime,
  value,
  onSelect,
  onPreview,
}: {
  items: readonly PresentationTemplateItem[];
  runtime: TemplatePreviewRuntime;
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: PresentationTemplateItem, colorSystemId?: string) => void;
  onPreview: (item: PresentationTemplateItem, slideIndex?: number) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <PptCard
            key={item.slug}
            item={item}
            selected={isSelectedPresentationTemplate(item, value)}
            onSelect={onSelect}
            onPreview={onPreview}
            runtime={runtime}
          />
        );
      })}
    </div>
  );
}

function TemplatePickerDialog({
  value,
  onChange,
  onClose,
  skipEnterAnimation,
  hasPptTab,
  presentationItems,
  hasIllustrationTab,
  hasVideoTab,
  hasWorkflowTab,
  runtime,
}: {
  value: GenerationTemplateRequest | undefined;
  onChange: (value: GenerationTemplateRequest | undefined) => void;
  onClose: () => void;
  skipEnterAnimation: boolean;
  hasPptTab: boolean;
  presentationItems: readonly PresentationTemplateItem[];
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
  hasWorkflowTab: boolean;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const category = useGet(templatePickerCategory$);
  const setCategory = useSet(setTemplatePickerCategory$);
  const search = useGet(templatePickerSearch$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const previewSlug = useGet(templatePickerPreviewSlug$);
  const restorePresentationGridScroll = useSet(
    restoreTemplatePickerPresentationScroll$,
  );
  const setPresentationGridScrollTop = useSet(
    setTemplatePickerPresentationScrollTop$,
  );
  const detailPreview = useGet(templateDetailHtmlPreview$);
  const ownPreviewResources = useSet(ownTemplatePickerPreviewResources$);
  const releasePreviewResources = useSet(
    releaseTemplatePickerPreviewResources$,
  );
  const openDetailPreview = useSet(openPresentationTemplateDetailPreview$);
  const selectDetailPreview = useSet(selectPresentationTemplateDetailPreview$);
  const closeDetailPreview = useSet(closePresentationTemplateDetailPreview$);
  const openWebsiteTemplatePreview = useSet(openWebsiteTemplatePreview$);
  const cardThemeIdBySlug = useGet(templateCardThemeIdBySlug$);
  const illustrationVariantIndex = useGet(illustrationVariantIndex$);
  const setIllustrationVariantIndex = useSet(setIllustrationVariantIndex$);
  const previewItem =
    presentationItems.find((item) => {
      return item.slug === previewSlug;
    }) ?? null;
  const isPreviewing = Boolean(previewItem);
  const dialogContentClassName = cn(
    "gap-0 overflow-hidden p-0 focus:outline-none focus-visible:outline-none focus-visible:ring-0",
    skipEnterAnimation && "data-[state=open]:!animate-none",
    isPreviewing
      ? "flex h-[min(90dvh,760px)] max-w-6xl flex-col sm:h-auto [&>button]:top-[7px]"
      : "flex h-[min(82vh,760px)] max-w-6xl flex-col [&>button]:top-[7px] sm:[&>button]:top-[19px]",
  );
  const filteredPptItems = presentationItems;
  const filteredIllustrationItems = ILLUSTRATION_TEMPLATE_ITEMS;
  const filteredVideoItems = VIDEO_TEMPLATE_ITEMS;
  const filteredWebsiteItems = WEBSITE_TEMPLATE_ITEMS;
  // A persona pill filters the grid, ideation-gallery style.
  // resolveWorkflowCatalog() keeps that logic out of this component to stay
  // under the complexity budget.
  const workflowCategoryFilter = useGet(templatePickerWorkflowCategory$);
  const setWorkflowCategoryFilter = useSet(setTemplatePickerWorkflowCategory$);
  const workflowCatalog = resolveWorkflowCatalog({
    categoryFilter: workflowCategoryFilter,
    search,
  });

  const selectedCategory = resolveTemplatePickerCategory({
    category,
    hasPptTab,
    hasIllustrationTab,
    hasVideoTab,
    hasWorkflowTab,
  });

  const previewImageUrlsForCategory = (targetCategory: string) => {
    if (targetCategory === "slides" && hasPptTab) {
      return presentationPreviewImageUrlsForItems(
        presentationItems,
        cardThemeIdBySlug,
      );
    }
    if (targetCategory === "illustration" && hasIllustrationTab) {
      return illustrationPreviewImageUrlsForItems({
        items: ILLUSTRATION_TEMPLATE_ITEMS,
        variantIndexBySlug: illustrationVariantIndex,
      });
    }
    if (targetCategory === "video" && hasVideoTab) {
      return videoPreviewImageUrlsForItems(VIDEO_TEMPLATE_ITEMS);
    }
    if (targetCategory === "website") {
      return websitePreviewImageUrlsForItems(WEBSITE_TEMPLATE_ITEMS);
    }
    return [];
  };

  const prewarmTemplatePreviewsForCategory = (targetCategory: string) => {
    prewarmTemplatePreviewImages(
      runtime,
      previewImageUrlsForCategory(targetCategory),
      templatePreviewPrewarmImageCountForCategory(targetCategory),
    );
  };

  const closeTemplatePicker = () => {
    releasePreviewResources(runtime);
    setPresentationGridScrollTop(0);
    onClose();
  };

  const handleSelectPresentation = (
    item: PresentationTemplateItem,
    colorSystemId?: string,
  ) => {
    onChange(toPresentationGenerationTemplate(item, colorSystemId));
    closeTemplatePicker();
  };

  const handleSelectVideo = (item: VideoTemplateItem) => {
    onChange(toVideoGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handleSelectWorkflow = (item: WorkflowTemplateItem) => {
    onChange(toWorkflowGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handleSelectWebsite = (item: WebsiteTemplateItem) => {
    onChange(toWebsiteGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handlePreviewWebsite = (item: WebsiteTemplateItem) => {
    openWebsiteTemplatePreview(item.id);
  };

  const handleSelectIllustration = (item: IllustrationTemplateItem) => {
    onChange(toIllustrationGenerationTemplate(item));
    closeTemplatePicker();
  };

  const handlePreview = (item: PresentationTemplateItem, slideIndex = 0) => {
    const selectedTheme = findPresentationTemplateTheme(
      cardThemeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item),
    );
    const selectedSlideIndex = Math.max(0, Math.floor(slideIndex));
    detach(
      openDetailPreview(
        {
          index: selectedSlideIndex,
          item,
          runtime,
          themeCss: presentationTemplateThemeCss(selectedTheme),
          themeId: selectedTheme.id,
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const previewDetailNavigationState = () => {
    if (previewItem === null) {
      return null;
    }
    const activeDetailPreview =
      detailPreview?.slug === previewItem.slug &&
      detailPreview.embedUrl === previewItem.embedUrl
        ? detailPreview
        : null;
    const selectedThemeId =
      activeDetailPreview?.themeId ??
      cardThemeIdBySlug[previewItem.slug] ??
      defaultPresentationTemplateThemeId(previewItem);
    const selectedTheme = findPresentationTemplateTheme(selectedThemeId);
    const detailSlideCount =
      activeDetailPreview?.slideCount ??
      presentationTemplateSlideCount(previewItem);
    return {
      activeSlideIndex: activeDetailPreview?.index ?? 0,
      detailSlideCount,
      selectedTheme,
    };
  };

  const selectPreviewDetailSlide = (index: number) => {
    if (previewItem === null) {
      return;
    }
    const navigationState = previewDetailNavigationState();
    if (navigationState === null) {
      return;
    }
    selectDetailPreview({
      item: previewItem,
      runtime,
      index: Math.max(0, Math.min(navigationState.detailSlideCount - 1, index)),
      themeCss: presentationTemplateThemeCss(navigationState.selectedTheme),
      themeId: navigationState.selectedTheme.id,
    });
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!isPreviewing || event.defaultPrevented) {
      return;
    }
    const navigationState = previewDetailNavigationState();
    if (navigationState === null) {
      return;
    }
    if (event.key === "ArrowLeft") {
      if (navigationState.activeSlideIndex > 0) {
        event.preventDefault();
        selectPreviewDetailSlide(navigationState.activeSlideIndex - 1);
      }
    }
    if (event.key === "ArrowRight") {
      if (
        navigationState.activeSlideIndex <
        navigationState.detailSlideCount - 1
      ) {
        event.preventDefault();
        selectPreviewDetailSlide(navigationState.activeSlideIndex + 1);
      }
    }
  };

  const handleCategoryChange = (nextCategory: string) => {
    setCategory(nextCategory);
    if (!isPreviewing) {
      prewarmTemplatePreviewsForCategory(nextCategory);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (!isPreviewing) {
      prewarmTemplatePreviewsForCategory(selectedCategory);
    }
  };

  const restorePresentationGridScrollNode = (node: HTMLDivElement | null) => {
    if (node === null) {
      return;
    }
    restorePresentationGridScroll(node);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (isPreviewing) {
            closeDetailPreview(runtime);
            return;
          }
          closeTemplatePicker();
        }
      }}
    >
      <DialogContent
        closeLabel={t(($) => {
          return $.artifacts.actions.close;
        })}
        className={dialogContentClassName}
        overlayClassName={
          skipEnterAnimation ? "data-[state=open]:!animate-none" : undefined
        }
        aria-describedby={undefined}
        onKeyDown={handleDialogKeyDown}
        onKeyDownCapture={
          isPreviewing ? handleTemplateDetailTabKeyDown : undefined
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          ownPreviewResources(runtime, pageSignal);
          if (!isPreviewing) {
            prewarmTemplatePreviewsForCategory(selectedCategory);
          }
        }}
      >
        {previewItem ? (
          <TemplatePreviewPage
            item={previewItem}
            onBack={() => {
              closeDetailPreview(runtime);
            }}
            onSelect={handleSelectPresentation}
            runtime={runtime}
          />
        ) : (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-4 sm:hidden">
              <DialogTitle>
                {t(($) => {
                  return $.artifacts.templates.template;
                })}
              </DialogTitle>
            </DialogHeader>
            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <TemplatePickerCategoryNav
                selectedCategory={selectedCategory}
                hasPptTab={hasPptTab}
                hasIllustrationTab={hasIllustrationTab}
                hasVideoTab={hasVideoTab}
                hasWorkflowTab={hasWorkflowTab}
                onChange={handleCategoryChange}
              />
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                <TemplatePickerCategoryHeader
                  selectedCategory={selectedCategory}
                />
                <TemplatePickerWorkflowSearch
                  selectedCategory={selectedCategory}
                  search={search}
                  onSearchChange={handleSearchChange}
                />
                <TemplatePickerCategoryContent
                  selectedCategory={selectedCategory}
                  hasPptTab={hasPptTab}
                  hasVideoTab={hasVideoTab}
                  hasWorkflowTab={hasWorkflowTab}
                  filteredPptItems={filteredPptItems}
                  filteredWebsiteItems={filteredWebsiteItems}
                  filteredIllustrationItems={filteredIllustrationItems}
                  filteredVideoItems={filteredVideoItems}
                  workflowCatalog={workflowCatalog}
                  value={value}
                  illustrationVariantIndex={illustrationVariantIndex}
                  onPresentationScroll={setPresentationGridScrollTop}
                  onRestorePresentationScroll={
                    restorePresentationGridScrollNode
                  }
                  onSelectPresentation={handleSelectPresentation}
                  onPreviewPresentation={handlePreview}
                  onSelectWebsite={handleSelectWebsite}
                  onPreviewWebsite={handlePreviewWebsite}
                  onSelectIllustration={handleSelectIllustration}
                  onIllustrationVariantChange={setIllustrationVariantIndex}
                  onSelectVideo={handleSelectVideo}
                  onWorkflowCategoryChange={setWorkflowCategoryFilter}
                  onSelectWorkflow={handleSelectWorkflow}
                  runtime={runtime}
                />
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TemplatePickerCategoryContent({
  selectedCategory,
  hasPptTab,
  hasVideoTab,
  hasWorkflowTab,
  filteredPptItems,
  filteredWebsiteItems,
  filteredIllustrationItems,
  filteredVideoItems,
  workflowCatalog,
  value,
  illustrationVariantIndex,
  onPresentationScroll,
  onRestorePresentationScroll,
  onSelectPresentation,
  onPreviewPresentation,
  onSelectWebsite,
  onPreviewWebsite,
  onSelectIllustration,
  onIllustrationVariantChange,
  onSelectVideo,
  onWorkflowCategoryChange,
  onSelectWorkflow,
  runtime,
}: {
  selectedCategory: string;
  hasPptTab: boolean;
  hasVideoTab: boolean;
  hasWorkflowTab: boolean;
  filteredPptItems: readonly PresentationTemplateItem[];
  filteredWebsiteItems: readonly WebsiteTemplateItem[];
  filteredIllustrationItems: readonly IllustrationTemplateItem[];
  filteredVideoItems: readonly VideoTemplateItem[];
  workflowCatalog: ResolvedWorkflowTemplateCatalog;
  value: GenerationTemplateRequest | undefined;
  illustrationVariantIndex: Readonly<Record<string, number>>;
  onPresentationScroll: (value: number) => void;
  onRestorePresentationScroll: (node: HTMLDivElement | null) => void;
  onSelectPresentation: (
    item: PresentationTemplateItem,
    colorSystemId?: string,
  ) => void;
  onPreviewPresentation: (
    item: PresentationTemplateItem,
    slideIndex?: number,
  ) => void;
  onSelectWebsite: (item: WebsiteTemplateItem) => void;
  onPreviewWebsite: (item: WebsiteTemplateItem) => void;
  onSelectIllustration: (item: IllustrationTemplateItem) => void;
  onIllustrationVariantChange: (slug: string, index: number) => void;
  onSelectVideo: (item: VideoTemplateItem) => void;
  onWorkflowCategoryChange: (category: string) => void;
  onSelectWorkflow: (item: WorkflowTemplateItem) => void;
  runtime: TemplatePreviewRuntime;
}) {
  if (selectedCategory === "slides" && hasPptTab) {
    return (
      <div
        data-presentation-template-grid-scroll=""
        ref={onRestorePresentationScroll}
        className="relative flex min-h-0 flex-1 transform-gpu flex-col overflow-y-auto px-5 py-4"
        onScroll={(event) => {
          onPresentationScroll(event.currentTarget.scrollTop);
        }}
      >
        {filteredPptItems.length > 0 ? (
          <PptTemplateGrid
            items={filteredPptItems}
            value={value}
            onSelect={onSelectPresentation}
            onPreview={onPreviewPresentation}
            runtime={runtime}
          />
        ) : (
          <TemplateEmptyPanel />
        )}
      </div>
    );
  }

  if (selectedCategory === "website") {
    return (
      <div
        data-website-template-grid-scroll=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
      >
        {filteredWebsiteItems.length > 0 ? (
          <WebsiteTemplateGrid
            items={filteredWebsiteItems}
            value={value}
            onSelect={onSelectWebsite}
            onPreview={onPreviewWebsite}
          />
        ) : (
          <TemplateEmptyPanel />
        )}
      </div>
    );
  }

  if (selectedCategory === "illustration") {
    return (
      <div
        data-illustration-template-grid-scroll=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
        onScroll={(event) => {
          prewarmIllustrationPreviewImagesNearScroll({
            items: filteredIllustrationItems,
            runtime,
            scrollContainer: event.currentTarget,
            variantIndexBySlug: illustrationVariantIndex,
          });
        }}
      >
        {filteredIllustrationItems.length > 0 ? (
          <IllustrationTemplateGrid
            items={filteredIllustrationItems}
            value={value}
            variantIndexBySlug={illustrationVariantIndex}
            onSelect={onSelectIllustration}
            onVariantChange={onIllustrationVariantChange}
            runtime={runtime}
          />
        ) : (
          <TemplateEmptyPanel />
        )}
      </div>
    );
  }

  if (selectedCategory === "video" && hasVideoTab) {
    return (
      <div
        data-video-template-grid-scroll=""
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
      >
        {filteredVideoItems.length > 0 ? (
          <VideoTemplateGrid
            items={filteredVideoItems}
            value={value}
            onSelect={onSelectVideo}
          />
        ) : (
          <TemplateEmptyPanel />
        )}
      </div>
    );
  }

  if (selectedCategory === "workflow" && hasWorkflowTab) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {workflowCatalog.pills.length > 1 && (
          <WorkflowTemplatePillRow
            pills={workflowCatalog.pills}
            active={workflowCatalog.active}
            onSelect={onWorkflowCategoryChange}
          />
        )}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            data-workflow-template-grid-scroll=""
            className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
          >
            {workflowCatalog.items.length > 0 ? (
              <WorkflowTemplateGrid
                items={workflowCatalog.items}
                value={value}
                onSelect={onSelectWorkflow}
              />
            ) : (
              <TemplateEmptyPanel />
            )}
          </div>
          {/* Soften the hard clip where cards scroll up under the pill row,
              mirroring the chat-to-composer top fade. */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-card to-transparent" />
        </div>
      </div>
    );
  }

  return null;
}

function selectedComposerTemplateAttachment(
  value: GenerationTemplateRequest | undefined,
): ComposerTemplateAttachment | undefined {
  const presentationItem = selectedPresentationTemplateItem(value);
  if (presentationItem && value?.type === "presentation") {
    const selectedTheme = findPresentationTemplateTheme(
      value.selection.colorSystemId?.replace("color-system:", "") ??
        defaultPresentationTemplateThemeId(presentationItem),
    );
    return {
      type: "presentation",
      title: presentationItem.title,
      category: "slides",
      previewImageUrl: presentationTemplateCardSlideImage(
        presentationItem,
        0,
        selectedTheme,
        SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE,
      ),
    };
  }
  const illustrationItem = selectedIllustrationTemplateItem(value);
  if (illustrationItem) {
    return {
      type: "illustration",
      title: illustrationItem.title,
      category: "illustration",
      previewImageUrl: r2ImageTransformUrl(
        illustrationItem.previewImage,
        SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE,
      ),
    };
  }
  const videoItem = selectedVideoTemplateItem(value);
  if (videoItem) {
    return { type: "video", title: videoItem.title, category: "video" };
  }
  const workflowItem = selectedWorkflowTemplateItem(value);
  if (workflowItem) {
    return {
      type: "workflow",
      title: workflowItem.title,
      category: "workflow",
    };
  }
  const websiteItem = selectedWebsiteTemplateItem(value);
  return websiteItem
    ? { type: "website", title: websiteItem.title, category: "website" }
    : undefined;
}

function inlineComposerTemplatePicker({
  picker,
  enabled,
  insertTemplate,
  onDraftChange,
}: {
  picker: ComposerTemplatePicker | undefined;
  enabled: boolean;
  insertTemplate: (
    value: GenerationTemplateRequest,
    attachment: ComposerTemplateAttachment,
  ) => void;
  onDraftChange: (() => void) | undefined;
}): ComposerTemplatePicker | undefined {
  if (!picker || !enabled) {
    return picker;
  }
  return {
    value: undefined,
    onChange(value) {
      if (!value) {
        return;
      }
      const attachment = selectedComposerTemplateAttachment(value);
      if (!attachment) {
        return;
      }
      insertTemplate(value, attachment);
      onDraftChange?.();
    },
  };
}

function userMessageInlineTemplatesEnabled(
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>>,
): boolean {
  return (
    featureSwitches[FeatureSwitchKey.StructuredPromptInlineTemplates] === true
  );
}

function composerTemplateAttachmentLifecycleKey(
  attachment: ComposerTemplateAttachment | undefined,
): string {
  return attachment
    ? JSON.stringify([
        attachment.type,
        attachment.title,
        attachment.category,
        attachment.previewImageUrl,
      ])
    : "none";
}

function ComposerTemplateAttachmentSync({
  composer,
  picker,
  onDraftChange,
  runtime,
}: {
  composer: WorkflowComposerSignals;
  picker: ComposerTemplatePicker | undefined;
  onDraftChange: (() => void) | undefined;
  runtime: TemplatePreviewRuntime;
}) {
  const setLifecycleRef = useSet(composer.setTemplateAttachmentLifecycleRef$);
  const setOpen = useSet(setTemplatePickerOpen$);
  const setCategory = useSet(setTemplatePickerCategory$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const setReferenceValue = useSet(setTemplatePickerReferenceValue$);
  const readSelectedTemplate = useSet(composer.readSelectedTemplate$);
  const cardThemeIdBySlug = useGet(templateCardThemeIdBySlug$);
  const attachment = selectedComposerTemplateAttachment(picker?.value);
  const openPicker = (category: string) => {
    prewarmTemplatePreviewImages(
      runtime,
      initialTemplatePreviewImageUrlsForCategory({
        category,
        hasPptTab: true,
        hasIllustrationTab: true,
        hasVideoTab: true,
        presentationThemeIdBySlug: cardThemeIdBySlug,
      }),
      templatePreviewPrewarmImageCountForCategory(category),
    );
    setSearch("");
    setPreviewSlug(null);
    setReferenceValue(readSelectedTemplate() ?? null);
    setCategory(category);
    setOpen(true);
  };

  return (
    <button
      key={composerTemplateAttachmentLifecycleKey(attachment)}
      ref={setLifecycleRef}
      type="button"
      hidden
      data-template-type={attachment?.type}
      data-template-title={attachment?.title}
      data-template-category={attachment?.category}
      data-template-preview-url={attachment?.previewImageUrl}
      onClick={(event) => {
        const action = event.currentTarget.dataset.templateAction;
        if (action === "open") {
          openPicker(event.currentTarget.dataset.templateCategory ?? "slides");
        } else if (action === "remove") {
          picker?.onChange(undefined);
          onDraftChange?.();
        }
      }}
    />
  );
}

function TemplatePickerButton({
  picker,
  onOpen,
  hasPptTab,
  presentationItems,
  hasIllustrationTab,
  hasVideoTab,
  hasWorkflowTab,
  runtime,
}: {
  picker: ComposerTemplatePicker;
  onOpen: () => void;
  hasPptTab: boolean;
  presentationItems: readonly PresentationTemplateItem[];
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
  hasWorkflowTab: boolean;
  runtime: TemplatePreviewRuntime;
}) {
  const { t } = useTranslation();
  const open = useGet(templatePickerOpen$);
  const skipEnterAnimation = useGet(templatePickerSkipEnterAnimation$);
  const category = useGet(templatePickerCategory$);
  const referenceValue = useGet(templatePickerReferenceValue$);
  const setOpen = useSet(setTemplatePickerOpen$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const setReferenceValue = useSet(setTemplatePickerReferenceValue$);
  const cardThemeIdBySlug = useGet(templateCardThemeIdBySlug$);
  const selectedTitle = selectedTemplateTitle(picker.value);
  const selectedCategory = resolveTemplatePickerCategory({
    category,
    hasPptTab,
    hasIllustrationTab,
    hasVideoTab,
    hasWorkflowTab,
  });
  const prewarmPicker = () => {
    prewarmTemplatePreviewImages(
      runtime,
      initialTemplatePreviewImageUrlsForCategory({
        category: selectedCategory,
        hasPptTab,
        hasIllustrationTab,
        hasVideoTab,
        presentationThemeIdBySlug: cardThemeIdBySlug,
      }),
      templatePreviewPrewarmImageCountForCategory(selectedCategory),
    );
  };

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 hover:bg-accent hover:text-foreground sm:h-9 sm:w-9",
                COMPOSER_CONTROL_FOCUS_CLASS,
                picker.value && "bg-accent text-foreground",
              )}
              aria-label={t(($) => {
                return $.artifacts.templates.template;
              })}
              aria-pressed={picker.value !== undefined}
              onPointerEnter={prewarmPicker}
              onFocus={prewarmPicker}
              onPointerDown={prewarmPicker}
              onClick={() => {
                onOpen();
                prewarmPicker();
                setSearch("");
                setPreviewSlug(null);
                setReferenceValue(null);
                setOpen(true);
              }}
            >
              <IconColorSwatch size={18} stroke={1.5} aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {selectedTitle
              ? t(
                  ($) => {
                    return $.artifacts.templates.selected;
                  },
                  {
                    title: selectedTitle,
                  },
                )
              : t(($) => {
                  return $.artifacts.templates.template;
                })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {open && (
        <TemplatePickerDialog
          value={referenceValue ?? picker.value}
          onChange={picker.onChange}
          onClose={() => {
            setReferenceValue(null);
            setOpen(false);
          }}
          skipEnterAnimation={skipEnterAnimation}
          hasPptTab={hasPptTab}
          presentationItems={presentationItems}
          hasIllustrationTab={hasIllustrationTab}
          hasVideoTab={hasVideoTab}
          hasWorkflowTab={hasWorkflowTab}
          runtime={runtime}
        />
      )}
    </>
  );
}

function ComposerTemplatePickerSlot({
  composer,
  picker,
}: {
  composer: WorkflowComposerSignals;
  picker: ComposerTemplatePicker | undefined;
}) {
  const hasPptTab = true;
  const hasIllustrationTab = true;
  const hasVideoTab = true;
  const hasWorkflowTab = true;
  const presentationItems = PRESENTATION_TEMPLATE_PICKER_ITEMS;
  const prepareTemplateInsertion = useSet(composer.prepareTemplateInsertion$);
  if (!picker) {
    return null;
  }
  return (
    <TemplatePickerButton
      picker={picker}
      onOpen={prepareTemplateInsertion}
      hasPptTab={hasPptTab}
      presentationItems={presentationItems}
      hasIllustrationTab={hasIllustrationTab}
      hasVideoTab={hasVideoTab}
      hasWorkflowTab={hasWorkflowTab}
      runtime={composer.templatePreview}
    />
  );
}

function CreateWorkflowPromptButton({
  onCreateWorkflowPrompt,
}: {
  onCreateWorkflowPrompt: () => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 hover:bg-accent hover:text-foreground sm:h-9 sm:w-9",
              COMPOSER_CONTROL_FOCUS_CLASS,
            )}
            aria-label="Create workflow"
            onClick={onCreateWorkflowPrompt}
          >
            <IconRoute size={18} stroke={1.5} aria-hidden="true" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Create workflow
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComposerWorkflowPromptSlot({
  onCreateWorkflowPrompt,
}: {
  onCreateWorkflowPrompt: (() => void) | undefined;
}) {
  if (!onCreateWorkflowPrompt) {
    return null;
  }
  return (
    <CreateWorkflowPromptButton
      onCreateWorkflowPrompt={onCreateWorkflowPrompt}
    />
  );
}

function ConnectorTriggerIcons({
  connectors,
  hasComputerUse,
  hasCloudBrowser,
}: {
  connectors: ComposerConnectorItem[];
  hasComputerUse: boolean;
  hasCloudBrowser: boolean;
}) {
  const enabled = connectors
    .filter((c) => {
      return c.authorized;
    })
    .slice(0, 3);
  if (enabled.length === 0 && !hasComputerUse && !hasCloudBrowser) {
    return <IconPlug size={18} stroke={1.5} />;
  }
  return (
    <span className="flex items-center -space-x-2 sm:-space-x-1.5">
      {enabled.map((c) => {
        return (
          <span key={c.connectorRef} className="relative shrink-0">
            <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-background zero-border sm:h-7 sm:w-7">
              <ConnectorIcon icon={c.icon} size={16} />
            </span>
          </span>
        );
      })}
      {hasComputerUse && (
        <span className="relative shrink-0">
          <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-background text-primary zero-border sm:h-7 sm:w-7">
            <IconDeviceDesktop size={16} stroke={1.5} />
          </span>
        </span>
      )}
      {hasCloudBrowser && (
        <span className="relative shrink-0">
          <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-background text-primary zero-border sm:h-7 sm:w-7">
            <IconWorld size={16} stroke={1.5} />
          </span>
        </span>
      )}
    </span>
  );
}

function AddConnectorsDialog({
  signals,
  unconnected,
  busyConnectorSlug,
  connectHandlers,
  onClose,
}: {
  signals: ComposerConnectorSignals;
  unconnected: PublicConnectorCatalogStatusItem[];
  busyConnectorSlug: ConnectorSlug | null;
  connectHandlers: (
    connector: PublicConnectorCatalogStatusItem,
  ) => ConnectorConnectHandlers;
  onClose: () => void;
}) {
  const search = useGet(signals.addDialogSearch$);
  const setSearch = useSet(signals.setAddDialogSearch$);
  const filtered = unconnected.filter((item) => {
    return matchesConnectorSearch(search, item);
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        return !open && onClose();
      }}
    >
      <DialogContent
        className="zero-app max-w-2xl flex max-h-[80vh] flex-col"
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>
            Available connectors to connect ({unconnected.length})
          </DialogTitle>
        </DialogHeader>
        <div className="shrink-0">
          <Input
            type="text"
            placeholder="Find connectors..."
            value={search}
            onChange={(e) => {
              return setSearch(e.target.value);
            }}
            autoFocus
          />
        </div>
        <div className="overflow-y-auto -mx-6 px-6">
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((item) => {
              return (
                <ConnectorCard
                  key={item.connectorRef}
                  variant="catalog"
                  connector={item}
                  busy={busyConnectorSlug === item.connectorRef}
                  connect={connectHandlers(item)}
                />
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ComputerUseConnectorMenuSection({
  computerUse,
  onOpenDownloadDialog,
}: {
  computerUse: ComposerComputerUse;
  onOpenDownloadDialog: () => void;
}) {
  return (
    <div className="shrink-0 border-t border-border/50 bg-gray-50 p-1 dark:bg-gray-100">
      <div className="px-2 pb-1 pt-1 text-xs text-muted-foreground">
        Your computer
      </div>
      {computerUse.cloudBrowserAvailable && (
        <div
          onClick={() => {
            computerUse.onCloudBrowserChange(!computerUse.cloudBrowserEnabled);
          }}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 transition-colors",
            computerUse.cloudBrowserEnabled
              ? "bg-primary/5"
              : "hover:bg-gray-100 dark:hover:bg-gray-200",
          )}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
            <IconWorld size={16} stroke={1.5} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">
              Cloud browser
            </span>
          </span>
          <span
            className="flex shrink-0 items-center"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <LoadingSwitch
              checked={computerUse.cloudBrowserEnabled}
              onCheckedChange={onDomEventFn((enabled) => {
                computerUse.onCloudBrowserChange(enabled);
              })}
              loading={false}
              ariaLabel={`${computerUse.cloudBrowserEnabled ? "Disable" : "Enable"} Cloud browser`}
              size="sm"
            />
          </span>
        </div>
      )}
      {computerUse.loading ? (
        <div className="flex flex-col animate-pulse">
          {Array.from({ length: 2 }, (_, i) => {
            return (
              <div key={i} className="flex items-center gap-2 px-2 py-2">
                <span className="h-4 w-4 shrink-0 rounded bg-muted/50" />
                <span className="h-3.5 w-24 rounded bg-muted/50 flex-1" />
                <span className="h-3 w-6 rounded-full bg-muted/50" />
              </div>
            );
          })}
        </div>
      ) : computerUse.hosts.length > 0 ? (
        <div
          className="flex max-h-[108px] flex-col overflow-y-auto"
          role="group"
          aria-label="Computer Use hosts"
        >
          {computerUse.hosts.map((host) => {
            const checked = computerUse.selectedHostId === host.id;
            return (
              <div
                key={host.id}
                onClick={() => {
                  computerUse.onChange(checked ? null : host.id);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 transition-colors",
                  checked
                    ? "bg-primary/5"
                    : "hover:bg-gray-100 dark:hover:bg-gray-200",
                )}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                  <IconDeviceDesktop size={16} stroke={1.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">
                    {host.displayName}
                  </span>
                  {host.status === "offline" && (
                    <span className="block text-[11px] leading-3 text-muted-foreground">
                      Offline
                    </span>
                  )}
                </span>
                <span
                  className="flex shrink-0 items-center"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                >
                  <LoadingSwitch
                    checked={checked}
                    onCheckedChange={onDomEventFn((nextChecked) => {
                      computerUse.onChange(nextChecked ? host.id : null);
                    })}
                    loading={false}
                    ariaLabel={`${checked ? "Disconnect" : "Connect"} ${host.displayName}`}
                    size="sm"
                  />
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
          <IconDeviceDesktop
            size={16}
            stroke={1.5}
            className="shrink-0 text-muted-foreground"
          />
          No online computers
        </div>
      )}
      <PopoverClose asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-foreground transition-colors hover:bg-gray-100 dark:hover:bg-gray-200"
          onClick={onOpenDownloadDialog}
        >
          <IconPlug
            size={16}
            stroke={1.5}
            className="shrink-0 text-muted-foreground"
          />
          Connect my computer
        </button>
      </PopoverClose>
    </div>
  );
}

function ComposerConnectorPermissionDialog({
  signals,
  agentId,
  agentDisplayName,
  connector,
  onClose,
}: {
  signals: ComposerConnectorSignals;
  agentId: string;
  agentDisplayName: string;
  connector: ComposerConnectorItem;
  onClose: () => void;
}) {
  const grantsLoadable = useLastLoadable(signals.permissionGrants$);
  const pageSignal = useGet(pageSignal$);
  const [, applyGrantPolicies] = useLoadableSet(applyUserPermissionGrants$);

  const grants =
    grantsLoadable.state === "hasData" ? grantsLoadable.data : undefined;

  if (grants === undefined) {
    return null;
  }

  const activeSnapshot = activeUserPermissionGrantSnapshot(grants);
  const initialPolicies = activeSnapshot.policies ?? {};

  return (
    <PermissionsDialog
      agentId={agentId}
      connectorSlug={connector.connectorRef}
      connectorLabel={connector.label}
      metadata$={signals.permissionMetadata$}
      displayName={agentDisplayName}
      initialPolicies={initialPolicies}
      initialGrants={activeSnapshot.grants}
      resetEnabled
      readOnly={false}
      onApply={async (intent, { metadata: appliedMetadata }) => {
        await savePermissionDraftPolicies({
          scope: { agentId },
          connectorSlug: connector.connectorRef,
          metadata: appliedMetadata,
          initialPolicies,
          initialGrants: activeSnapshot.grants,
          intent,
          pageSignal,
          applyGrantPolicies,
        });
        toast.success("Permissions updated");
      }}
      onClose={onClose}
    />
  );
}

function ConnectorsPopoverButton({
  signals,
  agentId,
  agentDisplayName,
  agentConnectors,
  connectorsLoading,
  savingConnectorSlug,
  computerUse,
  onOpenAddDialog,
  onToggle,
}: {
  signals: ComposerConnectorSignals;
  agentId: string | null;
  agentDisplayName: string;
  agentConnectors: ComposerConnectorItem[];
  connectorsLoading: boolean;
  savingConnectorSlug: ConnectorSlug | null;
  computerUse: ComposerComputerUse | undefined;
  onOpenAddDialog: () => void;
  onToggle: (
    connectorSlug: ConnectorSlug,
    checked: boolean,
  ) => void | Promise<void>;
}) {
  const search = useGet(signals.popoverSearch$);
  const setSearch = useSet(signals.setPopoverSearch$);
  const sortOrder = useGet(signals.popoverSortOrder$);
  const setSortOrder = useSet(signals.setPopoverSortOrder$);
  const downloadDialogOpen = useGet(signals.computerUseDownloadDialogOpen$);
  const setDownloadDialogOpen = useSet(
    signals.setComputerUseDownloadDialogOpen$,
  );
  const permissionEntryEnabled = useGet(composerConnectorPermissionsEnabled$);
  const permissionConnectorSlug = useGet(signals.permissionConnectorSlug$);
  const setPermissionConnectorSlug = useSet(
    signals.setPermissionConnectorSlug$,
  );
  const showSearch = agentConnectors.length > 20;
  const permissionConnector =
    permissionEntryEnabled && permissionConnectorSlug
      ? agentConnectors.find((c) => {
          return c.connectorRef === permissionConnectorSlug;
        })
      : undefined;

  // Use snapshot order if available, otherwise preserve catalog order.
  const sorted = sortOrder
    ? [...agentConnectors].sort((a, b) => {
        const ai = sortOrder.indexOf(a.connectorRef);
        const bi = sortOrder.indexOf(b.connectorRef);
        if (ai === -1 && bi === -1) {
          return 0;
        }
        if (ai === -1) {
          return 1;
        }
        if (bi === -1) {
          return -1;
        }
        return ai - bi;
      })
    : agentConnectors;

  const visibleConnectors =
    showSearch && search.trim()
      ? sorted.filter((c) => {
          return matchesConnectorSearch(search, c);
        })
      : sorted;

  const handleOpenChange = (open: boolean) => {
    if (open) {
      // Snapshot the sort order when popover opens
      const freshSort = agentConnectors.map((c) => {
        return c.connectorRef;
      });
      setSortOrder(freshSort);
    } else {
      setSortOrder(null);
      setSearch("");
    }
  };

  return (
    <Popover onOpenChange={handleOpenChange}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg px-1 transition-colors hover:bg-accent sm:h-9 sm:min-w-9 sm:px-1.5",
                  COMPOSER_CONTROL_FOCUS_CLASS,
                )}
                aria-label="Connectors"
              >
                <ConnectorTriggerIcons
                  connectors={agentConnectors}
                  hasComputerUse={Boolean(computerUse?.selectedHostId)}
                  hasCloudBrowser={Boolean(computerUse?.cloudBrowserEnabled)}
                />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            Connectors
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        side="top"
        align="start"
        className="flex max-h-[var(--radix-popover-content-available-height)] w-72 flex-col overflow-hidden rounded-lg p-0"
      >
        {(agentConnectors.length > 0 || connectorsLoading) && (
          <div className="flex min-h-0 flex-col py-1">
            {showSearch && (
              <div className="px-3 py-1 border-b border-border/50">
                <input
                  type="text"
                  placeholder="Find connectors..."
                  value={search}
                  onChange={(e) => {
                    return setSearch(e.target.value);
                  }}
                  className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                />
              </div>
            )}
            {connectorsLoading ? (
              <div className="flex flex-col animate-pulse">
                {Array.from({ length: 3 }, (_, i) => {
                  return (
                    <div key={i} className="flex items-center gap-2 px-3 py-2">
                      <span className="h-4 w-4 shrink-0 rounded bg-muted/50" />
                      <span className="h-3.5 w-20 rounded bg-muted/50 flex-1" />
                      <span className="h-3 w-6 rounded-full bg-muted/50" />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex max-h-64 min-h-0 flex-col overflow-y-auto">
                {visibleConnectors.map((item) => {
                  return (
                    <label
                      key={item.connectorRef}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <ConnectorIcon icon={item.icon} size={16} />
                      </span>
                      <span className="text-sm flex-1 truncate text-foreground">
                        {item.label}
                      </span>
                      {permissionEntryEnabled &&
                        agentId &&
                        item.authorized &&
                        item.permissionSummary.hasPermissions && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setPermissionConnectorSlug(item.connectorRef);
                            }}
                            aria-label={`Configure ${item.label} permissions`}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <IconAdjustmentsHorizontal size={15} stroke={1.5} />
                          </button>
                        )}
                      <LoadingSwitch
                        checked={item.authorized}
                        onCheckedChange={onDomEventFn(async (checked) => {
                          await onToggle(item.connectorRef, checked);
                        })}
                        loading={savingConnectorSlug === item.connectorRef}
                        ariaLabel={`${item.authorized ? "Remove" : "Add"} ${item.label}`}
                        size="sm"
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div className="flex shrink-0 flex-col p-1">
          {(agentConnectors.length > 0 || connectorsLoading) && (
            <div className="mx-2 mb-1 border-t border-border/50" />
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => {
              return onOpenAddDialog();
            }}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
              <IconPlus size={13} stroke={1.5} />
            </span>
            Add connectors
          </button>
        </div>
        {computerUse && (
          <ComputerUseConnectorMenuSection
            computerUse={computerUse}
            onOpenDownloadDialog={() => {
              setDownloadDialogOpen(true);
            }}
          />
        )}
      </PopoverContent>
      {computerUse && (
        <ComputerUseDownloadDialog
          open={downloadDialogOpen}
          onOpenChange={setDownloadDialogOpen}
          downloadUrl={computerUse.downloadUrl}
        />
      )}
      {agentId && permissionConnector && (
        <ComposerConnectorPermissionDialog
          signals={signals}
          agentId={agentId}
          agentDisplayName={agentDisplayName}
          connector={permissionConnector}
          onClose={() => {
            setPermissionConnectorSlug(null);
          }}
        />
      )}
    </Popover>
  );
}

function ComputerUseDownloadDialog({
  open,
  onOpenChange,
  downloadUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  downloadUrl: string;
}) {
  const downloadSupportLoadable = useLoadable(
    zeroDesktopDownloadSupportStatus$,
  );
  const downloadSupportStatus =
    downloadSupportLoadable.state === "hasData"
      ? downloadSupportLoadable.data
      : "checking";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <div className="flex h-44 items-center justify-center border-b border-border bg-gray-50">
          <img
            src={computerUseIllustrationImg}
            alt=""
            className="h-40 w-40 object-contain"
          />
        </div>
        <DialogHeader className="space-y-2 px-6 pt-5 text-left">
          <DialogTitle className="text-xl leading-7">
            Let Zero use your computer
          </DialogTitle>
          <DialogDescription className="leading-6">
            So Zero can work in your browser and apps for you, even ones with no
            connector like LinkedIn or Reddit.
          </DialogDescription>
          <p className="text-sm leading-5 text-muted-foreground">
            {ZERO_DESKTOP_MACOS_REQUIREMENT_LABEL}
          </p>
        </DialogHeader>
        <div className="px-6 pb-6 pt-4">
          {downloadSupportStatus === "unsupported-intel-mac" ? (
            <Button type="button" size="lg" className="w-full" disabled>
              <IconAlertTriangle size={16} stroke={1.5} />
              {ZERO_DESKTOP_UNSUPPORTED_INTEL_MAC_LABEL}
            </Button>
          ) : downloadSupportStatus === "checking" ? (
            <Button type="button" size="lg" className="w-full" disabled>
              Checking compatibility
            </Button>
          ) : (
            <Button asChild size="lg" className="w-full">
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                <IconDownload size={16} stroke={1.5} />
                Download for macOS
              </a>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Voice input mic button
// ---------------------------------------------------------------------------

interface MicButtonStatus {
  readonly recording: boolean;
  readonly starting: boolean;
  readonly transcribing: boolean;
  readonly quotaLoading: boolean;
}

function micButtonAriaLabel(status: MicButtonStatus): string {
  if (status.recording) {
    return "Stop recording";
  }
  if (status.starting) {
    return "Starting voice input";
  }
  if (status.transcribing) {
    return "Transcribing";
  }
  if (status.quotaLoading) {
    return "Checking voice input limit";
  }
  return "Voice input";
}

function micButtonTooltip(status: MicButtonStatus): string {
  if (status.recording) {
    return "Stop recording";
  }
  if (status.starting) {
    return "Opening microphone...";
  }
  if (status.transcribing) {
    return "Transcribing...";
  }
  if (status.quotaLoading) {
    return "Checking voice input limit";
  }
  return "Voice input";
}

function MicButton({
  onTranscribed,
}: {
  onTranscribed: (text: string) => void;
}) {
  const available = useLastResolved(audioInputAvailable$) ?? false;
  const quotaState = useLoadableState(audioInputQuota$);
  const quota = useLastResolved(audioInputQuota$) ?? null;
  const quotaResolved = quota !== null;
  const recording = useGet(sttRecording$);
  const starting = useGet(sttStarting$);
  const transcribing = useGet(sttTranscribing$);
  const voiceLevel = useGet(sttVoiceLevel$);
  const voiceLevelFill = `${Math.round((voiceLevel / 3) * 100)}%`;
  const startRec = useSet(startRecording$);
  const stopAndTranscribe = useSet(stopAndTranscribe$);
  const openQuotaRecovery = useSet(openAudioInputQuotaRecovery$);
  const signal = useGet(pageSignal$);
  const disabled = starting || transcribing || (!recording && !quotaResolved);
  const status = {
    recording,
    starting,
    transcribing,
    quotaLoading: quotaState === "loading" && !quotaResolved,
  };

  if (!available) {
    return null;
  }

  const handleClick = () => {
    if (starting || transcribing) {
      return;
    }
    if (recording) {
      detach(
        (async () => {
          const text = await stopAndTranscribe(signal);
          if (text) {
            onTranscribed(text);
          }
        })(),
        Reason.DomCallback,
      );
      return;
    }
    if (!quota) {
      return;
    }
    if (!quota.allowed) {
      detach(openQuotaRecovery(signal), Reason.DomCallback);
      return;
    }
    detach(
      startRec(onTranscribed, quota.limit === null, signal),
      Reason.DomCallback,
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
              COMPOSER_CONTROL_FOCUS_CLASS,
              recording || starting || transcribing
                ? "bg-[#2E9E9F] text-white hover:bg-[#279394]"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={handleClick}
            disabled={disabled}
            aria-label={micButtonAriaLabel(status)}
          >
            {starting || transcribing ? (
              <span className="mic-starting-spinner" aria-hidden="true" />
            ) : recording ? (
              <>
                <span
                  className="mic-volume-icon-meter"
                  aria-hidden="true"
                  style={
                    {
                      "--mic-volume-fill": voiceLevelFill,
                    } as CSSProperties
                  }
                />
                <IconMicrophone size={17} stroke={1.8} className="relative" />
              </>
            ) : (
              <IconMicrophone size={18} stroke={1.5} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {micButtonTooltip(status)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComposerAttachButton({
  onSelectFile,
}: {
  readonly onSelectFile: () => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "rounded-lg p-2 transition-colors duration-200 hover:bg-accent hover:text-foreground sm:p-[9px]",
              COMPOSER_CONTROL_FOCUS_CLASS,
            )}
            aria-label="Attach"
            onClick={onSelectFile}
          >
            <IconPaperclip size={18} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          Attach
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComposerUploadMenu({
  onDraftChange,
  onAppendText,
  onSelectFile,
}: {
  readonly onDraftChange?: () => void;
  readonly onAppendText: (value: string) => void;
  readonly onSelectFile: () => void;
}) {
  const uploadOpen = useGet(uploadPopoverOpen$);
  const setUploadOpen = useSet(setUploadPopoverOpen$);
  const addLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const trimmed = String(data.get("uploadLink") ?? "").trim();
    if (!URL.canParse(trimmed)) {
      toast.error("Enter a valid link");
      return;
    }
    const normalized = new URL(trimmed).toString();
    onAppendText(normalized);
    onDraftChange?.();
    form.reset();
    setUploadOpen(false);
  };

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        className={cn(
          "rounded-lg p-2 transition-colors duration-200 hover:bg-accent hover:text-foreground sm:p-[9px]",
          COMPOSER_CONTROL_FOCUS_CLASS,
          uploadOpen && "bg-accent text-foreground",
        )}
        aria-label="Upload"
        aria-expanded={uploadOpen}
        aria-haspopup="dialog"
        title="Upload"
        data-testid="composer-upload"
        onClick={() => {
          setUploadOpen(!uploadOpen);
        }}
      >
        <IconUpload size={18} stroke={1.5} />
      </button>
      {uploadOpen && (
        <div
          role="dialog"
          aria-label="Upload"
          className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-lg border-[0.7px] border-[hsl(var(--gray-400))] bg-card p-2 text-foreground shadow-lg"
        >
          <button
            type="button"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent"
            data-testid="composer-upload-local"
            onClick={() => {
              setUploadOpen(false);
              onSelectFile();
            }}
          >
            <IconPaperclip size={16} stroke={1.6} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">
                Upload from computer
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                Images, docs, audio, video and archives
              </span>
            </span>
          </button>
          <form
            className="mt-2 rounded-lg border border-border/70 p-3"
            onSubmit={addLink}
          >
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <IconLink size={15} stroke={1.7} />
              Upload from link
            </div>
            <Input
              className="mt-2 h-9 text-sm"
              name="uploadLink"
              placeholder="https://example.com/image.png"
              type="url"
              data-testid="composer-upload-link-input"
            />
            <Button
              type="submit"
              size="sm"
              className="mt-2 h-8 w-full rounded-lg text-xs font-medium"
              data-testid="composer-upload-link-add"
            >
              Add link
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

function ComposerUploadControl({
  onDraftChange,
  onAppendText,
  onSelectFile,
}: {
  readonly onDraftChange?: () => void;
  readonly onAppendText: (value: string) => void;
  readonly onSelectFile: () => void;
}) {
  const uploadPopoverEnabled = useGet(composerUploadPopoverEnabled$);
  return uploadPopoverEnabled ? (
    <ComposerUploadMenu
      onDraftChange={onDraftChange}
      onAppendText={onAppendText}
      onSelectFile={onSelectFile}
    />
  ) : (
    <ComposerAttachButton onSelectFile={onSelectFile} />
  );
}

// ---------------------------------------------------------------------------
// Signal resolution — resolves draft/file-input with singleton fallback
// ---------------------------------------------------------------------------

function useResolvedComposerSignals(
  draft: DraftSignals,
  composerFileInputProp$: Computed<HTMLElement | null> | undefined,
  setComposerFileInputProp$:
    | Command<(() => void) | undefined, [HTMLElement | null]>
    | undefined,
) {
  const attachments = useGet(draft.attachments$);
  const attachmentUploadsState = useLoadableState(
    draft.attachmentUploadsReady$,
  );
  const readInput = useSet(draft.readInput$);
  const uploadAttachment = useSet(draft.uploadAttachment$);
  const restoreAttachments = useSet(draft.restoreAttachments$);
  const removeAttachment = useSet(draft.removeAttachment$);
  const fileInputEl = useGet(
    composerFileInputProp$ ?? singletonComposerFileInput$,
  );
  const setFileInputEl = useSet(
    setComposerFileInputProp$ ?? singletonSetComposerFileInput$,
  );
  const dragOver = useGet(draft.dragOver$);
  const setDragOver = useSet(draft.setDragOver$);

  return {
    readInput,
    attachments,
    attachmentUploadsState,
    uploadAttachment,
    restoreAttachments,
    removeAttachment,
    fileInputEl,
    setFileInputEl,
    dragOver,
    setDragOver,
  };
}

function toPersistedAttachments(
  attachments: readonly {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[],
): PersistedAttachment[] {
  return attachments
    .filter((attachment): attachment is PersistedAttachment => {
      return attachment.id !== null;
    })
    .map((attachment) => {
      return {
        id: attachment.id,
        url: attachment.url,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
      };
    });
}

function restoreChatClipboardPayload({
  event,
  inlineTemplatesEnabled,
  visualAttachmentUnsupported,
  insertPromptMarkdown,
  insertUserMessage,
  restoreAttachments,
  onTemplateChange,
  onDraftChange,
}: {
  event: ComposerPasteEvent;
  inlineTemplatesEnabled: boolean;
  visualAttachmentUnsupported: VisualAttachmentUnsupportedState | null;
  insertPromptMarkdown: (value: string) => void;
  insertUserMessage: (value: UserMessageDocument) => void;
  restoreAttachments: (attachments: PersistedAttachment[]) => void;
  onTemplateChange:
    | ((value: GenerationTemplateRequest | undefined) => void)
    | undefined;
  onDraftChange: (() => void) | undefined;
}): boolean {
  if (!event.clipboardData) {
    return false;
  }
  const payload = readChatMessageFromClipboard(event.clipboardData);
  if (!payload) {
    return false;
  }
  const userMessage = shouldUseUserMessage(payload.userMessage)
    ? payload.userMessage
    : undefined;
  const persistedAttachments = toPersistedAttachments(payload.attachments);
  if (!userMessage && persistedAttachments.length === 0) {
    return false;
  }
  const allowedAttachments = visualAttachmentUnsupported
    ? persistedAttachments.filter((attachment) => {
        return !isVisualAttachment({
          contentType: attachment.contentType,
          filename: attachment.filename,
        });
      })
    : persistedAttachments;
  if (
    visualAttachmentUnsupported &&
    allowedAttachments.length < persistedAttachments.length
  ) {
    showVisualAttachmentUnsupportedToast(visualAttachmentUnsupported);
  }

  event.preventDefault();
  const hasInsertableUserMessagePart = userMessage?.parts.some((part) => {
    return (
      part.type === "text" ||
      part.type === "chat_thread" ||
      part.type === "feedback" ||
      (inlineTemplatesEnabled && part.type === "template")
    );
  });
  if (userMessage && hasInsertableUserMessagePart) {
    insertUserMessage(userMessage);
  } else if (payload.text) {
    insertPromptMarkdown(payload.text);
  }
  const templatePart = userMessage?.parts.find((part) => {
    return part.type === "template";
  });
  if (!inlineTemplatesEnabled && templatePart?.type === "template") {
    onTemplateChange?.(templatePart.template);
  }
  if (allowedAttachments.length > 0) {
    restoreAttachments(allowedAttachments);
  }
  onDraftChange?.();
  return true;
}

type KeyboardSendAction = "none" | "send" | "queue";

function ComposerInputSlot({
  composer,
  onDraftChange,
  sending,
  autoFocus,
  enableMobileSingleLine,
  onKeyDown,
  onPaste,
}: {
  readonly composer: WorkflowComposerSignals;
  readonly onDraftChange: (() => void) | undefined;
  readonly sending: boolean | undefined;
  readonly autoFocus: boolean | undefined;
  readonly enableMobileSingleLine: boolean;
  readonly onKeyDown: (e: KeyboardEventLike) => void;
  readonly onPaste: (e: ComposerPasteEvent) => void;
}) {
  const singleLineOnMobile = enableMobileSingleLine;

  return (
    <TiptapWorkflowComposer
      composer={composer}
      onDraftChange={onDraftChange}
      sending={sending}
      autoFocus={autoFocus}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      singleLineOnMobile={singleLineOnMobile}
    />
  );
}

function resolveKeyboardSendAction({
  canSend,
  sending,
  queueWhileSending,
  hasQueueHandler,
}: {
  canSend: boolean;
  sending: boolean | undefined;
  queueWhileSending: boolean;
  hasQueueHandler: boolean;
}): KeyboardSendAction {
  if (!canSend || (sending && (!queueWhileSending || !hasQueueHandler))) {
    return "none";
  }
  return sending ? "queue" : "send";
}

// Stop while an empty composer is mid-run; otherwise Send.
function ComposerSendButton({
  showStopButton,
  onCancel,
  sendAction,
  onSend,
}: {
  showStopButton: boolean;
  onCancel: (() => void) | undefined;
  sendAction: KeyboardSendAction;
  onSend: () => void;
}) {
  if (showStopButton) {
    return (
      <Button
        size="sm"
        variant="destructive"
        className="rounded-lg h-9 w-9 p-0 shrink-0"
        onClick={onCancel}
        aria-label="Stop"
      >
        <IconPlayerStop size={16} />
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      className="rounded-lg h-9 w-9 p-0 shrink-0"
      onClick={onSend}
      disabled={sendAction === "none"}
      aria-label="Send"
    >
      <IconArrowUp size={18} stroke={2} />
    </Button>
  );
}

function ComposerSendControl({
  draft,
  visibleAttachmentCount,
  uploadsReady,
  submitBlocked,
  sending,
  queueWhileSending,
  hasQueueHandler,
  onCancel,
  actionsLoading,
  submissionLoading,
  onSend,
}: {
  draft: DraftSignals;
  visibleAttachmentCount: number;
  uploadsReady: boolean;
  submitBlocked: boolean;
  sending: boolean | undefined;
  queueWhileSending: boolean;
  hasQueueHandler: boolean;
  onCancel: (() => void) | undefined;
  actionsLoading: boolean;
  submissionLoading: boolean;
  onSend: () => void;
}) {
  const hasInput = useGet(draft.hasInput$);
  const canSend = resolveComposerCanSend({
    hasInput,
    visibleAttachmentCount,
    uploadsReady,
  });
  const sendAction = resolveKeyboardSendAction({
    canSend: canSend && !submitBlocked && !submissionLoading,
    sending,
    queueWhileSending,
    hasQueueHandler,
  });
  const state = resolveSendButtonStateForActionsLoading({
    actionsLoading,
    showStopButton: Boolean(sending && onCancel) && !canSend,
    onCancel,
    sendAction,
  });
  return <ComposerSendButton {...state} onSend={onSend} />;
}

function resolveSendButtonStateForActionsLoading({
  actionsLoading,
  showStopButton,
  onCancel,
  sendAction,
}: {
  actionsLoading: boolean;
  showStopButton: boolean;
  onCancel: (() => void) | undefined;
  sendAction: KeyboardSendAction;
}): {
  showStopButton: boolean;
  onCancel: (() => void) | undefined;
  sendAction: KeyboardSendAction;
} {
  if (actionsLoading) {
    return {
      showStopButton: false,
      onCancel: undefined,
      sendAction: "none",
    };
  }
  return {
    showStopButton,
    onCancel,
    sendAction,
  };
}

function ModelConfigurationWarning({
  blocker,
}: {
  blocker: NonNullable<ZeroChatComposerProps["submitBlocker"]>;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={blocker.onAction}
            aria-label={`${blocker.actionLabel}: ${blocker.message}`}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300"
          >
            <IconAlertTriangle size={15} stroke={1.75} />
            <span className="hidden sm:inline">{blocker.actionLabel}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
          {blocker.message}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ComposerModelPickerSlot({
  modelPicker,
  modelPickerLoading,
  submitBlocker,
  onModelPickerChange,
}: {
  modelPicker: ComposerModelPicker | undefined;
  modelPickerLoading: boolean;
  submitBlocker: ZeroChatComposerProps["submitBlocker"];
  onModelPickerChange: (value: ModelProviderSelection | null) => void;
}) {
  const codexFastModeEnabled = useGet(codexFastModeEnabled$);
  const modelPickerOpen = useGet(modelPickerOpen$);
  const setModelPickerOpen = useSet(setModelPickerOpen$);
  if (modelPickerLoading) {
    return null;
  }
  const shouldRenderModelPicker =
    modelPicker !== undefined && modelPicker.value !== null;

  return (
    <>
      {submitBlocker && <ModelConfigurationWarning blocker={submitBlocker} />}
      {shouldRenderModelPicker && (
        <ModelProviderPicker
          value={modelPicker.value}
          onChange={onModelPickerChange}
          placeholder="Select model"
          triggerClassName={cn(
            "h-9 w-9 max-w-none gap-0 border-transparent bg-transparent px-0 text-sm text-muted-foreground transition-colors sm:w-auto sm:max-w-[14rem] sm:gap-1 sm:px-2",
            "[&>span]:flex [&>span]:items-center [&>span]:justify-center sm:[&>span]:justify-start [&>svg]:hidden sm:[&>svg]:block",
            "hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
            COMPOSER_CONTROL_FOCUS_CLASS,
          )}
          compactTrigger
          mobileIconTrigger
          codexFastModeEnabled={codexFastModeEnabled}
          open={modelPickerOpen}
          onOpenChange={setModelPickerOpen}
          disabled={modelPicker.disabled}
          resolveDefaultSelection={false}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

function loadableDataOrNull<T>(loadable: Loadable<T>): T | null {
  return loadable.state === "hasData" ? loadable.data : null;
}

function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

function equalAgentConnectorAuthorizations(
  left: AgentConnectorAuthorizations | null,
  right: AgentConnectorAuthorizations | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.agentId === right.agentId &&
    equalArrays(left.enabledConnectorSlugs, right.enabledConnectorSlugs)
  );
}

export function useComposerConnectorReadState(
  composerConnectors: ComposerConnectorSignals,
): ComposerConnectorReadState {
  return {
    catalogItems: useLastLoadable(allConnectorCatalogItems$),
    agentId: useLoadable(composerConnectors.agentId$),
    authorizations: useLastLoadable(composerConnectors.authorizations$, {
      equalityFn: equalAgentConnectorAuthorizations,
    }),
  };
}

function matchingAuthorizedConnectorSlugs(
  agentId: Loadable<string | null>,
  authorizations: Loadable<AgentConnectorAuthorizations | null>,
): readonly ConnectorSlug[] | null {
  if (agentId.state !== "hasData" || authorizations.state !== "hasData") {
    return null;
  }
  if (agentId.data === null) {
    return authorizations.data === null ? [] : null;
  }
  if (authorizations.data?.agentId !== agentId.data) {
    return null;
  }
  return authorizations.data.enabledConnectorSlugs;
}

// The thread route invokes this hook from its ccstate-connected composer so
// dynamic bindings do not cross another React component boundary. The agent
// landing page uses the component wrapper below for its separate signal scope.
export function useZeroChatComposer(
  {
    composer,
    composerConnectors,
    onSend,
    onQueue,
    sending,
    queueWhileSending = false,
    submissionLoading = false,
    onCancel,
    displayName,
    className,
    autoFocus,
    enableMobileSingleLine = false,
    draft,
    composerFileInput$: composerFileInputProp$,
    setComposerFileInput$: setComposerFileInputProp$,
    chatThreadId,
    onDraftChange,
    actionsLoading = false,
    modelPicker,
    templatePicker,
    onCreateWorkflowPrompt,
    computerUse,
    modelPickerLoading = false,
    submitBlocker,
    queuedItems,
    onRemoveQueuedItem,
    workflowEventItems,
    onRemoveWorkflowEvent,
    workflowEventsPaused = false,
    workflowEventsPauseReason,
    onSetWorkflowEventsPaused,
    onClearWorkflowEvents,
    activeGoal,
    onCancelActiveGoal,
  }: ZeroChatComposerProps,
  connectorReadState: ComposerConnectorReadState,
) {
  const showAddDialog = useGet(composerConnectors.showAddDialog$);
  const setShowAddDialog = useSet(composerConnectors.setShowAddDialog$);
  const openGoalDialog = useSet(openChatThreadGoalDialog$);
  const featureSwitches = useGet(featureSwitch$);
  const inlineTemplatesEnabled =
    userMessageInlineTemplatesEnabled(featureSwitches);

  const resolved = useResolvedComposerSignals(
    draft,
    composerFileInputProp$,
    setComposerFileInputProp$,
  );
  const {
    readInput,
    attachments,
    attachmentUploadsState,
    uploadAttachment,
    restoreAttachments,
    removeAttachment,
    fileInputEl,
    setFileInputEl,
    dragOver,
    setDragOver,
  } = resolved;
  const insertPromptMarkdown = useSet(composer.insertPromptMarkdown$);
  const insertUserMessage = useSet(composer.insertUserMessage$);
  const insertTemplate = useSet(composer.insertTemplate$);
  const appendComposerText = useSet(composer.appendText$);
  const [inputForSubmissionLoadable, readInputForSubmission] = useLoadableSet(
    composer.readInputForSubmission$,
  );

  const ensurePushSubscription = useSet(ensurePushSubscription$);
  const rootSignal = useGet(rootSignal$);
  const visualAttachmentUnsupported =
    getVisualAttachmentUnsupportedState(modelPicker);
  const visibleAttachments = resolveVisibleAttachments(
    attachments,
    visualAttachmentUnsupported,
  );
  const uploadsReady = attachmentUploadsState === "hasData";
  const composerTemplatePicker = inlineComposerTemplatePicker({
    picker: templatePicker,
    enabled: inlineTemplatesEnabled,
    insertTemplate,
    onDraftChange,
  });

  // File upload handlers (paste / drag-drop)
  const handlePaste = (e: ComposerPasteEvent) => {
    if (!e.clipboardData) {
      return;
    }
    if (
      restoreChatClipboardPayload({
        event: e,
        inlineTemplatesEnabled,
        visualAttachmentUnsupported,
        insertPromptMarkdown,
        insertUserMessage,
        restoreAttachments,
        onTemplateChange: composerTemplatePicker?.onChange,
        onDraftChange,
      })
    ) {
      return;
    }

    const items = e.clipboardData?.items;
    if (!items) {
      return;
    }
    const plainText = e.clipboardData.getData("text/plain");
    let pastedPlainText = false;
    const applyPlainText = () => {
      if (pastedPlainText || !plainText) {
        return;
      }
      insertPromptMarkdown(plainText);
      pastedPlainText = true;
    };
    for (const item of items) {
      if (item.kind !== "file") {
        continue;
      }
      const file = item.getAsFile();
      if (!file) {
        continue;
      }
      if (visualAttachmentUnsupported && isVisualAttachmentFile(file)) {
        e.preventDefault();
        applyPlainText();
        showVisualAttachmentUnsupportedToast(visualAttachmentUnsupported);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        e.preventDefault();
        toast.error(`${file.name} exceeds the 1 GB limit`);
        continue;
      }
      e.preventDefault();
      applyPlainText();
      detach(uploadAttachment(file, rootSignal), Reason.DomCallback);
      onDraftChange?.();
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files) {
      return;
    }
    let uploaded = false;
    for (const file of files) {
      if (visualAttachmentUnsupported && isVisualAttachmentFile(file)) {
        showVisualAttachmentUnsupportedToast(visualAttachmentUnsupported);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        e.preventDefault();
        toast.error(`${file.name} exceeds the 1 GB limit`);
        continue;
      }
      detach(uploadAttachment(file, rootSignal), Reason.DomCallback);
      uploaded = true;
    }
    if (uploaded) {
      onDraftChange?.();
    }
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  };

  // Connectors: connected (org-level) + authorized (agent-level) → available
  const connectorCatalogItemsLoadable = connectorReadState.catalogItems;
  const agentIdLoadable = connectorReadState.agentId;
  const authorizationsLoadable = connectorReadState.authorizations;
  const pageSignal = useGet(pageSignal$);
  const selectedConnectorSlug = useGet(
    composerConnectors.selectedConnectorSlug$,
  );
  const pendingConnectorSlug = useGet(composerConnectors.pendingConnectorSlug$);
  const setPendingConnectorSlug = useSet(
    composerConnectors.setPendingConnectorSlug$,
  );
  const setSelectedConnectorSlug = useSet(
    composerConnectors.setSelectedConnectorSlug$,
  );
  const pollingAuthCodeSlug = useGet(pollingOAuthAuthCodeConnectorSlug$);
  const pollingDeviceAuthSlug = useGet(pollingOAuthDeviceAuthConnectorSlug$);
  const connectFlowSlug = useGet(connectFlowConnectorSlug$);
  const busyConnectorSlug =
    connectFlowSlug ?? pollingAuthCodeSlug ?? pollingDeviceAuthSlug;
  const connectBrowserAuth = useSet(connectConnectorOAuthAuthCode$);
  const connectNoAuth = useSet(connectConnectorNoAuth$);
  const authorizeFn = useSet(composerConnectors.authorizeConnector$);
  const deauthorizeFn = useSet(composerConnectors.deauthorizeConnector$);
  const optimisticConnected = useGet(justConnectedSlugs$);

  const savingConnectorSlug = useGet(composerConnectors.savingConnectorSlug$);
  const setSavingConnectorSlug = useSet(
    composerConnectors.setSavingConnectorSlug$,
  );
  const agentRecordId = loadableDataOrNull(agentIdLoadable);

  const authorizedConnectors = matchingAuthorizedConnectorSlugs(
    agentIdLoadable,
    authorizationsLoadable,
  );

  const connectorsLoading =
    connectorCatalogItemsLoadable.state !== "hasData" ||
    authorizedConnectors === null;

  const connectorCatalogItems =
    connectorCatalogItemsLoadable.state === "hasData"
      ? connectorCatalogItemsLoadable.data
      : [];
  const connectorMap = new Map(
    connectorCatalogItems.map((connector) => {
      return [connector.connectorRef, connector];
    }),
  );
  const authorizedSet = new Set(authorizedConnectors ?? []);

  const unconnectedConnectors = connectorCatalogItems.filter((connector) => {
    return (
      !connector.connected && !optimisticConnected.has(connector.connectorRef)
    );
  });

  // Show all org-connected services so user can toggle authorization on/off per agent.
  const connectedCatalogItems = connectorCatalogItems.filter((connector) => {
    return (
      connector.connected || optimisticConnected.has(connector.connectorRef)
    );
  });
  const agentConnectors: ComposerConnectorItem[] = connectedCatalogItems.map(
    (connector) => {
      const authorized = authorizedSet.has(connector.connectorRef);
      return { ...connector, authorized };
    },
  );

  const handleConnectSuccess = async (connectorSlug: ConnectorSlug) => {
    const label = connectorMap.get(connectorSlug)?.label ?? connectorSlug;
    const authorized = await tapError(
      (async () => {
        await authorizeFn(connectorSlug, pageSignal);
        return true;
      })(),
      () => {
        toast.error(
          `${label} connected but could not be authorized for ${displayName}`,
          {
            id: `connector-save-error-${connectorSlug}`,
          },
        );
      },
    );
    if (authorized !== true) {
      return false;
    }
    toast.success(`${label} connected and authorized for ${displayName}`, {
      id: `connector-connected-${connectorSlug}`,
    });
    return true;
  };

  const completeConnectorAddition = async (
    connectorSlug: ConnectorSlug,
  ): Promise<void> => {
    if (!authorizedSet.has(connectorSlug)) {
      const authorized = await handleConnectSuccess(connectorSlug);
      if (!authorized) {
        setPendingConnectorSlug(null);
        return;
      }
    }
    setPendingConnectorSlug(null);
    setShowAddDialog(false);
  };

  const connectorConnectHandlers = (
    connector: PublicConnectorCatalogStatusItem,
  ): ConnectorConnectHandlers => {
    const connectorSlug = connector.connectorRef;
    return {
      openModal: () => {
        setPendingConnectorSlug(connectorSlug);
        setSelectedConnectorSlug(connectorSlug);
      },
      connectBrowserAuth: async (authMethod) => {
        setPendingConnectorSlug(connectorSlug);
        const connected = await connectBrowserAuth(
          connectorSlug,
          authMethod,
          {
            connectorLabel: connector.label,
            connectorIcon: connector.icon,
            agentId: nullToUndefined(agentRecordId),
          },
          pageSignal,
        );
        if (connected) {
          await completeConnectorAddition(connectorSlug);
        } else {
          setPendingConnectorSlug(null);
        }
        return connected;
      },
      connectNoAuth: async (authMethod) => {
        setPendingConnectorSlug(connectorSlug);
        const connected = await connectNoAuth(
          {
            connectorSlug,
            authMethod,
            options: {
              connectorLabel: connector.label,
              agentId: nullToUndefined(agentRecordId),
            },
          },
          pageSignal,
        );
        if (connected) {
          await completeConnectorAddition(connectorSlug);
        } else {
          setPendingConnectorSlug(null);
        }
        return connected;
      },
    };
  };

  const handleToggle = async (
    connectorSlug: ConnectorSlug,
    checked: boolean,
  ) => {
    setSavingConnectorSlug(connectorSlug);
    await bestEffort(
      checked
        ? authorizeFn(connectorSlug, pageSignal)
        : deauthorizeFn(connectorSlug, pageSignal),
    );
    setSavingConnectorSlug(null);
  };

  const handleSend = () => {
    const input = readInput();
    const sendAction = resolveKeyboardSendAction({
      canSend:
        !actionsLoading &&
        !submissionLoading &&
        inputForSubmissionLoadable.state !== "loading" &&
        uploadsReady &&
        (input.trim().length > 0 || visibleAttachments.length > 0) &&
        !submitBlocker,
      sending,
      queueWhileSending,
      hasQueueHandler: onQueue !== undefined,
    });
    if (sendAction === "none") {
      return;
    }
    if (sendAction === "send") {
      // Fire-and-forget: request push permission on first send, never blocks
      detach(ensurePushSubscription(rootSignal), Reason.DomCallback);
    }
    const submitCurrentInput = async () => {
      const submission = await readInputForSubmission(pageSignal);
      const prompt = submission.prompt.trim();
      if (prompt.length === 0 && visibleAttachments.length === 0) {
        return;
      }
      if (sendAction === "send") {
        onSend(
          prompt,
          composerTemplatePicker?.value,
          submission.editorDocument,
        );
      } else {
        onQueue?.(
          prompt,
          composerTemplatePicker?.value,
          submission.editorDocument,
        );
      }
    };
    detach(submitCurrentInput(), Reason.DomCallback);
  };

  // Routes a button click to the queue path while the current thread is sending,
  // otherwise to the normal send path.
  const handleButtonSend = () => {
    handleSend();
  };

  const sendModeLoadable = useLastLoadable(sendMode$);
  const sendMode =
    sendModeLoadable.state === "hasData" ? sendModeLoadable.data : "enter";

  const handleKeyDown = (e: KeyboardEventLike) => {
    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
    const isTouchOnlyDevice =
      isTouchDevice && !window.matchMedia("(any-pointer: fine)").matches;
    const send = () => {
      handleSend();
    };
    if (isTouchOnlyDevice) {
      processShortcut({ "mod+enter": send }, e);
      return;
    }
    processShortcut(
      {
        ...(sendMode === "enter" ? { enter: send } : { "mod+enter": send }),
        ...(isTouchDevice && sendMode === "enter" ? { "mod+enter": send } : {}),
        escape: () => {
          (e.target as HTMLElement).blur();
        },
      },
      e,
    );
  };

  const handleFileSelect = () => {
    fileInputEl?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) {
      return;
    }
    let uploaded = false;
    for (const file of files) {
      if (visualAttachmentUnsupported && isVisualAttachmentFile(file)) {
        showVisualAttachmentUnsupportedToast(visualAttachmentUnsupported);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        e.preventDefault();
        toast.error(`${file.name} exceeds the 1 GB limit`);
        continue;
      }
      detach(uploadAttachment(file, rootSignal), Reason.DomCallback);
      uploaded = true;
    }
    if (uploaded) {
      onDraftChange?.();
    }
    e.target.value = "";
  };

  const handleModelPickerChange = (
    selection: ModelProviderSelection | null,
  ) => {
    const nextUnsupported = getVisualAttachmentUnsupportedState(
      modelPicker,
      selection,
    );
    if (
      nextUnsupported &&
      attachments.some((attachment) => {
        return isVisualAttachment(attachment);
      })
    ) {
      showVisualAttachmentUnsupportedToast(nextUnsupported);
    }
    modelPicker?.onChange(selection);
  };

  return (
    <>
      <input
        ref={setFileInputEl}
        type="file"
        className="hidden"
        accept="image/*,audio/*,video/mp4,video/webm,video/quicktime,.pdf,.txt,.csv,.tsv,.md,.json,.xml,.yaml,.yml,.html,.htm,.doc,.docx,.docm,.dotx,.dotm,.odt,.rtf,.xls,.xlsx,.xlsm,.xlsb,.xltx,.xltm,.ods,.ppt,.pptx,.pptm,.potx,.potm,.ppsx,.ppsm,.odp,.zip,.rar,.7z,.tar,.tar.gz,.tgz,.gz,.bz2,.xz,.pages,.numbers,.key,.heic,.heif,.tif,.tiff,.bmp,.parquet,.sqlite,.sqlite3,.db,.epub,.psd,.ai"
        multiple
        onChange={handleFileChange}
      />
      <div className={cn("relative flex flex-col", className)}>
        <PendingItemsStrip
          items={queuedItems}
          onRemove={onRemoveQueuedItem}
          workflowEvents={workflowEventItems}
          onRemoveWorkflowEvent={onRemoveWorkflowEvent}
          workflowEventsPaused={workflowEventsPaused}
          workflowEventsPauseReason={workflowEventsPauseReason}
          onSetWorkflowEventsPaused={onSetWorkflowEventsPaused}
          onClearWorkflowEvents={onClearWorkflowEvents}
          activeGoal={activeGoal}
          onCancelGoal={onCancelActiveGoal}
          onOpenGoal={
            chatThreadId
              ? () => {
                  openGoalDialog(chatThreadId);
                }
              : undefined
          }
        />
        <Card
          className={cn(
            "zero-composer relative z-10 overflow-visible",
            dragOver && "outline outline-2 outline-blue-400/60",
          )}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <CardContent className="p-0">
            <div className="flex flex-col">
              <ComposerTemplateAttachmentSync
                composer={composer}
                picker={composerTemplatePicker}
                onDraftChange={onDraftChange}
                runtime={composer.templatePreview}
              />
              {visibleAttachments.length > 0 && (
                <AttachmentChips
                  attachments={visibleAttachments}
                  onRemove={(attachment) => {
                    removeAttachment(attachment);
                    onDraftChange?.();
                  }}
                />
              )}
              <ComposerInputSlot
                composer={composer}
                onDraftChange={onDraftChange}
                sending={sending}
                autoFocus={autoFocus}
                enableMobileSingleLine={enableMobileSingleLine}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-1">
                <div className="flex items-center gap-1 text-muted-foreground sm:gap-1.5">
                  <ComposerUploadControl
                    onDraftChange={onDraftChange}
                    onAppendText={appendComposerText}
                    onSelectFile={handleFileSelect}
                  />
                  <ComposerTemplatePickerSlot
                    composer={composer}
                    picker={composerTemplatePicker}
                  />
                  <ComposerWorkflowPromptSlot
                    onCreateWorkflowPrompt={onCreateWorkflowPrompt}
                  />
                  <ConnectorsPopoverButton
                    signals={composerConnectors}
                    agentId={agentRecordId}
                    agentDisplayName={displayName}
                    agentConnectors={agentConnectors}
                    connectorsLoading={connectorsLoading}
                    savingConnectorSlug={savingConnectorSlug}
                    computerUse={computerUse}
                    onOpenAddDialog={() => {
                      return setShowAddDialog(true);
                    }}
                    onToggle={handleToggle}
                  />
                </div>
                <div className="flex items-center gap-1 sm:gap-2">
                  <ComposerModelPickerSlot
                    modelPicker={modelPicker}
                    modelPickerLoading={modelPickerLoading}
                    submitBlocker={submitBlocker}
                    onModelPickerChange={handleModelPickerChange}
                  />
                  <div className="mx-0 h-5 w-px bg-border/60 sm:mx-0.5" />
                  <MicButton
                    onTranscribed={(text) => {
                      appendComposerText(text);
                      onDraftChange?.();
                    }}
                  />
                  <ComposerSendControl
                    draft={draft}
                    visibleAttachmentCount={visibleAttachments.length}
                    uploadsReady={uploadsReady}
                    submitBlocked={submitBlocker !== undefined}
                    sending={sending}
                    queueWhileSending={queueWhileSending}
                    hasQueueHandler={onQueue !== undefined}
                    onCancel={onCancel}
                    actionsLoading={actionsLoading}
                    submissionLoading={
                      submissionLoading ||
                      inputForSubmissionLoadable.state === "loading"
                    }
                    onSend={handleButtonSend}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
        <ActiveGoalObjectiveDialog threadId={chatThreadId} />
        <WebsiteTemplatePreviewDialogSlot />
      </div>
      {selectedConnectorSlug && (
        <ConnectModal
          selectedConnectorSlug={selectedConnectorSlug}
          agentId={nullToUndefined(agentRecordId)}
          onClose={() => {
            return setSelectedConnectorSlug(null);
          }}
          onSuccess={async () => {
            const connectorSlug = pendingConnectorSlug ?? selectedConnectorSlug;
            if (connectorSlug) {
              await completeConnectorAddition(connectorSlug);
            }
          }}
        />
      )}
      {showAddDialog && (
        <AddConnectorsDialog
          signals={composerConnectors}
          unconnected={unconnectedConnectors}
          busyConnectorSlug={busyConnectorSlug}
          connectHandlers={connectorConnectHandlers}
          onClose={() => {
            setPendingConnectorSlug(null);
            return setShowAddDialog(false);
          }}
        />
      )}
    </>
  );
}

export function ZeroChatComposer(props: ZeroChatComposerProps) {
  const connectorReadState = useComposerConnectorReadState(
    props.composerConnectors,
  );
  return useZeroChatComposer(props, connectorReadState);
}
