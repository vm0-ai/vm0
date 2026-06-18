// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { ensurePushSubscription$ } from "../../lib/push-notifications.ts";
import {
  IconAlertTriangle,
  IconArrowUp,
  IconCheck,
  IconDeviceDesktop,
  IconDownload,
  IconPresentation,
  IconEye,
  IconLoader2,
  IconMicrophone,
  IconPaperclip,
  IconPalette,
  IconPlayerStop,
  IconPlug,
  IconPhoto,
  IconPlus,
  IconQuote,
  IconSearch,
  IconTemplate,
  IconVideo,
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
  Input,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
  matchShortcut,
  processShortcut,
  type KeyboardEventLike,
} from "@vm0/ui";
import {
  bestEffort,
  detach,
  onDomEventFn,
  Reason,
  settle,
  tapError,
} from "../../signals/utils.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import {
  navigateToNewChat$,
  toggleSidebarOff$,
} from "../../signals/zero-page/zero-nav.ts";
import type { DraftSignals } from "../../signals/chat-page/create-chat-thread.ts";
import { isVisualAttachment } from "../../signals/chat-page/resolve-draft-attachments.ts";
import type { Command, Computed } from "ccstate";
import {
  zeroChatAttachments$ as singletonAttachments$,
  zeroChatAttachmentUploadSummary$ as singletonAttachmentUploadSummary$,
  uploadZeroAttachment$ as singletonUpload$,
  restoreZeroAttachments$ as singletonRestore$,
  removeZeroAttachment$ as singletonRemove$,
  canSendZeroChat$ as singletonCanSend$,
  zeroDragOver$ as singletonDragOver$,
  setZeroDragOver$ as singletonSetDragOver$,
  composerFileInput$ as singletonComposerFileInput$,
  setComposerFileInput$ as singletonSetComposerFileInput$,
} from "../../signals/chat-page/chat-message.ts";
import type {
  GenerationTemplateRequest,
  PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import { TiptapWorkflowComposer } from "./tiptap-workflow-composer.tsx";
import type { ComposerPasteEvent } from "./composer-input-types.ts";
import {
  parsePresentationEditDraft,
  previewPresentationHtml,
  type PresentationEditDraft,
} from "./presentation-html-edit-protocol.ts";
import { readablePresentationResourceUrl } from "./presentation-html-pptx-download.ts";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
  findVideoTemplateItem,
  r2ImageTransformUrl,
  type IllustrationTemplateItem,
  type PresentationTemplateItem,
  type VideoTemplateItem,
} from "@vm0/core";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { getModelImageInputSupport } from "@vm0/api-contracts/contracts/model-providers";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import templatePickerIcon from "./assets/empty-templates.svg";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import {
  allConnectorTypes$,
  matchesConnectorSearch,
  selectedConnectorType$,
  setSelectedConnectorType$,
  justConnectedTypes$,
  pollingOAuthAuthCodeConnectorType$,
  type ConnectorTypeWithStatus,
} from "../../signals/zero-page/settings/connectors.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  zeroAuthorizedConnectors$,
  authorizeConnector$,
  deauthorizeConnector$,
} from "../../signals/zero-page/zero-connectors.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import {
  showAddDialog$,
  setShowAddDialog$,
  pendingConnectType$,
  setPendingConnectType$,
  composerSavingType$,
  setComposerSavingType$,
  computerUseDownloadDialogOpen$,
  addDialogSearch$,
  setAddDialogSearch$,
  popoverSearch$,
  setPopoverSearch$,
  popoverSortOrder$,
  setPopoverSortOrder$,
  modelPickerOpen$,
  setModelPickerOpen$,
  templatePickerOpen$,
  setTemplatePickerOpen$,
  templatePickerCategory$,
  setTemplatePickerCategory$,
  templatePickerSearch$,
  setTemplatePickerSearch$,
  templatePickerPreviewSlug$,
  setTemplatePickerPreviewSlug$,
  setComputerUseDownloadDialogOpen$,
  illustrationVariantIndex$,
  setIllustrationVariantIndex$,
  templateCardHover$,
  setTemplateCardHover$,
  templateCardDefaultHtmlPreviews$,
  setTemplateCardDefaultHtmlPreview$,
  templateCardHtmlPreview$,
  setTemplateCardHtmlPreview$,
  type TemplateCardHtmlPreviewState,
  templateDetailHtmlPreview$,
  setTemplateDetailHtmlPreview$,
  templateDetailThemeIdBySlug$,
  setTemplateDetailThemeId$,
  templateDetailSlideIndexBySlug$,
  setTemplateDetailSlideIndex$,
} from "../../signals/zero-page/zero-chat-composer.ts";
import {
  audioInputAvailable$,
  audioInputQuota$,
  sttRecording$,
  sttTranscribing$,
  startRecording$,
  stopAndTranscribe$,
} from "../../signals/voice-io/voice-io-stt.ts";
import {
  setActiveOrgManageTab$,
  setBillingSubPage$,
} from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { readChatMessageFromClipboard } from "../../signals/zero-page/clipboard.ts";
import type { FeedbackItem } from "../../signals/zero-page/chat-feedback.ts";

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GB — keep in sync with web constants

// iOS auto-focus pops the on-screen keyboard and scrolls the viewport, which is
// jarring when landing on a chat page. Desktop/Android behavior is unchanged.
function isIOSDevice(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isHappyDomTestEnvironment(): boolean {
  return (
    typeof globalThis.window !== "undefined" && "happyDOM" in globalThis.window
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ZeroChatComposerProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: (
    message: string,
    generationTemplate: GenerationTemplateRequest | undefined,
  ) => void;
  onQueue?: (
    message: string,
    generationTemplate: GenerationTemplateRequest | undefined,
  ) => void;
  sending?: boolean;
  queueWhileSending?: boolean;
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
  /** Per-instance draft signals (from ChatThreadSignals factory). When omitted, falls back to singleton signals. */
  draft?: DraftSignals;
  /** Composer file input element reference. When omitted, falls back to singleton. */
  composerFileInput$?: Computed<HTMLElement | null>;
  /** Set the composer file input element. When omitted, falls back to singleton. */
  setComposerFileInput$?: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  /** Register the textarea element for external focus control. */
  setInputRef?: (el: HTMLElement | null) => void;
  /** Called after attachment upload/remove mutations so the caller can trigger side-effects (e.g. draft sync). */
  onDraftChange?: () => void;
  /**
   * When true, render skeleton placeholders in place of the right-side
   * action cluster (model picker, mic, send/stop). Used during thread switch
   * while thread data is still resolving — prevents briefly flashing stale
   * picker state and a wrong send/stop button derived from prior
   * `allFinished`.
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
    /** Effective default model from user preference, then workspace default. */
    defaultSelection?: ModelProviderSelection | null;
  };
  templatePicker?: {
    value: GenerationTemplateRequest | undefined;
    onChange: (value: GenerationTemplateRequest | undefined) => void;
  };
  computerUse?: {
    hosts: readonly ComposerComputerUseHost[];
    loading: boolean;
    selectedHostId: string | null;
    onChange: (hostId: string | null) => void;
    downloadUrl: string;
  };
  /** When true, render a skeleton in the model picker slot. */
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
  /**
   * Inline feedback drafted from selected assistant text. When at least one
   * quoted fragment is present the composer swaps its textarea for the stacked
   * quote + note rows and its Send button dispatches the feedback turn — so the
   * feedback lives inside the composer instead of a separate panel above it.
   */
  feedback?: ComposerFeedback;
}

export interface ComposerFeedback {
  items: readonly FeedbackItem[];
  /** Fragments carrying a non-empty note — what Send will dispatch. */
  sendCount: number;
  onChangeNote: (id: number, note: string) => void;
  onRemove: (id: number) => void;
  onSubmit: () => void;
  onDismiss: () => void;
}

export interface QueuedComposerItem {
  id: string;
  text: string;
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

const TEMPLATE_CARD_PREVIEW_SIZE = { width: 640, height: 360 } as const;
const ILLUSTRATION_CARD_PREVIEW_SIZE = {
  width: 768,
  height: 768,
  quality: 72,
} as const;
const ILLUSTRATION_VARIANT_THUMB_SIZE = {
  width: 96,
  height: 96,
  quality: 65,
} as const;
const SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE = { width: 40, height: 40 } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ComposerConnectorItem {
  type: ConnectorType;
  label: string;
  helpText: string;
  tags: readonly string[];
  connected: boolean;
  authorized: boolean;
  available: boolean;
}

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
  if (modelPicker.defaultSelection) {
    return modelPicker.defaultSelection;
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
  draftCanSend,
  input,
  visibleAttachmentCount,
  uploadsReady,
}: {
  draftCanSend: boolean;
  input: string;
  visibleAttachmentCount: number;
  uploadsReady: boolean;
}): boolean {
  return (
    uploadsReady &&
    draftCanSend &&
    (input.trim() !== "" || visibleAttachmentCount > 0)
  );
}

// ---------------------------------------------------------------------------
// Queued messages strip — separate card stacked behind the composer with a
// vertical-only stagger. The composer card sits on top (z-10) and covers the
// strip's bottom edge so it reads as one tucked-behind queue layer.
// ---------------------------------------------------------------------------

function QueuedMessagesStrip({
  items,
  onRemove,
}: {
  items: QueuedComposerItem[] | undefined;
  onRemove?: (id: string) => void;
}) {
  if (!items || items.length === 0) {
    return null;
  }
  const count = items.length;
  const label = `${count} ${count === 1 ? "message" : "messages"} waiting to send`;
  return (
    <div className="relative z-0 mx-5 -mb-6 overflow-hidden rounded-xl bg-gray-50 dark:bg-gray-100">
      <div className="flex items-center gap-2 px-5 pt-3 pb-2">
        <span className="inline-flex items-center gap-[2px]" aria-hidden="true">
          <span className="h-2 w-[3px] rounded-sm bg-emerald-800" />
          <span className="h-2 w-[3px] rounded-sm bg-emerald-800/60" />
          <span className="h-2 w-[3px] rounded-sm bg-emerald-800/30" />
        </span>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className="max-h-[200px] overflow-y-auto px-2 pt-1 pb-7" role="list">
        {items.map((item) => {
          return (
            <div
              key={item.id}
              role="listitem"
              aria-label="Queued message"
              className="group flex items-center gap-2 rounded-md pl-3 pr-1 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent"
            >
              <span className="min-w-0 flex-1 truncate">{item.text}</span>
              <button
                type="button"
                className="shrink-0 rounded-lg p-1.5 text-muted-foreground/45 transition-colors hover:bg-[hsl(var(--gray-200))] hover:text-sidebar-foreground focus-visible:bg-[hsl(var(--gray-200))] focus-visible:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  onRemove?.(item.id);
                }}
                aria-label="Remove queued message"
              >
                <IconX size={16} stroke={1.5} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline feedback rows — the docked feedback stack, rendered inside the
// composer card in place of the textarea. Each selected passage is a quote line
// above a borderless, composer-styled note input; fragments append to the
// bottom so reading order matches selection order, and they share the
// composer's toolbar and Send button.
// ---------------------------------------------------------------------------

// Grow the note input to fit its content so multi-line comments expand the
// composer instead of scrolling inside a single row.
function autoGrowFeedbackNote(element: HTMLTextAreaElement | null): void {
  if (!element) {
    return;
  }
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function autoGrowFeedbackNoteRef(element: HTMLTextAreaElement | null): void {
  autoGrowFeedbackNote(element);
}

function focusFeedbackNoteRef(element: HTMLTextAreaElement | null): void {
  element?.focus();
  autoGrowFeedbackNote(element);
}

function ComposerFeedbackRow({
  item,
  autoFocus,
  showDivider,
  fill,
  onChangeNote,
  onRemove,
  onKeyDown,
}: {
  item: FeedbackItem;
  autoFocus: boolean;
  showDivider: boolean;
  fill: boolean;
  onChangeNote: (note: string) => void;
  onRemove: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <div
      className={cn(
        // Bottom padding on every row; top padding only when a dashed divider
        // separates stacked fragments. The first row gets no top inset so the
        // quote chip sits as high as the attachment chips do (matching the
        // composer's pt-3), letting the card extend upward instead of leaving a
        // gap above the chip.
        "flex flex-col gap-1.5 pb-1.5",
        showDivider && "border-t border-dashed border-border/60 pt-1.5",
      )}
    >
      {/* Quote reference reuses the selected-template chip treatment (bordered
          pill, icon square, in-pill remove) so feedback references read the same
          as template chips. */}
      <div className="flex">
        <div className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background/90 pl-1.5 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted">
            <IconQuote
              size={12}
              stroke={1.5}
              className="-scale-x-100 text-muted-foreground"
            />
          </span>
          <span className="min-w-0 truncate text-xs font-medium">
            {item.quote}
          </span>
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove feedback"
            title="Remove feedback"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <IconX size={14} stroke={1.8} />
          </button>
        </div>
      </div>
      <textarea
        ref={autoFocus ? focusFeedbackNoteRef : autoGrowFeedbackNoteRef}
        value={item.note}
        onChange={(event) => {
          autoGrowFeedbackNote(event.target);
          return onChangeNote(event.target.value);
        }}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="What should change about this?"
        className={cn(
          "w-full resize-none overflow-hidden border-0 bg-transparent px-1 py-1 text-[0.9375rem] leading-snug text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-0",
          // The active (newest) note carries the composer's resting height so the
          // ghost text stays anchored above the toolbar — matching the textarea
          // body. Quote chips then stack above it and grow the card upward,
          // mirroring the attachment-chips layout, instead of the chip eating
          // into a fixed-height container and pushing the ghost text down.
          fill && "min-h-[96px]",
        )}
      />
    </div>
  );
}

function ComposerFeedbackRows({ feedback }: { feedback: ComposerFeedback }) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter inserts a newline — matching the main composer.
    // Escape clears the drafted feedback.
    if (matchShortcut("enter", event)) {
      event.preventDefault();
      feedback.onSubmit();
    } else if (matchShortcut("escape", event)) {
      event.preventDefault();
      feedback.onDismiss();
    }
  };

  // Newest fragment sits at the bottom (nearest Send) and takes focus.
  const newestId = feedback.items[feedback.items.length - 1]?.id;

  return (
    // px-4 / pt-3 mirror the attachment-chips inset so the feedback chip lines
    // up with attachments on both the left and top edges. The resting height
    // lives on the newest note (via `fill`) rather than this container, so the
    // quote chip grows the card upward instead of being capped inside a fixed
    // height — keeping the layout consistent with the attachment-chips band.
    <div className="flex flex-col px-4 pb-2 pt-3">
      {feedback.items.map((item, index) => {
        return (
          <ComposerFeedbackRow
            key={item.id}
            item={item}
            autoFocus={item.id === newestId}
            showDivider={index > 0}
            fill={item.id === newestId}
            onChangeNote={(note) => {
              return feedback.onChangeNote(item.id, note);
            }}
            onRemove={() => {
              return feedback.onRemove(item.id);
            }}
            onKeyDown={handleKeyDown}
          />
        );
      })}
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
    value.selection.designSystemId === item.designSystemId &&
    value.selection.templateId === item.templateId
  );
}

function toPresentationGenerationTemplate(
  item: PresentationTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "presentation",
    selection: {
      designSystemId: item.designSystemId,
      templateId: item.templateId,
      previewUrl: item.embedUrl,
    },
  };
}

function presentationTemplatePickerItems(
  useNewPresentationTemplates: boolean,
): readonly PresentationTemplateItem[] {
  return useNewPresentationTemplates
    ? PRESENTATION_TEMPLATE_PICKER_ITEMS
    : PRESENTATION_TEMPLATE_ITEMS;
}

function selectedTemplateTitle(
  value: GenerationTemplateRequest | undefined,
): string | undefined {
  if (value?.type === "video") {
    return selectedVideoTemplateItem(value)?.title;
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
  return (
    PRESENTATION_TEMPLATE_ITEMS.find((item) => {
      return isSelectedPresentationTemplate(item, value);
    }) ??
    PRESENTATION_TEMPLATE_PICKER_ITEMS.find((item) => {
      return isSelectedPresentationTemplate(item, value);
    })
  );
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

function formatPresentationTemplateKind(templateId: string): string {
  const label = templateId
    .replace(/^template:/, "")
    .replace(/^html-ppt-/, "")
    .replace(/-/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function presentationTemplateMatchesSearch(
  item: PresentationTemplateItem,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const searchable = [
    item.title,
    item.designSystemId,
    item.templateId,
    formatPresentationTemplateKind(item.templateId),
  ].join(" ");
  return searchable.toLowerCase().includes(normalizedQuery);
}

function illustrationTemplateMatchesSearch(
  item: IllustrationTemplateItem,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const searchable = [item.title, item.illustrationStyleId].join(" ");
  return searchable.toLowerCase().includes(normalizedQuery);
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

function videoTemplateMatchesSearch(
  item: VideoTemplateItem,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const searchable = [
    item.title,
    item.id,
    item.slug,
    item.description,
    item.sourcePath,
  ].join(" ");
  return searchable.toLowerCase().includes(normalizedQuery);
}

function playVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  detach(video.play(), Reason.DomCallback);
}

function resetVideoTemplatePreview(video: HTMLVideoElement | null): void {
  if (!video) {
    return;
  }
  video.pause();
  video.currentTime = 0;
}

function VideoTemplatePreview({ item }: { item: VideoTemplateItem }) {
  return (
    <video
      src={item.previewVideo}
      poster={r2ImageTransformUrl(
        item.previewImage,
        TEMPLATE_CARD_PREVIEW_SIZE,
      )}
      className="h-full w-full object-cover"
      preload="none"
      playsInline
      muted
      loop
      onMouseEnter={(event) => {
        playVideoTemplatePreview(event.currentTarget);
      }}
      onMouseLeave={(event) => {
        resetVideoTemplatePreview(event.currentTarget);
      }}
    />
  );
}

function VideoTemplateCard({
  item,
  selected,
  onSelect,
}: {
  item: VideoTemplateItem;
  selected: boolean;
  onSelect: (item: VideoTemplateItem) => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-64 flex-col overflow-hidden rounded-lg border bg-card shadow-sm transition-colors hover:bg-muted/20",
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
            aria-label={`Select video template ${item.title}`}
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
            Use
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

function TemplateEmptyPanel({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-40 flex-1 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
      <div className="flex max-w-xl flex-col items-center">
        <IconSearch
          className="mb-4 h-8 w-8 text-muted-foreground/70"
          stroke={1.7}
        />
        <p className="text-sm font-semibold text-muted-foreground">{title}</p>
        <p className="mt-2 text-sm text-muted-foreground/80">{description}</p>
      </div>
    </div>
  );
}

function presentationTemplateSlideImages(
  item: PresentationTemplateItem,
): readonly string[] {
  return item.previewImages;
}

interface PresentationTemplateThemeOption {
  readonly id: string;
  readonly name: string;
  readonly group: "multi-accent" | "single-accent";
  readonly paletteName: string;
  readonly fontName: string;
  readonly displayFont: string;
  readonly bodyFont: string;
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
      fontName: "Poppins",
      displayFont: "Poppins",
      bodyFont: "Figtree",
      colors: [
        "#FFFFFF",
        "#F7F7FA",
        "#1A1726",
        "#5C5870",
        "#7257E6",
        "#AEE63E",
        "#FF6B4A",
        "#3FA9F5",
        "#ECECF2",
      ],
    },
    {
      id: "carnival",
      name: "Carnival",
      group: "multi-accent",
      paletteName: "Carnival",
      fontName: "Archivo",
      displayFont: "Archivo",
      bodyFont: "Manrope",
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
      fontName: "Sora",
      displayFont: "Sora",
      bodyFont: "Inter",
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
      fontName: "Poppins",
      displayFont: "Poppins",
      bodyFont: "Figtree",
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
      fontName: "Space Grotesk",
      displayFont: "Space Grotesk",
      bodyFont: "Lexend",
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
      fontName: "Inter",
      displayFont: "Sora",
      bodyFont: "Inter",
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
      fontName: "Lora",
      displayFont: "Montserrat",
      bodyFont: "Lora",
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
      fontName: "Manrope",
      displayFont: "Archivo",
      bodyFont: "Manrope",
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
      fontName: "Inter",
      displayFont: "Sora",
      bodyFont: "Inter",
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
      fontName: "Lora",
      displayFont: "Montserrat",
      bodyFont: "Lora",
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
      fontName: "DM Sans",
      displayFont: "DM Serif Display",
      bodyFont: "DM Sans",
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
      fontName: "Archivo",
      displayFont: "Archivo",
      bodyFont: "Manrope",
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
      fontName: "Fraunces",
      displayFont: "Fraunces",
      bodyFont: "Work Sans",
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
      fontName: "Inter",
      displayFont: "Sora",
      bodyFont: "Inter",
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
      fontName: "Playfair",
      displayFont: "Playfair Display",
      bodyFont: "Inter",
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
      fontName: "Fraunces",
      displayFont: "Fraunces",
      bodyFont: "Work Sans",
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
      fontName: "Inter",
      displayFont: "Sora",
      bodyFont: "Inter",
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
      fontName: "Lexend",
      displayFont: "Space Grotesk",
      bodyFont: "Lexend",
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
      fontName: "Playfair",
      displayFont: "Playfair Display",
      bodyFont: "Inter",
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

function presentationTemplateThemeAccentSwatches(
  theme: PresentationTemplateThemeOption,
): readonly { readonly color: string; readonly id: string }[] {
  return [
    { id: "base", color: theme.colors[0] },
    { id: "accent", color: theme.colors[4] },
  ];
}

function hexLuminance(hexColor: string): number {
  const normalized = hexColor.replace("#", "");
  const channels = [0, 2, 4].map((index) => {
    const value = Number.parseInt(normalized.slice(index, index + 2), 16) / 255;
    return value <= 0.039_28
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
      --fd:'${theme.displayFont}';
      --fb:'${theme.bodyFont}';
      ${accentVariables}
    }
    #sw {
      display: none !important;
    }
  `;
}

function themedPreviewPresentationHtml(params: {
  readonly activeSlideId: string;
  readonly draft: PresentationEditDraft;
  readonly theme: PresentationTemplateThemeOption;
}): string {
  const html = previewPresentationHtml({
    activeSlideId: params.activeSlideId,
    html: params.draft.html,
  });
  const doc = new DOMParser().parseFromString(html, "text/html");
  const style = doc.createElement("style");
  style.textContent = presentationTemplateThemeCss(params.theme);
  doc.head.append(style);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

async function loadPresentationTemplateHtmlPreview(params: {
  readonly item: PresentationTemplateItem;
}): Promise<PresentationEditDraft | null> {
  const response = await fetch(
    readablePresentationResourceUrl(params.item.embedUrl),
    {
      credentials: "omit",
      mode: "cors",
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to load template HTML (${response.status})`);
  }

  const draft = parsePresentationEditDraft(await response.text());
  return draft.slides.length > 0 ? draft : null;
}

interface PresentationTemplateHtmlPreviewCache {
  readonly drafts: Map<string, PresentationEditDraft>;
  readonly failed: Set<string>;
  readonly pendingLoads: Map<string, Promise<PresentationEditDraft | null>>;
  readonly activeTokens: Map<string, symbol>;
  readonly activeIndexes: Map<string, number>;
  readonly defaultLoads: Set<string>;
}

function presentationTemplateHtmlPreviewCache(): PresentationTemplateHtmlPreviewCache {
  const cacheKey = "vm0PresentationTemplateHtmlPreviewCache";
  const existingCache = Reflect.get(globalThis, cacheKey) as
    | PresentationTemplateHtmlPreviewCache
    | undefined;
  if (existingCache !== undefined) {
    return existingCache;
  }

  const cache: PresentationTemplateHtmlPreviewCache = {
    activeIndexes: new Map<string, number>(),
    activeTokens: new Map<string, symbol>(),
    defaultLoads: new Set<string>(),
    drafts: new Map<string, PresentationEditDraft>(),
    failed: new Set<string>(),
    pendingLoads: new Map<string, Promise<PresentationEditDraft | null>>(),
  };
  Reflect.set(globalThis, cacheKey, cache);
  return cache;
}

function revokePresentationTemplateHtmlPreviewUrl(url: string | null): void {
  if (url !== null) {
    URL.revokeObjectURL(url);
  }
}

function revokePresentationTemplateHtmlPreviewUrls(
  urls: readonly string[],
): void {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
}

function createThemedPresentationPreviewUrl(params: {
  readonly activeSlideId: string;
  readonly draft: PresentationEditDraft;
  readonly theme: PresentationTemplateThemeOption;
}): string {
  return URL.createObjectURL(
    new Blob(
      [
        themedPreviewPresentationHtml({
          activeSlideId: params.activeSlideId,
          draft: params.draft,
          theme: params.theme,
        }),
      ],
      { type: "text/html;charset=utf-8" },
    ),
  );
}

function createPresentationTemplateHtmlPreviewState(params: {
  readonly draft: PresentationEditDraft;
  readonly index: number;
  readonly item: PresentationTemplateItem;
  readonly previousFrameUrl: string | null;
  readonly theme?: PresentationTemplateThemeOption;
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
        params.theme
          ? themedPreviewPresentationHtml({
              activeSlideId: slide.id,
              draft: params.draft,
              theme: params.theme,
            })
          : previewPresentationHtml({
              activeSlideId: slide.id,
              html: params.draft.html,
            }),
      ],
      { type: "text/html;charset=utf-8" },
    ),
  );

  return {
    slug: params.item.slug,
    embedUrl: params.item.embedUrl,
    loading: false,
    failed: false,
    frameUrl,
    slideCount: params.draft.slides.length,
  };
}

function TemplatePreview({
  item,
  onPreview,
}: {
  item: PresentationTemplateItem;
  onPreview: (item: PresentationTemplateItem) => void;
}) {
  const hover = useGet(templateCardHover$);
  const setHover = useSet(setTemplateCardHover$);
  const htmlPreview = useGet(templateCardHtmlPreview$);
  const setHtmlPreview = useSet(setTemplateCardHtmlPreview$);
  const defaultHtmlPreviews = useGet(templateCardDefaultHtmlPreviews$);
  const setDefaultHtmlPreview = useSet(setTemplateCardDefaultHtmlPreview$);
  const hoverSlideIndex = hover?.slug === item.slug ? hover.index : 0;
  const activeHtmlPreview =
    htmlPreview?.slug === item.slug && htmlPreview.embedUrl === item.embedUrl
      ? htmlPreview
      : null;
  const defaultHtmlPreview = defaultHtmlPreviews[item.embedUrl] ?? null;
  const visibleHtmlPreview = activeHtmlPreview ?? defaultHtmlPreview;
  const defaultTheme = findPresentationTemplateTheme(
    defaultPresentationTemplateThemeId(item),
  );
  const fallbackSlideCount = Math.max(item.previewImages.length, 1);
  const scrubSlideCount = visibleHtmlPreview?.slideCount ?? fallbackSlideCount;

  const ensureDefaultHtmlPreview = () => {
    if (defaultHtmlPreview !== null) {
      return;
    }

    const cache = presentationTemplateHtmlPreviewCache();
    const setDefaultPreview = (draft: PresentationEditDraft) => {
      const previewState = createPresentationTemplateHtmlPreviewState({
        draft,
        index: 0,
        item,
        previousFrameUrl: null,
        theme: defaultTheme,
      });
      if (previewState !== null) {
        setDefaultHtmlPreview(item.embedUrl, previewState);
      }
    };

    const cachedDraft = cache.drafts.get(item.embedUrl);
    if (cachedDraft !== undefined) {
      setDefaultPreview(cachedDraft);
      return;
    }

    if (
      !cache.failed.has(item.embedUrl) &&
      !cache.defaultLoads.has(item.embedUrl)
    ) {
      cache.defaultLoads.add(item.embedUrl);
      setDefaultHtmlPreview(item.embedUrl, {
        slug: item.slug,
        embedUrl: item.embedUrl,
        loading: true,
        failed: false,
        frameUrl: null,
        slideCount: fallbackSlideCount,
      });
      let pendingLoad = cache.pendingLoads.get(item.embedUrl);
      if (pendingLoad === undefined) {
        pendingLoad = loadPresentationTemplateHtmlPreview({ item });
        cache.pendingLoads.set(item.embedUrl, pendingLoad);
      }
      detach(
        (async () => {
          const result = await settle(pendingLoad);
          if (cache.pendingLoads.get(item.embedUrl) === pendingLoad) {
            cache.pendingLoads.delete(item.embedUrl);
          }
          if (!result.ok || result.value === null) {
            cache.failed.add(item.embedUrl);
            setDefaultHtmlPreview(item.embedUrl, {
              slug: item.slug,
              embedUrl: item.embedUrl,
              loading: false,
              failed: true,
              frameUrl: null,
              slideCount: fallbackSlideCount,
            });
            return;
          }
          cache.drafts.set(item.embedUrl, result.value);
          setDefaultPreview(result.value);
        })(),
        Reason.DomCallback,
      );
    }
  };

  if (!isHappyDomTestEnvironment()) {
    ensureDefaultHtmlPreview();
  }

  const startHtmlPreviewLoad = () => {
    const cache = presentationTemplateHtmlPreviewCache();
    const activeIndex = cache.activeIndexes.get(item.embedUrl) ?? 0;
    const cachedDraft = cache.drafts.get(item.embedUrl);
    if (cachedDraft !== undefined) {
      const previewState = createPresentationTemplateHtmlPreviewState({
        draft: cachedDraft,
        index: activeIndex,
        item,
        previousFrameUrl: activeHtmlPreview?.frameUrl ?? null,
        theme: defaultTheme,
      });
      setHtmlPreview(previewState);
      return;
    }

    if (cache.failed.has(item.embedUrl)) {
      setHtmlPreview({
        slug: item.slug,
        embedUrl: item.embedUrl,
        loading: false,
        failed: true,
        frameUrl: null,
        slideCount: fallbackSlideCount,
      });
      return;
    }

    let pendingLoad = cache.pendingLoads.get(item.embedUrl);
    if (pendingLoad === undefined) {
      pendingLoad = loadPresentationTemplateHtmlPreview({ item });
      cache.pendingLoads.set(item.embedUrl, pendingLoad);
    }

    const activeToken = Symbol(item.embedUrl);
    cache.activeTokens.set(item.embedUrl, activeToken);
    setHtmlPreview({
      slug: item.slug,
      embedUrl: item.embedUrl,
      loading: true,
      failed: false,
      frameUrl: null,
      slideCount: fallbackSlideCount,
    });
    detach(
      (async () => {
        const result = await settle(pendingLoad);
        if (cache.pendingLoads.get(item.embedUrl) === pendingLoad) {
          cache.pendingLoads.delete(item.embedUrl);
        }

        if (!result.ok || result.value === null) {
          cache.failed.add(item.embedUrl);
          if (cache.activeTokens.get(item.embedUrl) === activeToken) {
            setHtmlPreview({
              slug: item.slug,
              embedUrl: item.embedUrl,
              loading: false,
              failed: true,
              frameUrl: null,
              slideCount: fallbackSlideCount,
            });
          }
          return;
        }

        cache.drafts.set(item.embedUrl, result.value);
        if (cache.activeTokens.get(item.embedUrl) === activeToken) {
          setHtmlPreview(
            createPresentationTemplateHtmlPreviewState({
              draft: result.value,
              index: cache.activeIndexes.get(item.embedUrl) ?? 0,
              item,
              previousFrameUrl: activeHtmlPreview?.frameUrl ?? null,
              theme: defaultTheme,
            }),
          );
        }
      })(),
      Reason.DomCallback,
    );
  };

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
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
    if (nextIndex !== hoverSlideIndex) {
      const cachedDraft = presentationTemplateHtmlPreviewCache().drafts.get(
        item.embedUrl,
      );
      presentationTemplateHtmlPreviewCache().activeIndexes.set(
        item.embedUrl,
        nextIndex,
      );
      event.currentTarget.dataset.targetSlideIndex = String(nextIndex);
      if (cachedDraft !== undefined) {
        setHover({ slug: item.slug, index: nextIndex });
        setHtmlPreview(
          createPresentationTemplateHtmlPreviewState({
            draft: cachedDraft,
            index: nextIndex,
            item,
            previousFrameUrl: activeHtmlPreview?.frameUrl ?? null,
            theme: defaultTheme,
          }),
        );
        return;
      }

      setHover({ slug: item.slug, index: nextIndex });
    }
  };

  return (
    <div
      className="relative aspect-[16/9] shrink-0 overflow-hidden bg-muted"
      onMouseEnter={() => {
        presentationTemplateHtmlPreviewCache().activeIndexes.set(
          item.embedUrl,
          0,
        );
        setHover({ slug: item.slug, index: 0 });
        startHtmlPreviewLoad();
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={(event) => {
        delete event.currentTarget.dataset.targetSlideIndex;
        const cache = presentationTemplateHtmlPreviewCache();
        cache.activeIndexes.delete(item.embedUrl);
        cache.activeTokens.delete(item.embedUrl);
        revokePresentationTemplateHtmlPreviewUrl(
          activeHtmlPreview?.frameUrl ?? null,
        );
        setHtmlPreview(null);
        setHover(null);
      }}
    >
      <iframe
        title={`${item.title} HTML preview`}
        data-testid={`${item.title} card HTML preview`}
        src={visibleHtmlPreview?.frameUrl ?? undefined}
        sandbox="allow-same-origin"
        className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-background"
      />
      {visibleHtmlPreview?.loading || !visibleHtmlPreview?.frameUrl ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
          <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
        </div>
      ) : null}
      <button
        type="button"
        aria-label={`View template ${item.title}`}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background/85 text-foreground opacity-0 shadow-sm backdrop-blur transition-colors hover:bg-background group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.stopPropagation();
          onPreview(item);
        }}
      >
        <IconEye size={16} stroke={1.8} />
      </button>
    </div>
  );
}

function TemplatePreviewPage({
  item,
  onBack,
  onSelect,
}: {
  item: PresentationTemplateItem;
  onBack: () => void;
  onSelect: (item: PresentationTemplateItem) => void;
}) {
  const slideImages = presentationTemplateSlideImages(item);
  const detailPreview = useGet(templateDetailHtmlPreview$);
  const setDetailPreview = useSet(setTemplateDetailHtmlPreview$);
  const themeIdBySlug = useGet(templateDetailThemeIdBySlug$);
  const setThemeId = useSet(setTemplateDetailThemeId$);
  const slideIndexBySlug = useGet(templateDetailSlideIndexBySlug$);
  const setSlideIndex = useSet(setTemplateDetailSlideIndex$);
  const selectedThemeId =
    themeIdBySlug[item.slug] ?? defaultPresentationTemplateThemeId(item);
  const selectedTheme = findPresentationTemplateTheme(selectedThemeId);
  const activeSlideIndex = slideIndexBySlug[item.slug] ?? 0;
  const visibleDetailPreview =
    detailPreview?.slug === item.slug &&
    detailPreview.embedUrl === item.embedUrl &&
    detailPreview.themeId === selectedTheme.id &&
    detailPreview.index === activeSlideIndex
      ? detailPreview
      : null;
  const fallbackSlideCount = Math.max(slideImages.length, 1);
  const detailSlideCount =
    visibleDetailPreview?.slideCount ?? fallbackSlideCount;

  const setLoadedDetailPreview = (params: {
    readonly draft: PresentationEditDraft;
    readonly index: number;
    readonly previousFrameUrl: string | null;
    readonly previousThumbnailFrameUrls: readonly string[];
    readonly reuseThumbnailFrameUrls: boolean;
    readonly theme: PresentationTemplateThemeOption;
  }) => {
    const slide =
      params.draft.slides[
        Math.min(params.index, params.draft.slides.length - 1)
      ];
    if (slide === undefined) {
      return;
    }
    revokePresentationTemplateHtmlPreviewUrl(params.previousFrameUrl);
    if (
      !params.reuseThumbnailFrameUrls &&
      params.previousThumbnailFrameUrls.length > 0
    ) {
      revokePresentationTemplateHtmlPreviewUrls(
        params.previousThumbnailFrameUrls,
      );
    }
    const frameUrl = createThemedPresentationPreviewUrl({
      activeSlideId: slide.id,
      draft: params.draft,
      theme: params.theme,
    });
    const thumbnailFrameUrls =
      params.reuseThumbnailFrameUrls &&
      params.previousThumbnailFrameUrls.length > 0
        ? params.previousThumbnailFrameUrls
        : params.draft.slides.slice(0, 15).map((thumbnailSlide) => {
            return createThemedPresentationPreviewUrl({
              activeSlideId: thumbnailSlide.id,
              draft: params.draft,
              theme: params.theme,
            });
          });
    setDetailPreview({
      slug: item.slug,
      embedUrl: item.embedUrl,
      themeId: params.theme.id,
      index: params.index,
      loading: false,
      failed: false,
      frameUrl,
      thumbnailFrameUrls,
      slideCount: params.draft.slides.length,
    });
  };

  const ensureDetailHtmlPreview = () => {
    if (visibleDetailPreview !== null) {
      return;
    }

    const cache = presentationTemplateHtmlPreviewCache();
    const cachedDraft = cache.drafts.get(item.embedUrl);
    if (cachedDraft !== undefined) {
      setLoadedDetailPreview({
        draft: cachedDraft,
        index: activeSlideIndex,
        previousFrameUrl: detailPreview?.frameUrl ?? null,
        previousThumbnailFrameUrls: detailPreview?.thumbnailFrameUrls ?? [],
        reuseThumbnailFrameUrls: detailPreview?.themeId === selectedTheme.id,
        theme: selectedTheme,
      });
      return;
    }

    if (cache.failed.has(item.embedUrl)) {
      setDetailPreview({
        slug: item.slug,
        embedUrl: item.embedUrl,
        themeId: selectedTheme.id,
        index: activeSlideIndex,
        loading: false,
        failed: true,
        frameUrl: null,
        thumbnailFrameUrls: [],
        slideCount: fallbackSlideCount,
      });
      return;
    }

    let pendingLoad = cache.pendingLoads.get(item.embedUrl);
    if (pendingLoad === undefined) {
      pendingLoad = loadPresentationTemplateHtmlPreview({ item });
      cache.pendingLoads.set(item.embedUrl, pendingLoad);
    }
    setDetailPreview({
      slug: item.slug,
      embedUrl: item.embedUrl,
      themeId: selectedTheme.id,
      index: activeSlideIndex,
      loading: true,
      failed: false,
      frameUrl: null,
      thumbnailFrameUrls: [],
      slideCount: fallbackSlideCount,
    });
    detach(
      (async () => {
        const result = await settle(pendingLoad);
        if (cache.pendingLoads.get(item.embedUrl) === pendingLoad) {
          cache.pendingLoads.delete(item.embedUrl);
        }
        if (!result.ok || result.value === null) {
          cache.failed.add(item.embedUrl);
          setDetailPreview({
            slug: item.slug,
            embedUrl: item.embedUrl,
            themeId: selectedTheme.id,
            index: activeSlideIndex,
            loading: false,
            failed: true,
            frameUrl: null,
            thumbnailFrameUrls: [],
            slideCount: fallbackSlideCount,
          });
          return;
        }
        cache.drafts.set(item.embedUrl, result.value);
        setLoadedDetailPreview({
          draft: result.value,
          index: activeSlideIndex,
          previousFrameUrl: detailPreview?.frameUrl ?? null,
          previousThumbnailFrameUrls: detailPreview?.thumbnailFrameUrls ?? [],
          reuseThumbnailFrameUrls: false,
          theme: selectedTheme,
        });
      })(),
      Reason.DomCallback,
    );
  };

  if (!isHappyDomTestEnvironment()) {
    ensureDetailHtmlPreview();
  }

  const selectDetailSlide = (index: number) => {
    const nextIndex = Math.max(0, Math.min(detailSlideCount - 1, index));
    setSlideIndex(item.slug, nextIndex);
    const cachedDraft = presentationTemplateHtmlPreviewCache().drafts.get(
      item.embedUrl,
    );
    if (cachedDraft !== undefined) {
      setLoadedDetailPreview({
        draft: cachedDraft,
        index: nextIndex,
        previousFrameUrl: detailPreview?.frameUrl ?? null,
        previousThumbnailFrameUrls: detailPreview?.thumbnailFrameUrls ?? [],
        reuseThumbnailFrameUrls: detailPreview?.themeId === selectedTheme.id,
        theme: selectedTheme,
      });
    }
  };

  const selectDetailTheme = (theme: PresentationTemplateThemeOption) => {
    setThemeId(item.slug, theme.id);
    const cachedDraft = presentationTemplateHtmlPreviewCache().drafts.get(
      item.embedUrl,
    );
    if (cachedDraft !== undefined) {
      setLoadedDetailPreview({
        draft: cachedDraft,
        index: activeSlideIndex,
        previousFrameUrl: detailPreview?.frameUrl ?? null,
        previousThumbnailFrameUrls: detailPreview?.thumbnailFrameUrls ?? [],
        reuseThumbnailFrameUrls: false,
        theme,
      });
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
      <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-base">
          <button
            type="button"
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onBack}
          >
            Templates
          </button>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="shrink-0 text-muted-foreground">Presentation</span>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="min-w-0 truncate">{item.title}</span>
        </DialogTitle>
      </DialogHeader>
      <div className="grid max-h-[72vh] gap-4 overflow-y-auto bg-muted/20 p-5 lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="relative overflow-hidden rounded-lg bg-muted">
            <iframe
              title={`${item.title} HTML preview`}
              data-testid={`${item.title} detail HTML preview`}
              src={visibleDetailPreview?.frameUrl ?? undefined}
              sandbox="allow-same-origin"
              className="pointer-events-none aspect-[16/9] w-full border-0 bg-background"
            />
            <button
              type="button"
              aria-label="Preview previous slide"
              disabled={activeSlideIndex === 0}
              onClick={() => {
                selectDetailSlide(activeSlideIndex - 1);
              }}
              className="absolute inset-y-0 left-0 w-1/2 cursor-w-resize bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            />
            <button
              type="button"
              aria-label="Preview next slide"
              disabled={activeSlideIndex >= detailSlideCount - 1}
              onClick={() => {
                selectDetailSlide(activeSlideIndex + 1);
              }}
              className="absolute inset-y-0 right-0 w-1/2 cursor-e-resize bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
            />
            <div className="pointer-events-none absolute left-3 top-3 rounded-full border border-border bg-background/90 px-2.5 py-1 text-xs font-semibold text-foreground shadow-sm backdrop-blur">
              {Math.min(activeSlideIndex + 1, detailSlideCount)} of{" "}
              {detailSlideCount}
            </div>
            {visibleDetailPreview?.loading ||
            !visibleDetailPreview?.frameUrl ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-muted">
                <div className="h-full w-1/3 animate-pulse bg-muted-foreground/40" />
              </div>
            ) : null}
          </div>
          <div className="mt-3 grid grid-cols-8 gap-1.5">
            {Array.from(
              { length: Math.min(detailSlideCount, 15) },
              (_, index) => {
                return index + 1;
              },
            ).map((slideNumber) => {
              const slideIndex = slideNumber - 1;
              const active = slideIndex === activeSlideIndex;
              return (
                <button
                  key={slideNumber}
                  type="button"
                  aria-label={`Preview slide ${slideNumber}`}
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
                  {visibleDetailPreview?.thumbnailFrameUrls[slideIndex] ? (
                    <iframe
                      title={`${item.title} slide ${slideNumber} thumbnail`}
                      src={visibleDetailPreview.thumbnailFrameUrls[slideIndex]}
                      sandbox="allow-same-origin"
                      className="pointer-events-none absolute inset-0 h-full w-full border-0 bg-background"
                    />
                  ) : (
                    <span className="absolute inset-0 bg-muted/40" />
                  )}
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
            <p className="mt-1.5 text-sm text-muted-foreground">
              {detailSlideCount} slides
            </p>
            <div className="my-5 border-t border-border" />
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <IconPalette size={14} stroke={1.9} />
              <span>Theme</span>
            </p>
            <div className="mt-3 space-y-4">
              <div className="space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  Multi-accent
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {multiAccentThemes.map((theme) => {
                    const active = theme.id === selectedTheme.id;
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        aria-label={`Select style ${theme.name}`}
                        aria-pressed={active}
                        onClick={() => {
                          selectDetailTheme(theme);
                        }}
                        className={cn(
                          "relative h-11 overflow-hidden rounded-lg border bg-background p-1 transition-colors hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                        {active ? (
                          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background/90 text-foreground shadow-sm backdrop-blur">
                            <IconCheck size={11} stroke={2.3} />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <p className="px-1 text-xs font-medium text-muted-foreground">
                  Single-accent
                </p>
                <div className="grid grid-cols-8 gap-2">
                  {singleAccentThemes.map((theme) => {
                    const active = theme.id === selectedTheme.id;
                    const swatches =
                      presentationTemplateThemeAccentSwatches(theme);
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        aria-label={`Select style ${theme.name}`}
                        aria-pressed={active}
                        onClick={() => {
                          selectDetailTheme(theme);
                        }}
                        className={cn(
                          "relative h-7 overflow-hidden rounded-md border transition-colors hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                        {active ? (
                          <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-border bg-background/90 text-foreground shadow-sm backdrop-blur">
                            <IconCheck size={11} stroke={2.3} />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label={`Select template ${item.title}`}
              className="mt-4 h-12 w-full rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => {
                onSelect(item);
              }}
            >
              Use this template
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
}: {
  item: PresentationTemplateItem;
  selected: boolean;
  onSelect: (item: PresentationTemplateItem) => void;
  onPreview: (item: PresentationTemplateItem) => void;
}) {
  return (
    <div
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm transition-colors hover:bg-muted/20",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <TemplatePreview item={item} onPreview={onPreview} />
      <div className="flex flex-1 items-center justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="cursor-default truncate text-sm font-semibold text-foreground">
                  {item.title}
                </p>
              </TooltipTrigger>
              <TooltipContent side="bottom">{item.title}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={`Select template ${item.title}`}
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
            Use
          </button>
        </div>
      </div>
    </div>
  );
}

function IllustrationTemplateHero({
  item,
  images,
  activeIndex,
  source,
  onVariantChange,
}: {
  item: IllustrationTemplateItem;
  images: readonly string[];
  activeIndex: number;
  source: string;
  onVariantChange: (slug: string, index: number) => void;
}) {
  const heroImage = illustrationHeroImageUrl(source);
  const navigable = images.length > 1;
  const variantAt = (direction: -1 | 1): number => {
    return (activeIndex + direction + images.length) % images.length;
  };
  const preloadNeighbors = (): void => {
    preloadIllustrationVariant(images, variantAt(1));
    preloadIllustrationVariant(images, variantAt(-1));
  };

  return (
    <div
      className="relative w-full overflow-hidden bg-muted"
      style={{ aspectRatio: `${String(item.width)} / ${String(item.height)}` }}
    >
      <img
        key={source}
        src={heroImage}
        alt={`${item.title} illustration preview`}
        className={cn(
          "absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150 data-[loaded=true]:opacity-100",
          navigable && "cursor-pointer",
        )}
        loading="lazy"
        decoding="async"
        fetchPriority="low"
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
                });
              }
            : undefined
        }
        onLoad={(event) => {
          const image = event.currentTarget;
          detach(
            markIllustrationPreviewImageLoaded(heroImage, image),
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

interface IllustrationPreviewImageCache {
  readonly decoded: Set<string>;
  readonly pendingDecodes: Map<string, Promise<void>>;
  readonly preloads: Map<string, HTMLImageElement>;
}

function illustrationPreviewImageCache(): IllustrationPreviewImageCache {
  const cacheKey = "vm0IllustrationPreviewImageDecodeCache";
  const existingCache = Reflect.get(globalThis, cacheKey) as
    | IllustrationPreviewImageCache
    | undefined;
  if (existingCache !== undefined) {
    return existingCache;
  }

  const cache: IllustrationPreviewImageCache = {
    decoded: new Set<string>(),
    pendingDecodes: new Map<string, Promise<void>>(),
    preloads: new Map<string, HTMLImageElement>(),
  };
  Reflect.set(globalThis, cacheKey, cache);
  return cache;
}

function illustrationHeroImageUrl(source: string): string {
  return r2ImageTransformUrl(source, ILLUSTRATION_CARD_PREVIEW_SIZE);
}

function preloadIllustrationPreviewImage(
  url: string,
): HTMLImageElement | undefined {
  if (typeof Image === "undefined") {
    return undefined;
  }

  const cache = illustrationPreviewImageCache();
  const cachedImage = cache.preloads.get(url);
  if (cachedImage !== undefined) {
    return cachedImage;
  }

  const image = new Image();
  image.decoding = "async";
  image.src = url;
  cache.preloads.set(url, image);
  return image;
}

async function decodeIllustrationPreviewImage(url: string): Promise<void> {
  const cache = illustrationPreviewImageCache();
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

  const image = preloadIllustrationPreviewImage(url);
  if (image === undefined) {
    return;
  }

  if (image.decode === undefined) {
    if (image.complete && image.naturalWidth > 0) {
      cache.decoded.add(url);
    }
    return;
  }

  const decode = markIllustrationPreviewImageDecoded(url, image);
  cache.pendingDecodes.set(url, decode);
  await decode;
}

async function markIllustrationPreviewImageDecoded(
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = illustrationPreviewImageCache();
  await tapError(image.decode(), () => {});
  if (image.complete && image.naturalWidth > 0) {
    cache.decoded.add(url);
  }
  cache.pendingDecodes.delete(url);
}

async function markIllustrationPreviewImageLoaded(
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = illustrationPreviewImageCache();
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

function illustrationPreviewImageDecoded(url: string): boolean {
  return illustrationPreviewImageCache().decoded.has(url);
}

async function selectDecodedIllustrationVariant({
  card,
  imageUrl,
  index,
  item,
  onVariantChange,
}: {
  card: HTMLElement;
  imageUrl: string;
  index: number;
  item: IllustrationTemplateItem;
  onVariantChange: (slug: string, index: number) => void;
}): Promise<void> {
  await decodeIllustrationPreviewImage(imageUrl);
  if (
    card.dataset.targetVariantIndex === String(index) &&
    illustrationPreviewImageDecoded(imageUrl)
  ) {
    onVariantChange(item.slug, index);
  }
}

function selectIllustrationVariant({
  card,
  index,
  item,
  onVariantChange,
}: {
  card: HTMLElement | null;
  index: number;
  item: IllustrationTemplateItem;
  onVariantChange: (slug: string, index: number) => void;
}): void {
  const image = item.previewImages[index];
  if (image === undefined) {
    return;
  }

  const imageUrl = illustrationHeroImageUrl(image);
  // Swap immediately only when the target hero is already decoded; otherwise
  // decode it off-screen first so the hero never flashes a blank/loading frame.
  if (card === null || illustrationPreviewImageDecoded(imageUrl)) {
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
    }),
    Reason.DomCallback,
  );
}

function preloadIllustrationVariant(
  images: readonly string[],
  index: number,
): void {
  const image = images[index];
  if (image === undefined) {
    return;
  }

  detach(
    decodeIllustrationPreviewImage(illustrationHeroImageUrl(image)),
    Reason.DomCallback,
  );
}

function scrollIllustrationThumbnailIntoView(
  node: HTMLButtonElement | null,
): void {
  node?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function IllustrationTemplateCard({
  item,
  selected,
  activeIndex,
  onSelect,
  onVariantChange,
}: {
  item: IllustrationTemplateItem;
  selected: boolean;
  activeIndex: number;
  onSelect: (item: IllustrationTemplateItem) => void;
  onVariantChange: (slug: string, index: number) => void;
}) {
  const images = item.previewImages;
  const safeIndex = Math.max(0, Math.min(activeIndex, images.length - 1));
  const heroSource = images[safeIndex] ?? item.previewImage;
  const hasMultipleVariants = images.length > 1;

  return (
    <div
      data-illustration-template-card=""
      className={cn(
        "group mb-4 break-inside-avoid overflow-hidden rounded-xl border bg-card shadow-sm transition-colors",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-border hover:border-muted-foreground/30",
      )}
    >
      <IllustrationTemplateHero
        item={item}
        images={images}
        activeIndex={safeIndex}
        source={heroSource}
        onVariantChange={onVariantChange}
      />
      {hasMultipleVariants && (
        <div className="flex items-center gap-2 overflow-x-auto px-3 pt-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
                // Keep the selected thumbnail fully in view when the active
                // variant changes (e.g. via hero navigation), so later
                // thumbnails past the clipped strip edge stay reachable.
                ref={active ? scrollIllustrationThumbnailIntoView : undefined}
                aria-label={`Show variant ${index + 1}`}
                aria-pressed={active}
                className={cn(
                  "relative h-12 w-12 shrink-0 overflow-hidden rounded-md border-2 bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "border-primary" : "border-border",
                )}
                onFocus={() => {
                  preloadIllustrationPreviewImage(
                    illustrationHeroImageUrl(image),
                  );
                }}
                onMouseEnter={() => {
                  preloadIllustrationPreviewImage(
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
                  });
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
          aria-label={`Select template ${item.title}`}
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
          Use
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
}: {
  category: string;
  hasPptTab: boolean;
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
}): string {
  const categories: string[] = [];
  if (hasPptTab) {
    categories.push("slides");
  }
  if (hasIllustrationTab) {
    categories.push("illustration");
  }
  if (hasVideoTab) {
    categories.push("video");
  }
  const defaultCategory = categories[0];
  if (category === "video" && !hasVideoTab) {
    return defaultCategory;
  }
  return categories.includes(category) ? category : defaultCategory;
}

function TemplatePickerTabs({
  selectedCategory,
  hasPptTab,
  hasIllustrationTab,
  hasVideoTab,
  onChange,
}: {
  selectedCategory: string;
  hasPptTab: boolean;
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Tabs value={selectedCategory} onValueChange={onChange} className="-mb-px">
      <TabsList className="h-auto gap-6 rounded-none bg-transparent p-0">
        {hasPptTab && (
          <TabsTrigger
            value="slides"
            className={cn(
              "h-12 gap-2 rounded-none border-b-2 bg-transparent px-1 pb-3 pt-2 text-base font-semibold shadow-none focus-visible:ring-inset focus-visible:ring-offset-0",
              selectedCategory === "slides"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <IconPresentation
              className={cn(
                "h-5 w-5",
                selectedCategory === "slides"
                  ? "text-blue-500"
                  : "text-muted-foreground",
              )}
              stroke={1.8}
            />
            Presentation
          </TabsTrigger>
        )}
        {hasIllustrationTab && (
          <TabsTrigger
            value="illustration"
            className={cn(
              "h-12 gap-2 rounded-none border-b-2 bg-transparent px-1 pb-3 pt-2 text-base font-semibold shadow-none focus-visible:ring-inset focus-visible:ring-offset-0",
              selectedCategory === "illustration"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <IconPhoto
              className={cn(
                "h-5 w-5",
                selectedCategory === "illustration"
                  ? "text-emerald-500"
                  : "text-muted-foreground",
              )}
              stroke={1.8}
            />
            Illustration
          </TabsTrigger>
        )}
        {hasVideoTab && (
          <TabsTrigger
            value="video"
            className={cn(
              "h-12 gap-2 rounded-none border-b-2 bg-transparent px-1 pb-3 pt-2 text-base font-semibold shadow-none focus-visible:ring-inset focus-visible:ring-offset-0",
              selectedCategory === "video"
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <IconVideo
              className={cn(
                "h-5 w-5",
                selectedCategory === "video"
                  ? "text-purple-500"
                  : "text-muted-foreground",
              )}
              stroke={1.8}
            />
            Video
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );
}

function IllustrationTemplateGrid({
  items,
  value,
  variantIndexBySlug,
  onSelect,
  onVariantChange,
}: {
  items: IllustrationTemplateItem[];
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
      {items.map((item) => {
        return (
          <IllustrationTemplateCard
            key={item.illustrationStyleId}
            item={item}
            selected={isSelectedIllustrationTemplate(item, value)}
            activeIndex={variantIndexBySlug[item.slug] ?? 0}
            onSelect={onSelect}
            onVariantChange={onVariantChange}
          />
        );
      })}
    </div>
  );
}

function PptTemplateGrid({
  items,
  value,
  onSelect,
  onPreview,
}: {
  items: PresentationTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: PresentationTemplateItem) => void;
  onPreview: (item: PresentationTemplateItem) => void;
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
  hasPptTab,
  presentationItems,
  hasIllustrationTab,
  hasVideoTab,
}: {
  value: GenerationTemplateRequest | undefined;
  onChange: (value: GenerationTemplateRequest | undefined) => void;
  onClose: () => void;
  hasPptTab: boolean;
  presentationItems: readonly PresentationTemplateItem[];
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
}) {
  const category = useGet(templatePickerCategory$);
  const setCategory = useSet(setTemplatePickerCategory$);
  const search = useGet(templatePickerSearch$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const previewSlug = useGet(templatePickerPreviewSlug$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const illustrationVariantIndex = useGet(illustrationVariantIndex$);
  const setIllustrationVariantIndex = useSet(setIllustrationVariantIndex$);
  const previewItem =
    presentationItems.find((item) => {
      return item.slug === previewSlug;
    }) ?? null;
  const isPreviewing = Boolean(previewItem);
  const dialogContentClassName = cn(
    "p-0 gap-0 overflow-hidden",
    // The auto-rendered close button defaults to top-4, which is tuned for the
    // default p-6 dialog. This dialog uses a custom py-4 header, so re-center the
    // 36px (size-9) close button within the 50px header.
    "[&>button[aria-label=Close]]:top-[7px]",
    isPreviewing ? "max-w-6xl" : "flex h-[min(82vh,760px)] max-w-4xl flex-col",
  );
  const filteredPptItems = presentationItems.filter((item) => {
    return presentationTemplateMatchesSearch(item, search);
  });
  const filteredIllustrationItems = ILLUSTRATION_TEMPLATE_ITEMS.filter(
    (item) => {
      return illustrationTemplateMatchesSearch(item, search);
    },
  );
  const filteredVideoItems = VIDEO_TEMPLATE_ITEMS.filter((item) => {
    return videoTemplateMatchesSearch(item, search);
  });

  const handleSelectPresentation = (item: PresentationTemplateItem) => {
    onChange(toPresentationGenerationTemplate(item));
    onClose();
  };

  const handleSelectVideo = (item: VideoTemplateItem) => {
    onChange(toVideoGenerationTemplate(item));
    onClose();
  };

  const handleSelectIllustration = (item: IllustrationTemplateItem) => {
    onChange(toIllustrationGenerationTemplate(item));
    onClose();
  };

  const handlePreview = (item: PresentationTemplateItem) => {
    setPreviewSlug(item.slug);
  };

  const selectedCategory = resolveTemplatePickerCategory({
    category,
    hasPptTab,
    hasIllustrationTab,
    hasVideoTab,
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (isPreviewing) {
            setPreviewSlug(null);
            return;
          }
          onClose();
        }
      }}
    >
      <DialogContent
        className={dialogContentClassName}
        aria-describedby={undefined}
      >
        {previewItem ? (
          <TemplatePreviewPage
            item={previewItem}
            onBack={() => {
              setPreviewSlug(null);
            }}
            onSelect={handleSelectPresentation}
          />
        ) : (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
              <DialogTitle>Templates</DialogTitle>
            </DialogHeader>
            <div className="flex shrink-0 flex-col gap-3 border-b border-border px-5 pt-3 sm:flex-row sm:items-start sm:justify-between">
              <TemplatePickerTabs
                selectedCategory={selectedCategory}
                hasPptTab={hasPptTab}
                hasIllustrationTab={hasIllustrationTab}
                hasVideoTab={hasVideoTab}
                onChange={setCategory}
              />
              <div className="w-full pb-3 sm:w-64">
                <div className="relative">
                  <IconSearch
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    stroke={1.8}
                  />
                  <Input
                    aria-label="Search templates"
                    className="h-8 pl-9 text-sm"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                    placeholder="Search templates"
                  />
                </div>
              </div>
            </div>
            {selectedCategory === "slides" && hasPptTab && (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
                {filteredPptItems.length > 0 ? (
                  <PptTemplateGrid
                    items={filteredPptItems}
                    value={value}
                    onSelect={handleSelectPresentation}
                    onPreview={handlePreview}
                  />
                ) : (
                  <TemplateEmptyPanel
                    title="No matches"
                    description="Try a different search."
                  />
                )}
              </div>
            )}
            {selectedCategory === "illustration" && (
              <div
                data-illustration-template-grid-scroll=""
                className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
              >
                {filteredIllustrationItems.length > 0 ? (
                  <IllustrationTemplateGrid
                    items={filteredIllustrationItems}
                    value={value}
                    variantIndexBySlug={illustrationVariantIndex}
                    onSelect={handleSelectIllustration}
                    onVariantChange={setIllustrationVariantIndex}
                  />
                ) : (
                  <TemplateEmptyPanel
                    title="No matches"
                    description="Try a different search."
                  />
                )}
              </div>
            )}
            {selectedCategory === "video" && hasVideoTab && (
              <div
                data-video-template-grid-scroll=""
                className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4"
              >
                {filteredVideoItems.length > 0 ? (
                  <VideoTemplateGrid
                    items={filteredVideoItems}
                    value={value}
                    onSelect={handleSelectVideo}
                  />
                ) : (
                  <TemplateEmptyPanel
                    title="No matches"
                    description="Try a different search."
                  />
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SelectedTemplateChip({
  item,
  onOpen,
  onRemove,
}: {
  item: PresentationTemplateItem;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const label = item.title;
  return (
    <div className="px-4 pt-3">
      <div className="flex">
        <div className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg border border-border/80 bg-background/90 pl-1 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
          <button
            type="button"
            aria-label={`Preview template ${label}`}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpen}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
              <img
                src={r2ImageTransformUrl(
                  item.previewImage,
                  SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE,
                )}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </span>
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
              Presentation
            </span>
            <span className="h-3.5 w-px shrink-0 bg-border/70" />
            <span className="min-w-0 truncate text-xs font-medium">
              {label}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Remove template ${label}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRemove}
          >
            <IconX size={14} stroke={1.8} />
          </button>
        </div>
      </div>
      <div className="mt-3 h-px bg-border/50" />
    </div>
  );
}

function SelectedVideoTemplateChip({
  item,
  onOpen,
  onRemove,
}: {
  item: VideoTemplateItem;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="px-4 pt-3">
      <div className="flex">
        <div className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg border border-border/80 bg-background/90 pl-1 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
          <button
            type="button"
            aria-label={`Preview video template ${item.title}`}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpen}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
              <IconVideo
                size={12}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </span>
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
              Video
            </span>
            <span className="h-3.5 w-px shrink-0 bg-border/70" />
            <span className="min-w-0 truncate text-xs font-medium">
              {item.title}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Remove video template ${item.title}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRemove}
          >
            <IconX size={14} stroke={1.8} />
          </button>
        </div>
      </div>
      <div className="mt-3 h-px bg-border/50" />
    </div>
  );
}

function SelectedIllustrationTemplateChip({
  item,
  onOpen,
  onRemove,
}: {
  item: IllustrationTemplateItem;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="px-4 pt-3">
      <div className="flex">
        <div className="inline-flex h-8 max-w-full items-center gap-1 rounded-lg border border-border/80 bg-background/90 pl-1 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
          <button
            type="button"
            aria-label={`Preview template ${item.title}`}
            className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpen}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
              <img
                src={r2ImageTransformUrl(
                  item.previewImage,
                  SELECTED_TEMPLATE_CHIP_PREVIEW_SIZE,
                )}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            </span>
            <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
              Illustration
            </span>
            <span className="h-3.5 w-px shrink-0 bg-border/70" />
            <span className="min-w-0 truncate text-xs font-medium">
              {item.title}
            </span>
          </button>
          <button
            type="button"
            aria-label={`Remove template ${item.title}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRemove}
          >
            <IconX size={14} stroke={1.8} />
          </button>
        </div>
      </div>
      <div className="mt-3 h-px bg-border/50" />
    </div>
  );
}

function SelectedTemplateChipSlot({
  picker,
  onDraftChange,
}: {
  picker: ComposerTemplatePicker | undefined;
  onDraftChange: (() => void) | undefined;
}) {
  const setOpen = useSet(setTemplatePickerOpen$);
  const setCategory = useSet(setTemplatePickerCategory$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const presentationItem = selectedPresentationTemplateItem(picker?.value);
  const illustrationItem = selectedIllustrationTemplateItem(picker?.value);
  const videoItem = selectedVideoTemplateItem(picker?.value);
  if (!picker) {
    return null;
  }
  // Reopen the picker on the tab matching the selected template's type so the
  // user can re-preview and switch styles. Mirrors TemplatePickerButton's reset.
  const openPicker = (category: string) => {
    setSearch("");
    setPreviewSlug(null);
    setCategory(category);
    setOpen(true);
  };
  if (presentationItem) {
    return (
      <SelectedTemplateChip
        item={presentationItem}
        onOpen={() => {
          return openPicker("slides");
        }}
        onRemove={() => {
          picker.onChange(undefined);
          onDraftChange?.();
        }}
      />
    );
  }
  if (videoItem) {
    return (
      <SelectedVideoTemplateChip
        item={videoItem}
        onOpen={() => {
          return openPicker("video");
        }}
        onRemove={() => {
          picker.onChange(undefined);
          onDraftChange?.();
        }}
      />
    );
  }
  if (illustrationItem) {
    return (
      <SelectedIllustrationTemplateChip
        item={illustrationItem}
        onOpen={() => {
          return openPicker("illustration");
        }}
        onRemove={() => {
          picker.onChange(undefined);
          onDraftChange?.();
        }}
      />
    );
  }
  return null;
}

function TemplatePickerButton({
  picker,
  hasPptTab,
  presentationItems,
  hasIllustrationTab,
  hasVideoTab,
}: {
  picker: ComposerTemplatePicker;
  hasPptTab: boolean;
  presentationItems: readonly PresentationTemplateItem[];
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
}) {
  const open = useGet(templatePickerOpen$);
  const setOpen = useSet(setTemplatePickerOpen$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const selectedTitle = selectedTemplateTitle(picker.value);

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200 hover:bg-accent hover:text-foreground sm:h-9 sm:w-9",
                picker.value && "bg-accent text-foreground",
              )}
              aria-label="Template"
              aria-pressed={picker.value !== undefined}
              onClick={() => {
                setSearch("");
                setPreviewSlug(null);
                setOpen(true);
              }}
            >
              <img
                src={templatePickerIcon}
                alt=""
                role="presentation"
                className="h-[32px] w-[32px] object-contain"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {selectedTitle ? `Template: ${selectedTitle}` : "Template"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {open && (
        <TemplatePickerDialog
          value={picker.value}
          onChange={picker.onChange}
          onClose={() => {
            setOpen(false);
          }}
          hasPptTab={hasPptTab}
          presentationItems={presentationItems}
          hasIllustrationTab={hasIllustrationTab}
          hasVideoTab={hasVideoTab}
        />
      )}
    </>
  );
}

function ComposerTemplatePickerSlot({
  picker,
}: {
  picker: ComposerTemplatePicker | undefined;
}) {
  const features = useLastResolved(featureSwitch$);
  const hasChatTemplatePicker = Boolean(
    features?.[FeatureSwitchKey.ChatTemplatePicker],
  );
  const hasPptTab = hasChatTemplatePicker;
  const hasIllustrationTab = hasChatTemplatePicker;
  const hasVideoTab = Boolean(features?.[FeatureSwitchKey.VideoTemplatePicker]);
  const useNewPresentationTemplates = Boolean(
    features?.[FeatureSwitchKey.ChatNewPresentationTemplates],
  );
  const presentationItems = presentationTemplatePickerItems(
    useNewPresentationTemplates,
  );
  if (!picker || (!hasChatTemplatePicker && !hasVideoTab)) {
    return null;
  }
  return (
    <TemplatePickerButton
      picker={picker}
      hasPptTab={hasPptTab}
      presentationItems={presentationItems}
      hasIllustrationTab={hasIllustrationTab}
      hasVideoTab={hasVideoTab}
    />
  );
}

function ConnectorTriggerIcons({
  connectors,
  hasComputerUse,
}: {
  connectors: ComposerConnectorItem[];
  hasComputerUse: boolean;
}) {
  const enabled = connectors
    .filter((c) => {
      return c.authorized;
    })
    .slice(0, 3);
  if (enabled.length === 0 && !hasComputerUse) {
    return <IconPlug size={18} stroke={1.5} />;
  }
  return (
    <span className="flex items-center -space-x-2 sm:-space-x-1.5">
      {enabled.map((c) => {
        return (
          <span key={c.type} className="relative shrink-0">
            <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-background zero-border sm:h-7 sm:w-7">
              <ConnectorIcon type={c.type} size={16} />
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
    </span>
  );
}

function AddConnectorsDialog({
  unconnected,
  pollingType,
  onClose,
  onSelect,
}: {
  unconnected: ConnectorTypeWithStatus[];
  pollingType: string | null;
  onClose: () => void;
  onSelect: (type: ConnectorType) => void;
}) {
  const search = useGet(addDialogSearch$);
  const setSearch = useSet(setAddDialogSearch$);
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
        className="max-w-2xl flex flex-col max-h-[80vh]"
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
                <button
                  type="button"
                  key={item.type}
                  onClick={() => {
                    return onSelect(item.type);
                  }}
                  disabled={pollingType === item.type}
                  aria-label={`Connect ${item.label}`}
                  className="rounded-lg bg-card overflow-hidden transition-colors hover:bg-muted/30 cursor-pointer text-left w-full"
                  style={{ border: "0.7px solid hsl(var(--gray-400))" }}
                >
                  <div className="flex items-center gap-2.5 px-4 pt-4 pb-1">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      <ConnectorIcon type={item.type} size={20} />
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
                      {item.label}
                    </span>
                    {pollingType === item.type ? (
                      <IconLoader2
                        size={16}
                        stroke={1.5}
                        className="shrink-0 text-muted-foreground animate-spin"
                      />
                    ) : (
                      <span className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
                        <IconPlus size={14} stroke={1.5} />
                      </span>
                    )}
                  </div>
                  <div className="px-4 pb-4 pt-1">
                    <div className="text-xs text-muted-foreground line-clamp-2">
                      {item.helpText}
                    </div>
                  </div>
                </button>
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
    <div className="border-t border-border/50 py-1">
      <PopoverClose asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
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
      {computerUse.loading ? (
        <div className="flex flex-col animate-pulse">
          {Array.from({ length: 2 }, (_, i) => {
            return (
              <div key={i} className="flex items-center gap-2 px-3 py-2">
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
                className={cn(
                  "flex items-center gap-2 px-3 py-2 transition-colors",
                  checked ? "bg-primary/5" : "hover:bg-muted/50",
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
                <LoadingSwitch
                  checked={checked}
                  onCheckedChange={onDomEventFn((nextChecked) => {
                    computerUse.onChange(nextChecked ? host.id : null);
                  })}
                  loading={false}
                  ariaLabel={`${checked ? "Disconnect" : "Connect"} ${host.displayName}`}
                  size="sm"
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="px-3 py-2 text-sm text-muted-foreground">
          No online computers
        </div>
      )}
    </div>
  );
}

function ConnectorsPopoverButton({
  agentConnectors,
  connectorsLoading,
  savingType,
  computerUse,
  onOpenAddDialog,
  onToggle,
}: {
  agentConnectors: ComposerConnectorItem[];
  connectorsLoading: boolean;
  savingType: string | null;
  computerUse: ComposerComputerUse | undefined;
  onOpenAddDialog: () => void;
  onToggle: (type: ConnectorType, checked: boolean) => void | Promise<void>;
}) {
  const search = useGet(popoverSearch$);
  const setSearch = useSet(setPopoverSearch$);
  const sortOrder = useGet(popoverSortOrder$);
  const setSortOrder = useSet(setPopoverSortOrder$);
  const downloadDialogOpen = useGet(computerUseDownloadDialogOpen$);
  const setDownloadDialogOpen = useSet(setComputerUseDownloadDialogOpen$);
  const showSearch = agentConnectors.length > 20;

  // Use snapshot order if available, otherwise sort by added status
  const sorted = sortOrder
    ? [...agentConnectors].sort((a, b) => {
        const ai = sortOrder.indexOf(a.type);
        const bi = sortOrder.indexOf(b.type);
        return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      })
    : [...agentConnectors].sort((a, b) => {
        return Number(b.authorized) - Number(a.authorized);
      });

  const visibleConnectors =
    showSearch && search.trim()
      ? sorted.filter((c) => {
          return matchesConnectorSearch(search, c);
        })
      : sorted;

  const handleOpenChange = (open: boolean) => {
    if (open) {
      // Snapshot the sort order when popover opens
      const freshSort = [...agentConnectors]
        .sort((a, b) => {
          return Number(b.authorized) - Number(a.authorized);
        })
        .map((c) => {
          return c.type;
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
                className="inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg px-1 transition-colors hover:bg-accent sm:h-9 sm:min-w-9 sm:px-1.5"
                aria-label="Connectors"
              >
                <ConnectorTriggerIcons
                  connectors={agentConnectors}
                  hasComputerUse={Boolean(computerUse?.selectedHostId)}
                />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            Connectors
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="top" align="start" className="w-72 p-0 rounded-lg">
        {(agentConnectors.length > 0 || connectorsLoading) && (
          <div className="py-1">
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
              <div className="flex flex-col max-h-72 overflow-y-auto">
                {visibleConnectors.map((item) => {
                  return (
                    <label
                      key={item.type}
                      className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <ConnectorIcon type={item.type} size={16} />
                      </span>
                      <span className="text-sm flex-1 truncate text-foreground">
                        {item.label}
                      </span>
                      <LoadingSwitch
                        checked={item.authorized}
                        onCheckedChange={onDomEventFn(async (checked) => {
                          await onToggle(item.type, checked);
                        })}
                        loading={savingType === item.type}
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
        {computerUse && (
          <ComputerUseConnectorMenuSection
            computerUse={computerUse}
            onOpenDownloadDialog={() => {
              setDownloadDialogOpen(true);
            }}
          />
        )}
        <div className="border-t border-border/50 p-1 flex flex-col">
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => {
              return onOpenAddDialog();
            }}
          >
            <IconPlug
              size={18}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            Add connectors
          </button>
        </div>
      </PopoverContent>
      {computerUse && (
        <ComputerUseDownloadDialog
          open={downloadDialogOpen}
          onOpenChange={setDownloadDialogOpen}
          downloadUrl={computerUse.downloadUrl}
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-gray-50 text-muted-foreground">
              <IconDeviceDesktop size={18} stroke={1.5} />
            </div>
            <div className="min-w-0 space-y-1 text-left">
              <DialogTitle>Connect your computer</DialogTitle>
              <DialogDescription>
                Download Zero Computer Use for macOS, then open it to let Zero
                use your desktop.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <Button asChild className="mt-2 w-full">
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
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Voice input mic button
// ---------------------------------------------------------------------------

function MicButton({
  onTranscribed,
}: {
  onTranscribed: (text: string) => void;
}) {
  const available = useLastResolved(audioInputAvailable$) ?? false;
  const quota = useLastResolved(audioInputQuota$) ?? null;
  const recording = useGet(sttRecording$);
  const transcribing = useGet(sttTranscribing$);
  const startRec = useSet(startRecording$);
  const stopAndTranscribe = useSet(stopAndTranscribe$);
  const setTab = useSet(setActiveOrgManageTab$);
  const setSubPage = useSet(setBillingSubPage$);
  const openOrgManage = useSet(setOrgManageDialogOpen$);
  const signal = useGet(pageSignal$);

  if (!available) {
    return null;
  }

  const handleClick = () => {
    if (transcribing) {
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
    } else {
      if (quota && !quota.allowed) {
        setTab("billing");
        setSubPage(true);
        detach(openOrgManage(true, signal), Reason.DomCallback);
        return;
      }
      detach(startRec(signal), Reason.DomCallback);
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex shrink-0 items-center justify-center rounded-lg transition-colors",
              recording || transcribing
                ? "gap-[3px] h-9 w-[52px] bg-[#2E9E9F] text-white hover:bg-[#279394]"
                : "h-9 w-9 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={handleClick}
            disabled={transcribing}
            aria-label={
              recording
                ? "Stop recording"
                : transcribing
                  ? "Transcribing"
                  : "Voice input"
            }
          >
            {transcribing ? (
              <>
                <span className="mic-eq-dot" />
                <span className="mic-eq-dot" />
                <span className="mic-eq-dot" />
              </>
            ) : recording ? (
              <>
                <span className="mic-eq-bar" />
                <span className="mic-eq-bar" />
                <IconMicrophone size={16} stroke={1.5} />
                <span className="mic-eq-bar" />
                <span className="mic-eq-bar" />
              </>
            ) : (
              <IconMicrophone size={18} stroke={1.5} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {recording
            ? "Stop recording"
            : transcribing
              ? "Transcribing..."
              : "Voice input"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Signal resolution — resolves draft/file-input with singleton fallback
// ---------------------------------------------------------------------------

function useResolvedComposerSignals(
  input: string,
  draft: DraftSignals | undefined,
  composerFileInputProp$: Computed<HTMLElement | null> | undefined,
  setComposerFileInputProp$:
    | Command<(() => void) | undefined, [HTMLElement | null]>
    | undefined,
) {
  const attachments = useGet(
    draft ? draft.attachments$ : singletonAttachments$,
  );
  const attachmentUploadSummary = useLoadable(
    draft ? draft.attachmentUploadSummary$ : singletonAttachmentUploadSummary$,
  );
  const canSendSingleton = useGet(singletonCanSend$);
  const canSend = draft
    ? input.trim() !== "" || attachments.length > 0
    : canSendSingleton;
  const uploadAttachment = useSet(
    draft ? draft.uploadAttachment$ : singletonUpload$,
  );
  const restoreAttachments = useSet(
    draft ? draft.restoreAttachments$ : singletonRestore$,
  );
  const removeAttachment = useSet(
    draft ? draft.removeAttachment$ : singletonRemove$,
  );
  const fileInputEl = useGet(
    composerFileInputProp$ ?? singletonComposerFileInput$,
  );
  const setFileInputEl = useSet(
    setComposerFileInputProp$ ?? singletonSetComposerFileInput$,
  );
  const dragOver = useGet(draft ? draft.dragOver$ : singletonDragOver$);
  const setDragOver = useSet(
    draft ? draft.setDragOver$ : singletonSetDragOver$,
  );

  return {
    canSend,
    attachments,
    attachmentUploadSummary,
    uploadAttachment,
    restoreAttachments,
    removeAttachment,
    fileInputEl,
    setFileInputEl,
    dragOver,
    setDragOver,
  };
}

function insertPastedText(
  target: HTMLElement,
  currentValue: string,
  pastedText: string,
): string {
  // Only the plain textarea supports caret-based insertion. The TipTap composer
  // inserts pasted text itself, so for it we leave the value unchanged here.
  if (!pastedText || !(target instanceof HTMLTextAreaElement)) {
    return currentValue;
  }
  const start = target.selectionStart;
  const end = target.selectionEnd;
  return `${currentValue.slice(0, start)}${pastedText}${currentValue.slice(end)}`;
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

type KeyboardSendAction = "none" | "send" | "queue";

function ComposerTextarea({
  input,
  onInputChange,
  sending,
  autoFocus,
  setInputRef,
  onKeyDown,
  onPaste,
  onAfterInputChange,
  onPointerSelectionChange,
}: {
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly sending: boolean | undefined;
  readonly autoFocus: boolean | undefined;
  readonly setInputRef: ((el: HTMLElement | null) => void) | undefined;
  readonly onKeyDown: (e: KeyboardEventLike) => void;
  readonly onPaste: (e: ComposerPasteEvent) => void;
  readonly onAfterInputChange?: (textarea: HTMLTextAreaElement) => void;
  readonly onPointerSelectionChange?: (textarea: HTMLTextAreaElement) => void;
}) {
  return (
    <textarea
      ref={(el) => {
        if (el && autoFocus && !isIOSDevice()) {
          el.focus();
        }
        setInputRef?.(el);
      }}
      className={cn(
        "relative z-10 w-full resize-none bg-transparent px-4 pt-4 pb-0 text-[0.9375rem] leading-6 text-foreground caret-foreground placeholder:text-muted-foreground/40 border-0 focus:outline-none focus:ring-0 min-h-[96px] selection:bg-primary/20",
      )}
      rows={3}
      placeholder={
        sending
          ? "Type your next message\u2026"
          : "Ask me to automate workflows, manage tasks..."
      }
      value={input}
      onChange={(e) => {
        onInputChange(e.target.value);
        onAfterInputChange?.(e.target);
      }}
      onClick={(e) => {
        onPointerSelectionChange?.(e.currentTarget);
      }}
      onKeyUp={(e) => {
        onPointerSelectionChange?.(e.currentTarget);
      }}
      onSelect={(e) => {
        onPointerSelectionChange?.(e.currentTarget);
      }}
      enterKeyHint="enter"
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  );
}

function ComposerInputSlot({
  input,
  onInputChange,
  onDraftChange,
  sending,
  autoFocus,
  setInputRef,
  onKeyDown,
  onPaste,
}: {
  readonly input: string;
  readonly onInputChange: (value: string) => void;
  readonly onDraftChange: (() => void) | undefined;
  readonly sending: boolean | undefined;
  readonly autoFocus: boolean | undefined;
  readonly setInputRef: ((el: HTMLElement | null) => void) | undefined;
  readonly onKeyDown: (e: KeyboardEventLike) => void;
  readonly onPaste: (e: ComposerPasteEvent) => void;
}) {
  const features = useLastResolved(featureSwitch$);
  const slashWorkflowCommandsEnabled =
    features?.[FeatureSwitchKey.ChatSlashWorkflowCommands] ?? false;

  if (slashWorkflowCommandsEnabled) {
    return (
      <TiptapWorkflowComposer
        input={input}
        onInputChange={onInputChange}
        onDraftChange={onDraftChange}
        sending={sending}
        autoFocus={autoFocus}
        setInputRef={setInputRef}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    );
  }

  return (
    <div className="relative min-h-[96px]">
      <ComposerTextarea
        input={input}
        onInputChange={onInputChange}
        sending={sending}
        autoFocus={autoFocus}
        setInputRef={setInputRef}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
    </div>
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

function resolveActiveFeedback(
  feedback: ComposerFeedback | undefined,
): ComposerFeedback | null {
  if (feedback && feedback.items.length > 0) {
    return feedback;
  }
  return null;
}

// Stop while an empty composer is mid-run; otherwise Send. In feedback mode the
// same button dispatches the feedback turn and stays disabled until a note is
// written.
function ComposerSendButton({
  showStopButton,
  onCancel,
  activeFeedback,
  sendAction,
  onSend,
}: {
  showStopButton: boolean;
  onCancel: (() => void) | undefined;
  activeFeedback: ComposerFeedback | null;
  sendAction: KeyboardSendAction;
  onSend: () => void;
}) {
  if (showStopButton && !activeFeedback) {
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
  if (activeFeedback) {
    return (
      <Button
        size="sm"
        className="rounded-lg h-9 w-9 p-0 shrink-0"
        onClick={activeFeedback.onSubmit}
        disabled={activeFeedback.sendCount === 0}
        aria-label="Send feedback"
      >
        <IconArrowUp size={18} stroke={2} />
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
  actionsLoading,
  modelPicker,
  modelPickerLoading,
  submitBlocker,
  modelPickerOpen,
  onModelPickerChange,
  onModelPickerOpenChange,
}: {
  actionsLoading: boolean;
  modelPicker: ComposerModelPicker | undefined;
  modelPickerLoading: boolean;
  submitBlocker: ZeroChatComposerProps["submitBlocker"];
  modelPickerOpen: boolean;
  onModelPickerChange: (value: ModelProviderSelection | null) => void;
  onModelPickerOpenChange: (open: boolean) => void;
}) {
  if (actionsLoading) {
    return (
      <Skeleton
        className={cn(
          "h-9 rounded-md",
          modelPicker || modelPickerLoading ? "w-[184px]" : "w-20",
        )}
      />
    );
  }

  if (modelPickerLoading) {
    return <Skeleton className="h-9 w-9 rounded-md sm:w-32" />;
  }

  return (
    <>
      {submitBlocker && <ModelConfigurationWarning blocker={submitBlocker} />}
      {modelPicker && (
        <ModelProviderPicker
          value={modelPicker.value}
          onChange={onModelPickerChange}
          placeholder="Default"
          triggerClassName={cn(
            "h-9 w-9 max-w-none gap-0 border-transparent bg-transparent px-0 text-sm text-muted-foreground transition-colors sm:w-auto sm:max-w-[14rem] sm:gap-1 sm:px-2",
            "[&>span]:flex [&>span]:items-center [&>span]:justify-center sm:[&>span]:justify-start [&>svg]:hidden sm:[&>svg]:block",
            "hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
          )}
          compactTrigger
          mobileIconTrigger
          open={modelPickerOpen}
          onOpenChange={onModelPickerOpenChange}
          disabled={modelPicker.disabled}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

export function ZeroChatComposer({
  input,
  onInputChange,
  onSend,
  onQueue,
  sending,
  queueWhileSending = false,
  onCancel,
  displayName,
  className,
  autoFocus,
  draft,
  composerFileInput$: composerFileInputProp$,
  setComposerFileInput$: setComposerFileInputProp$,
  setInputRef,
  onDraftChange,
  actionsLoading = false,
  modelPicker,
  templatePicker,
  computerUse,
  modelPickerLoading = false,
  submitBlocker,
  queuedItems,
  onRemoveQueuedItem,
  feedback,
}: ZeroChatComposerProps) {
  const showAddDialog = useGet(showAddDialog$);
  const setShowAddDialog = useSet(setShowAddDialog$);
  const modelPickerOpen = useGet(modelPickerOpen$);
  const setModelPickerOpen = useSet(setModelPickerOpen$);

  const resolved = useResolvedComposerSignals(
    input,
    draft,
    composerFileInputProp$,
    setComposerFileInputProp$,
  );
  const {
    canSend: draftCanSend,
    attachments,
    attachmentUploadSummary,
    uploadAttachment,
    restoreAttachments,
    removeAttachment,
    fileInputEl,
    setFileInputEl,
    dragOver,
    setDragOver,
  } = resolved;

  const ensurePushSubscription = useSet(ensurePushSubscription$);
  const rootSignal = useGet(rootSignal$);
  const visualAttachmentUnsupported =
    getVisualAttachmentUnsupportedState(modelPicker);
  const visibleAttachments = resolveVisibleAttachments(
    attachments,
    visualAttachmentUnsupported,
  );
  const canSend = resolveComposerCanSend({
    draftCanSend,
    input,
    visibleAttachmentCount: visibleAttachments.length,
    uploadsReady:
      attachmentUploadSummary.state === "hasData" &&
      attachmentUploadSummary.data.readyCount ===
        attachmentUploadSummary.data.attachmentCount,
  });
  const canSubmit = canSend && !submitBlocker;

  // When feedback fragments are present the composer is in "feedback mode": the
  // textarea is replaced by the stacked quote + note rows and Send dispatches
  // the feedback turn instead of the draft.
  const activeFeedback = resolveActiveFeedback(feedback);

  // File upload handlers (paste / drag-drop)
  const handlePaste = (e: ComposerPasteEvent) => {
    if (!e.clipboardData) {
      return;
    }
    const chatPayload = readChatMessageFromClipboard(e.clipboardData);
    if (chatPayload && chatPayload.attachments.length > 0) {
      const persistedAttachments = toPersistedAttachments(
        chatPayload.attachments,
      );
      if (persistedAttachments.length > 0) {
        const allowedAttachments = visualAttachmentUnsupported
          ? persistedAttachments.filter((attachment) => {
              return !isVisualAttachment({
                contentType: attachment.contentType,
                filename: attachment.filename,
              });
            })
          : persistedAttachments;
        if (allowedAttachments.length < persistedAttachments.length) {
          showVisualAttachmentUnsupportedToast(visualAttachmentUnsupported!);
        }
        e.preventDefault();
        const nextInput = insertPastedText(
          e.currentTarget,
          input,
          chatPayload.text,
        );
        if (nextInput !== input) {
          onInputChange(nextInput);
        }
        if (allowedAttachments.length > 0) {
          restoreAttachments(allowedAttachments);
        }
        onDraftChange?.();
        return;
      }
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
      const nextInput = insertPastedText(e.currentTarget, input, plainText);
      if (nextInput !== input) {
        onInputChange(nextInput);
      }
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
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const authorizedConnectorsLoadable = useLastLoadable(
    zeroAuthorizedConnectors$,
  );
  const pageSignal = useGet(pageSignal$);
  const selectedConnType = useGet(selectedConnectorType$);
  const pendingConnectType = useGet(pendingConnectType$);
  const setPendingConnectType = useSet(setPendingConnectType$);
  const setSelectedConnType = useSet(setSelectedConnectorType$);
  const pollingConnType = useGet(pollingOAuthAuthCodeConnectorType$);
  const authorizeFn = useSet(authorizeConnector$);
  const deauthorizeFn = useSet(deauthorizeConnector$);
  const optimisticConnected = useGet(justConnectedTypes$);

  const savingType = useGet(composerSavingType$);
  const setSavingType = useSet(setComposerSavingType$);

  const connectorsLoading =
    allTypesLoadable.state !== "hasData" ||
    authorizedConnectorsLoadable.state !== "hasData";

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const connectorMap = new Map(
    allConnectors.map((c) => {
      return [c.type, c];
    }),
  );
  const authorizedConnectors =
    authorizedConnectorsLoadable.state === "hasData"
      ? authorizedConnectorsLoadable.data
      : [];
  const authorizedSet = new Set(authorizedConnectors);

  const unconnectedConnectors = allConnectors.filter((c) => {
    return !c.connected;
  });

  // Show all org-connected services so user can toggle authorization on/off per agent.
  // available = connected ∧ authorized → the connector is actually usable in this agent.
  const connectedTypes = allConnectors.filter((c) => {
    return c.connected || optimisticConnected.has(c.type);
  });
  const agentConnectors: ComposerConnectorItem[] = connectedTypes.map((c) => {
    const connected = c.connected || optimisticConnected.has(c.type);
    const authorized = authorizedSet.has(c.type);
    return {
      type: c.type,
      label: c.label,
      helpText: c.helpText,
      tags: c.tags,
      connected,
      authorized,
      available: connected && authorized,
    };
  });

  const handleConnectSuccess = async (type: ConnectorType) => {
    const label = connectorMap.get(type)!.label;
    await tapError(authorizeFn(type, pageSignal), () => {
      toast.error(`${label} was authorized but could not be saved`, {
        id: `connector-save-error-${type}`,
      });
    });
    toast.success(`${label} connected and authorized for ${displayName}`, {
      id: `connector-connected-${type}`,
    });
  };

  const handleToggle = async (type: ConnectorType, checked: boolean) => {
    setSavingType(type);
    await bestEffort(
      checked ? authorizeFn(type, pageSignal) : deauthorizeFn(type, pageSignal),
    );
    setSavingType(null);
  };

  const sendAction = resolveKeyboardSendAction({
    canSend: canSubmit,
    sending,
    queueWhileSending,
    hasQueueHandler: onQueue !== undefined,
  });

  const handleSend = () => {
    if (sendAction === "send") {
      // Fire-and-forget: request push permission on first send, never blocks
      detach(ensurePushSubscription(rootSignal), Reason.DomCallback);
      onSend(input.trim(), templatePicker?.value);
      return;
    }
    if (sendAction === "queue") {
      onQueue?.(input.trim(), templatePicker?.value);
    }
  };

  // Stop button replaces Send only when there is nothing to dispatch — i.e.
  // the composer is empty during an active run. With draft content present
  // the Send button stays visible so the click can queue the message.
  const showStopButton = Boolean(sending && onCancel) && !canSend;

  // Routes a button click to the queue path while the current thread is sending,
  // otherwise to the normal send path.
  const handleButtonSend = () => {
    if (submitBlocker) {
      return;
    }
    if (sending && queueWhileSending && onQueue) {
      onQueue(input.trim(), templatePicker?.value);
    } else {
      handleSend();
    }
  };

  const sendModeLoadable = useLastLoadable(sendMode$);
  const sendMode =
    sendModeLoadable.state === "hasData" ? sendModeLoadable.data : "enter";
  const toggleSidebar = useSet(toggleSidebarOff$);
  const newChat = useSet(navigateToNewChat$);

  const handleKeyDown = (e: KeyboardEventLike) => {
    if (window.matchMedia("(pointer: coarse)").matches) {
      return;
    }
    const send = () => {
      handleSend();
    };
    processShortcut(
      {
        ...(sendMode === "enter" ? { enter: send } : { "mod+enter": send }),
        escape: () => {
          (e.target as HTMLElement).blur();
        },
        "mod+b": () => {
          toggleSidebar();
        },
        "mod+shift+o": () => {
          detach(newChat(pageSignal), Reason.DomCallback);
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
        <QueuedMessagesStrip
          items={queuedItems}
          onRemove={onRemoveQueuedItem}
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
              {/* Template + attachment chips are shared by both modes: a feedback
                  turn can also carry a template or attachments, so they render
                  above the feedback rows just as they do above the textarea. */}
              <SelectedTemplateChipSlot
                picker={templatePicker}
                onDraftChange={onDraftChange}
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
              {activeFeedback ? (
                <ComposerFeedbackRows feedback={activeFeedback} />
              ) : (
                <>
                  <ComposerInputSlot
                    input={input}
                    onInputChange={onInputChange}
                    onDraftChange={onDraftChange}
                    sending={sending}
                    autoFocus={autoFocus}
                    setInputRef={setInputRef}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                  />
                </>
              )}
              <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-1">
                <div className="flex items-center gap-1 text-muted-foreground sm:gap-1.5">
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="rounded-lg p-2 transition-colors duration-200 hover:bg-accent hover:text-foreground sm:p-[9px]"
                          aria-label="Attach"
                          onClick={handleFileSelect}
                        >
                          <IconPaperclip size={18} stroke={1.5} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        Attach
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <ConnectorsPopoverButton
                    agentConnectors={agentConnectors}
                    connectorsLoading={connectorsLoading}
                    savingType={savingType}
                    computerUse={computerUse}
                    onOpenAddDialog={() => {
                      return setShowAddDialog(true);
                    }}
                    onToggle={handleToggle}
                  />
                  <ComposerTemplatePickerSlot picker={templatePicker} />
                </div>
                <div className="flex items-center gap-1 sm:gap-2">
                  <ComposerModelPickerSlot
                    actionsLoading={actionsLoading}
                    modelPicker={modelPicker}
                    modelPickerLoading={modelPickerLoading}
                    submitBlocker={submitBlocker}
                    modelPickerOpen={modelPickerOpen}
                    onModelPickerChange={handleModelPickerChange}
                    onModelPickerOpenChange={setModelPickerOpen}
                  />
                  {actionsLoading ? null : (
                    <>
                      <div className="mx-0 h-5 w-px bg-border/60 sm:mx-0.5" />
                      <MicButton
                        onTranscribed={(text) => {
                          const base = input;
                          const separator =
                            base.length > 0 && !base.endsWith(" ") ? " " : "";
                          onInputChange(base + separator + text);
                          onDraftChange?.();
                        }}
                      />
                      <ComposerSendButton
                        showStopButton={showStopButton}
                        onCancel={onCancel}
                        activeFeedback={activeFeedback}
                        sendAction={sendAction}
                        onSend={handleButtonSend}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      {selectedConnType && (
        <ConnectModal
          onClose={() => {
            return setSelectedConnType(null);
          }}
          onSuccess={async () => {
            const type = pendingConnectType ?? selectedConnType;
            if (type && !authorizedSet.has(type)) {
              await handleConnectSuccess(type);
            }
            setPendingConnectType(null);
            setShowAddDialog(false);
          }}
        />
      )}
      {showAddDialog && (
        <AddConnectorsDialog
          unconnected={unconnectedConnectors}
          pollingType={pollingConnType}
          onClose={() => {
            return setShowAddDialog(false);
          }}
          onSelect={(type) => {
            setPendingConnectType(type);
            setSelectedConnType(type);
          }}
        />
      )}
    </>
  );
}
