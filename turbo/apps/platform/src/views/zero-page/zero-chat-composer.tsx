// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type {
  ChangeEvent,
  ClipboardEvent,
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
  IconChevronLeft,
  IconChevronRight,
  IconDeviceDesktop,
  IconFileText,
  IconPresentation,
  IconEye,
  IconLoader2,
  IconMicrophone,
  IconPaperclip,
  IconPlayerStop,
  IconPlug,
  IconPhoto,
  IconPlus,
  IconSearch,
  IconTemplate,
  IconVideo,
  IconX,
} from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@vm0/ui/components/ui/dialog";
import {
  Button,
  Card,
  CardContent,
  Input,
  Popover,
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
import type { ZeroAgentCustomSkill } from "@vm0/api-contracts/contracts/zero-agents";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_ITEMS,
  type IllustrationTemplateItem,
  type PresentationTemplateItem,
  VIDEO_STYLE_GROUPS,
  VIDEO_STYLE_PRESETS,
  type VideoStylePreset,
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
  clearComputerUsePopoverCloseSuppression$,
  computerUsePopoverOpen$,
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
  templatePickerVideoGroup$,
  setTemplatePickerVideoGroup$,
  templatePickerPreviewSlug$,
  setTemplatePickerPreviewSlug$,
  templatePickerPreviewSlideIndex$,
  setTemplatePickerPreviewSlideIndex$,
  setComputerUsePopoverOpen$,
  templateCardHover$,
  setTemplateCardHover$,
  slashSkillCaretIndex$,
  setSlashSkillCaretIndex$,
  selectedSlashSkillIndex$,
  setSelectedSlashSkillIndex$,
  setSlashSkillMenuRef$,
  type TemplatePickerVideoGroup,
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
import { currentChatAgent$ } from "../../signals/agent-chat.ts";
import { orgSkills$ } from "../../signals/skills-page/skills-signals.ts";
import type { FeedbackItem } from "../../signals/zero-page/chat-feedback.ts";
import { Link } from "../router/link.tsx";

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
    onRefresh: () => void;
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
}

type ComposerModelPicker = NonNullable<ZeroChatComposerProps["modelPicker"]>;
type ComposerTemplatePicker = NonNullable<
  ZeroChatComposerProps["templatePicker"]
>;
type ComposerComputerUse = NonNullable<ZeroChatComposerProps["computerUse"]>;

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

function focusFeedbackNoteRef(element: HTMLTextAreaElement | null): void {
  element?.focus();
}

function ComposerFeedbackRow({
  item,
  autoFocus,
  onChangeNote,
  onRemove,
  onKeyDown,
}: {
  item: FeedbackItem;
  autoFocus: boolean;
  onChangeNote: (note: string) => void;
  onRemove: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-dashed border-border/60 py-1.5">
      <div className="flex items-center gap-2">
        <span className="h-4 w-[3px] shrink-0 bg-muted-foreground/30" />
        <span className="min-w-0 flex-1 truncate text-sm italic leading-snug text-muted-foreground">
          {item.quote}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove feedback"
          title="Remove feedback"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <IconX size={15} stroke={2} />
        </button>
      </div>
      <textarea
        ref={autoFocus ? focusFeedbackNoteRef : undefined}
        value={item.note}
        onChange={(event) => {
          return onChangeNote(event.target.value);
        }}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder="What should change about this?"
        className="w-full resize-none border-0 bg-transparent px-1 py-1 text-[0.9375rem] leading-snug text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-0"
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
    <div className="flex flex-col px-3 pb-2 pt-3">
      {feedback.items.map((item) => {
        return (
          <ComposerFeedbackRow
            key={item.id}
            item={item}
            autoFocus={item.id === newestId}
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
      <span className="px-1 pt-1.5 font-serif text-[13px] italic leading-snug text-muted-foreground/50">
        Select more text to add another comment
      </span>
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
    },
  };
}

function selectedTemplateTitle(
  value: GenerationTemplateRequest | undefined,
): string | undefined {
  if (value?.type === "video") {
    return selectedVideoTemplateItem(value)?.nameEn;
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
  return PRESENTATION_TEMPLATE_ITEMS.find((item) => {
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

function formatPresentationTemplateKind(templateId: string): string {
  const label = templateId
    .replace(/^template:/, "")
    .replace(/^html-ppt-/, "")
    .replace(/-/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatIllustrationTemplateKind(
  item: IllustrationTemplateItem,
): string {
  return `${item.variationCount} variations`;
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
  const searchable = [
    item.title,
    item.illustrationStyleId,
    formatIllustrationTemplateKind(item),
  ].join(" ");
  return searchable.toLowerCase().includes(normalizedQuery);
}

function isSelectedVideoTemplate(
  item: VideoStylePreset,
  value: GenerationTemplateRequest | undefined,
): boolean {
  return value?.type === "video" && value.selection.stylePresetId === item.id;
}

function toVideoGenerationTemplate(
  item: VideoStylePreset,
): GenerationTemplateRequest {
  return {
    type: "video",
    selection: { stylePresetId: item.id },
  };
}

function selectedVideoTemplateItem(
  value: GenerationTemplateRequest | undefined,
): VideoStylePreset | undefined {
  if (value?.type !== "video") {
    return undefined;
  }
  return VIDEO_STYLE_PRESETS.find((item) => {
    return item.id === value.selection.stylePresetId;
  });
}

function videoTemplateMatchesSearch(
  item: VideoStylePreset,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }
  const searchable = [
    item.nameEn,
    item.nameZh,
    item.category,
    item.scene,
    item.dimensions.styleReference,
  ].join(" ");
  return searchable.toLowerCase().includes(normalizedQuery);
}

function videoTemplateMatchesGroup(
  item: VideoStylePreset,
  group: TemplatePickerVideoGroup,
): boolean {
  return group === "all" || item.category === group;
}

function VideoTemplatePreview({ item }: { item: VideoStylePreset }) {
  return (
    <video
      src={item.sampleVideoUrl}
      poster={item.sampleVideoThumbnailUrl}
      className="h-full w-full object-cover"
      preload="none"
      playsInline
      muted
      loop
      onMouseEnter={(event) => {
        detach(event.currentTarget.play(), Reason.DomCallback);
      }}
      onMouseLeave={(event) => {
        const video = event.currentTarget;
        video.pause();
        video.currentTime = 0;
      }}
    />
  );
}

function VideoTemplateCard({
  item,
  selected,
  onSelect,
}: {
  item: VideoStylePreset;
  selected: boolean;
  onSelect: (item: VideoStylePreset) => void;
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
            {item.nameEn}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={`Select video style ${item.nameEn}`}
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
  items: VideoStylePreset[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: VideoStylePreset) => void;
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

function TemplateSectionHeader({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h3 className="rounded-md bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground">
        {label}
      </h3>
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
        {count}
      </span>
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

interface PresentationPreviewImageCache {
  readonly decoded: Set<string>;
  readonly pendingDecodes: Map<string, Promise<void>>;
  readonly preloads: Map<string, HTMLImageElement>;
}

function presentationPreviewImageCache(): PresentationPreviewImageCache {
  const cacheKey = "vm0PresentationPreviewImageDecodeCache";
  const existingCache = Reflect.get(globalThis, cacheKey) as
    | PresentationPreviewImageCache
    | undefined;
  if (existingCache !== undefined) {
    return existingCache;
  }

  const cache: PresentationPreviewImageCache = {
    decoded: new Set<string>(),
    pendingDecodes: new Map<string, Promise<void>>(),
    preloads: new Map<string, HTMLImageElement>(),
  };
  Reflect.set(globalThis, cacheKey, cache);
  return cache;
}

function preloadPresentationPreviewImage(
  url: string,
): HTMLImageElement | undefined {
  if (typeof Image === "undefined") {
    return undefined;
  }

  const cache = presentationPreviewImageCache();
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

function preloadPresentationPreviewImages(imageUrls: readonly string[]): void {
  for (const imageUrl of imageUrls) {
    preloadPresentationPreviewImage(imageUrl);
  }
}

async function decodePresentationPreviewImage(url: string): Promise<void> {
  const cache = presentationPreviewImageCache();
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

  const image = preloadPresentationPreviewImage(url);
  if (image === undefined) {
    return;
  }

  if (image.decode === undefined) {
    if (image.complete && image.naturalWidth > 0) {
      cache.decoded.add(url);
    }
    return;
  }

  const decode = markPresentationPreviewImageDecoded(url, image);
  cache.pendingDecodes.set(url, decode);
  await decode;
}

async function markPresentationPreviewImageDecoded(
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = presentationPreviewImageCache();
  await tapError(image.decode(), () => {});
  if (image.complete && image.naturalWidth > 0) {
    cache.decoded.add(url);
  }
  cache.pendingDecodes.delete(url);
}

function presentationPreviewImageDecoded(url: string): boolean {
  return presentationPreviewImageCache().decoded.has(url);
}

async function selectDecodedTemplatePreviewImage({
  container,
  imageUrl,
  index,
  item,
  setHover,
}: {
  container: HTMLDivElement;
  imageUrl: string;
  index: number;
  item: PresentationTemplateItem;
  setHover: (value: { readonly slug: string; readonly index: number }) => void;
}): Promise<void> {
  await decodePresentationPreviewImage(imageUrl);
  if (
    container.dataset.targetSlideIndex === String(index) &&
    presentationPreviewImageDecoded(imageUrl)
  ) {
    setHover({ slug: item.slug, index });
  }
}

async function markPresentationPreviewImageLoaded(
  url: string,
  image: HTMLImageElement,
): Promise<void> {
  const cache = presentationPreviewImageCache();
  if (image.decode !== undefined) {
    await tapError(image.decode(), () => {});
  }
  if (image.complete && image.naturalWidth > 0) {
    cache.decoded.add(url);
  }
  image.dataset.loaded = "true";
  image.parentElement
    ?.querySelector<HTMLElement>("[data-template-preview-error]")
    ?.setAttribute("hidden", "");
}

function TemplatePreview({
  item,
  onPreview,
}: {
  item: PresentationTemplateItem;
  onPreview: (item: PresentationTemplateItem) => void;
}) {
  const slideImages = presentationTemplateSlideImages(item);
  const hover = useGet(templateCardHover$);
  const setHover = useSet(setTemplateCardHover$);
  const hoverSlideIndex = hover?.slug === item.slug ? hover.index : 0;
  const previewImage = slideImages[0];
  const isHovering = hover?.slug === item.slug;

  const handleMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (slideImages.length < 2) {
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
      slideImages.length - 1,
      Math.round((offsetX / rect.width) * (slideImages.length - 1)),
    );
    if (nextIndex !== hoverSlideIndex) {
      const nextImage = slideImages[nextIndex];
      event.currentTarget.dataset.targetSlideIndex = String(nextIndex);
      if (nextIndex === 0) {
        setHover({ slug: item.slug, index: nextIndex });
        return;
      }

      if (presentationPreviewImageDecoded(nextImage)) {
        setHover({ slug: item.slug, index: nextIndex });
        return;
      }

      detach(
        selectDecodedTemplatePreviewImage({
          container: event.currentTarget,
          imageUrl: nextImage,
          index: nextIndex,
          item,
          setHover,
        }),
        Reason.DomCallback,
      );
    }
  };

  return (
    <div
      className="relative h-44 shrink-0 overflow-hidden bg-muted"
      onMouseEnter={() => {
        preloadPresentationPreviewImages(slideImages);
        detach(
          Promise.all(
            slideImages.map((imageUrl) => {
              return decodePresentationPreviewImage(imageUrl);
            }),
          ),
          Reason.DomCallback,
        );
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={(event) => {
        delete event.currentTarget.dataset.targetSlideIndex;
        setHover(null);
      }}
    >
      {previewImage ? (
        <>
          <img
            src={previewImage}
            alt=""
            title={`${item.title} card preview slide 1`}
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            onLoad={(event) => {
              event.currentTarget.parentElement
                ?.querySelector<HTMLElement>("[data-template-preview-error]")
                ?.setAttribute("hidden", "");
            }}
            onError={(event) => {
              event.currentTarget.parentElement
                ?.querySelector<HTMLElement>("[data-template-preview-error]")
                ?.removeAttribute("hidden");
            }}
          />
          {isHovering &&
            slideImages.map((imageUrl, imageIndex) => {
              const active = imageIndex > 0 && imageIndex === hoverSlideIndex;
              return (
                <img
                  key={imageUrl}
                  src={imageUrl}
                  alt=""
                  title={`${item.title} card preview slide ${
                    isHovering ? imageIndex + 1 : 1
                  }`}
                  className={cn(
                    "absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-75",
                    active && "data-[loaded=true]:opacity-100",
                  )}
                  loading={isHovering ? "eager" : "lazy"}
                  onLoad={(event) => {
                    detach(
                      markPresentationPreviewImageLoaded(
                        imageUrl,
                        event.currentTarget,
                      ),
                      Reason.DomCallback,
                    );
                  }}
                  onError={(event) => {
                    event.currentTarget.parentElement
                      ?.querySelector<HTMLElement>(
                        "[data-template-preview-error]",
                      )
                      ?.removeAttribute("hidden");
                  }}
                />
              );
            })}
          <div
            data-template-preview-error=""
            hidden
            className="absolute inset-0 flex items-center justify-center bg-muted text-muted-foreground"
          >
            <IconTemplate size={28} stroke={1.5} />
          </div>
        </>
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <IconTemplate size={28} stroke={1.5} />
        </div>
      )}
      <button
        type="button"
        aria-label={`View template ${item.title}`}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md bg-[rgba(0,0,0,.3)] text-white opacity-0 shadow-sm transition-colors hover:bg-[rgba(0,0,0,.45)] hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  selectedSlideIndex,
  onSlideChange,
  onBack,
  onSelect,
}: {
  item: PresentationTemplateItem;
  selectedSlideIndex: number;
  onSlideChange: (index: number) => void;
  onBack: () => void;
  onSelect: (item: PresentationTemplateItem) => void;
}) {
  const slideImages = presentationTemplateSlideImages(item);
  const safeSlideIndex = Math.max(
    0,
    Math.min(selectedSlideIndex, slideImages.length - 1),
  );
  const selectedSlideImage = slideImages[safeSlideIndex];
  const hasMultipleSlides = slideImages.length > 1;
  const kind = formatPresentationTemplateKind(item.templateId);

  const changeSlide = (direction: -1 | 1) => {
    if (!hasMultipleSlides) {
      return;
    }
    onSlideChange(
      (safeSlideIndex + direction + slideImages.length) % slideImages.length,
    );
  };

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
          <span className="shrink-0 text-muted-foreground">PPT</span>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="min-w-0 truncate">{item.title}</span>
        </DialogTitle>
      </DialogHeader>
      <div className="grid max-h-[72vh] gap-5 overflow-y-auto bg-muted/20 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-lg border border-border bg-background p-4">
          <div className="relative overflow-hidden rounded-lg bg-muted">
            <div className="absolute left-3 top-3 z-10 rounded-md bg-black/80 px-2 py-1 text-xs font-semibold text-white">
              {safeSlideIndex + 1} of {slideImages.length}
            </div>
            <img
              key={selectedSlideImage}
              src={selectedSlideImage}
              title={`${item.title} preview slide ${safeSlideIndex + 1}`}
              alt=""
              className="aspect-[16/9] w-full object-cover"
              loading="lazy"
            />
            <button
              type="button"
              aria-label="Previous slide"
              className="absolute left-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-background/95 text-foreground shadow-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={!hasMultipleSlides}
              onClick={() => {
                changeSlide(-1);
              }}
            >
              <IconChevronLeft size={22} stroke={1.8} />
            </button>
            <button
              type="button"
              aria-label="Next slide"
              className="absolute right-3 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-background/95 text-foreground shadow-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              disabled={!hasMultipleSlides}
              onClick={() => {
                changeSlide(1);
              }}
            >
              <IconChevronRight size={22} stroke={1.8} />
            </button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {slideImages.map((image, index) => {
              const selected = index === safeSlideIndex;
              return (
                <button
                  key={image}
                  type="button"
                  aria-label={`Show slide ${index + 1}`}
                  aria-pressed={selected}
                  className={cn(
                    "relative overflow-hidden rounded-md border bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-primary" : "border-border",
                  )}
                  onClick={() => {
                    onSlideChange(index);
                  }}
                >
                  <img
                    src={image}
                    alt=""
                    className="aspect-[16/9] w-full object-cover"
                    loading="lazy"
                  />
                  <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {index + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-background p-5">
            <h3 className="text-lg font-semibold text-foreground">
              {item.title}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {kind} · {slideImages.length} preview slides
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-5">
            <h3 className="text-sm font-semibold text-muted-foreground">
              Dials
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
                {slideImages.length} preview slides
              </span>
              <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
                Confident tone
              </span>
              <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
                Dark theme
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label={`Select template ${item.title}`}
            className="h-11 rounded-md bg-foreground px-4 text-sm font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onSelect(item);
            }}
          >
            Use this template
          </button>
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
        "group flex h-64 flex-col overflow-hidden rounded-lg border bg-card shadow-sm transition-colors hover:bg-muted/20",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <TemplatePreview item={item} onPreview={onPreview} />
      <div className="flex flex-1 items-start justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {item.title}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {formatPresentationTemplateKind(item.templateId)}
          </p>
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

function IllustrationTemplatePreview({
  item,
  onPreview,
}: {
  item: IllustrationTemplateItem;
  onPreview: (item: IllustrationTemplateItem) => void;
}) {
  return (
    <div className="relative h-44 shrink-0 overflow-hidden bg-muted">
      <img
        src={item.previewImage}
        alt=""
        title={`${item.title} illustration preview`}
        className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150 data-[loaded=true]:opacity-100"
        loading="lazy"
        decoding="async"
        fetchPriority="low"
        onLoad={(event) => {
          const image = event.currentTarget;
          detach(
            markIllustrationPreviewImageLoaded(item.previewImage, image),
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
      <button
        type="button"
        aria-label={`View template ${item.title}`}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-md bg-[rgba(0,0,0,.3)] text-white opacity-0 shadow-sm transition-colors hover:bg-[rgba(0,0,0,.45)] hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

interface IllustrationPreviewImageCache {
  readonly decoded: Set<string>;
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
  };
  Reflect.set(globalThis, cacheKey, cache);
  return cache;
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

function IllustrationTemplateCard({
  item,
  selected,
  onSelect,
  onPreview,
}: {
  item: IllustrationTemplateItem;
  selected: boolean;
  onSelect: (item: IllustrationTemplateItem) => void;
  onPreview: (item: IllustrationTemplateItem) => void;
}) {
  return (
    <div
      className={cn(
        "group flex h-64 flex-col overflow-hidden rounded-lg border bg-card shadow-sm transition-colors hover:bg-muted/20",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <IllustrationTemplatePreview item={item} onPreview={onPreview} />
      <div className="flex flex-1 items-start justify-between gap-3 px-3.5 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {item.title}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {formatIllustrationTemplateKind(item)}
          </p>
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

function IllustrationPreviewPage({
  item,
  selectedImageIndex,
  onImageChange,
  onBack,
  onSelect,
}: {
  item: IllustrationTemplateItem;
  selectedImageIndex: number;
  onImageChange: (index: number) => void;
  onBack: () => void;
  onSelect: (item: IllustrationTemplateItem) => void;
}) {
  const images = item.previewImages;
  const safeImageIndex = Math.max(
    0,
    Math.min(selectedImageIndex, images.length - 1),
  );
  const selectedImage = images[safeImageIndex];

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
          <span className="shrink-0 text-muted-foreground">Illustration</span>
          <span className="shrink-0 text-muted-foreground">/</span>
          <span className="min-w-0 truncate">{item.title}</span>
        </DialogTitle>
      </DialogHeader>
      <div className="grid h-[min(72vh,680px)] min-h-0 gap-4 overflow-hidden bg-muted/20 p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-h-0 flex-col rounded-lg border border-border bg-background p-3">
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted">
            <img
              key={selectedImage}
              src={selectedImage}
              title={`${item.title} preview variant ${safeImageIndex + 1}`}
              alt=""
              className="h-full w-full object-contain"
              loading="lazy"
            />
          </div>
          <div className="mt-3 flex shrink-0 max-w-full items-center gap-2 overflow-x-auto pb-1">
            {images.map((image, index) => {
              const selected = index === safeImageIndex;
              return (
                <button
                  key={image}
                  type="button"
                  aria-label={`Show variant ${index + 1}`}
                  aria-pressed={selected}
                  className={cn(
                    "relative h-14 w-20 shrink-0 overflow-hidden rounded-md border-2 bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-orange-500" : "border-border",
                  )}
                  onClick={() => {
                    onImageChange(index);
                  }}
                >
                  <img
                    src={image}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-background p-4">
            <h3 className="text-lg font-semibold text-foreground">
              {item.title}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {formatIllustrationTemplateKind(item)}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <h3 className="text-sm font-semibold text-muted-foreground">
              Variants
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
                {images.length} reference images
              </span>
              <span className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground">
                Illustration style
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label={`Select template ${item.title}`}
            className="h-10 rounded-md bg-foreground px-4 text-sm font-semibold text-background transition-colors hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onSelect(item);
            }}
          >
            Use this template
          </button>
        </div>
      </div>
    </>
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
              "h-12 gap-2 rounded-none border-b-2 bg-transparent px-1 pb-3 pt-2 text-base font-semibold shadow-none",
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
            PPT
          </TabsTrigger>
        )}
        {hasIllustrationTab && (
          <TabsTrigger
            value="illustration"
            className={cn(
              "h-12 gap-2 rounded-none border-b-2 bg-transparent px-1 pb-3 pt-2 text-base font-semibold shadow-none",
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
              "h-12 gap-2 rounded-none border-b-2 bg-transparent px-1 pb-3 pt-2 text-base font-semibold shadow-none",
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
  onSelect,
  onPreview,
}: {
  items: IllustrationTemplateItem[];
  value: GenerationTemplateRequest | undefined;
  onSelect: (item: IllustrationTemplateItem) => void;
  onPreview: (item: IllustrationTemplateItem) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => {
        return (
          <IllustrationTemplateCard
            key={item.illustrationStyleId}
            item={item}
            selected={isSelectedIllustrationTemplate(item, value)}
            onSelect={onSelect}
            onPreview={onPreview}
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
  hasIllustrationTab,
  hasVideoTab,
}: {
  value: GenerationTemplateRequest | undefined;
  onChange: (value: GenerationTemplateRequest | undefined) => void;
  onClose: () => void;
  hasPptTab: boolean;
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
}) {
  const category = useGet(templatePickerCategory$);
  const setCategory = useSet(setTemplatePickerCategory$);
  const search = useGet(templatePickerSearch$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const videoGroup = useGet(templatePickerVideoGroup$);
  const setVideoGroup = useSet(setTemplatePickerVideoGroup$);
  const previewSlug = useGet(templatePickerPreviewSlug$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const selectedSlideIndex = useGet(templatePickerPreviewSlideIndex$);
  const setSelectedSlideIndex = useSet(setTemplatePickerPreviewSlideIndex$);
  const previewItem =
    PRESENTATION_TEMPLATE_ITEMS.find((item) => {
      return item.slug === previewSlug;
    }) ?? null;
  const illustrationPreviewItem =
    ILLUSTRATION_TEMPLATE_ITEMS.find((item) => {
      return item.slug === previewSlug;
    }) ?? null;
  const isPreviewing = Boolean(previewItem ?? illustrationPreviewItem);
  const dialogContentClassName = cn(
    "p-0 gap-0 overflow-hidden",
    // The auto-rendered close button defaults to top-4, which is tuned for the
    // default p-6 dialog. This dialog uses a custom py-4 header, so re-center the
    // 36px (size-9) close button within the 50px header.
    "[&>button[aria-label=Close]]:top-[7px]",
    isPreviewing ? "max-w-6xl" : "flex h-[min(82vh,760px)] max-w-4xl flex-col",
  );
  const filteredPptItems = PRESENTATION_TEMPLATE_ITEMS.filter((item) => {
    return presentationTemplateMatchesSearch(item, search);
  });
  const filteredIllustrationItems = ILLUSTRATION_TEMPLATE_ITEMS.filter(
    (item) => {
      return illustrationTemplateMatchesSearch(item, search);
    },
  );
  const filteredVideoItems = VIDEO_STYLE_PRESETS.filter((item) => {
    return (
      videoTemplateMatchesGroup(item, videoGroup) &&
      videoTemplateMatchesSearch(item, search)
    );
  });
  const videoGroupFilters: readonly {
    readonly tag: TemplatePickerVideoGroup;
    readonly label: string;
  }[] = [{ tag: "all", label: "All" }, ...VIDEO_STYLE_GROUPS];

  const handleSelectPresentation = (item: PresentationTemplateItem) => {
    onChange(toPresentationGenerationTemplate(item));
    onClose();
  };

  const handleSelectVideo = (item: VideoStylePreset) => {
    onChange(toVideoGenerationTemplate(item));
    onClose();
  };

  const handleSelectIllustration = (item: IllustrationTemplateItem) => {
    onChange(toIllustrationGenerationTemplate(item));
    onClose();
  };

  const handlePreview = (item: PresentationTemplateItem) => {
    setSelectedSlideIndex(0);
    setPreviewSlug(item.slug);
  };

  const handleIllustrationPreview = (item: IllustrationTemplateItem) => {
    setSelectedSlideIndex(0);
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
            selectedSlideIndex={selectedSlideIndex}
            onSlideChange={setSelectedSlideIndex}
            onBack={() => {
              setPreviewSlug(null);
            }}
            onSelect={handleSelectPresentation}
          />
        ) : illustrationPreviewItem ? (
          <IllustrationPreviewPage
            item={illustrationPreviewItem}
            selectedImageIndex={selectedSlideIndex}
            onImageChange={setSelectedSlideIndex}
            onBack={() => {
              setPreviewSlug(null);
            }}
            onSelect={handleSelectIllustration}
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
                <TemplateSectionHeader
                  label="VM0 templates"
                  count={filteredPptItems.length}
                />
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
                <TemplateSectionHeader
                  label="VM0 illustration styles"
                  count={filteredIllustrationItems.length}
                />
                {filteredIllustrationItems.length > 0 ? (
                  <IllustrationTemplateGrid
                    items={filteredIllustrationItems}
                    value={value}
                    onSelect={handleSelectIllustration}
                    onPreview={handleIllustrationPreview}
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
                <TemplateSectionHeader
                  label="VM0 video styles"
                  count={filteredVideoItems.length}
                />
                <div className="mb-4 flex flex-wrap gap-2">
                  {videoGroupFilters.map((group) => {
                    const selected = videoGroup === group.tag;
                    return (
                      <button
                        key={group.tag}
                        type="button"
                        aria-pressed={selected}
                        className={cn(
                          "h-7 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          selected
                            ? "border-foreground bg-foreground text-background"
                            : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                        onClick={() => {
                          setVideoGroup(group.tag);
                        }}
                      >
                        {group.label}
                      </button>
                    );
                  })}
                </div>
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
  onRemove,
}: {
  item: PresentationTemplateItem;
  onRemove: () => void;
}) {
  const label = formatPresentationTemplateKind(item.templateId);
  return (
    <div className="px-4 pt-3">
      <div className="flex">
        <div className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background/90 pl-1.5 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            <img
              src={item.previewImage}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </span>
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
            Presentation
          </span>
          <span className="h-3.5 w-px shrink-0 bg-border/70" />
          <span className="min-w-0 truncate text-xs font-medium">{label}</span>
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
  onRemove,
}: {
  item: VideoStylePreset;
  onRemove: () => void;
}) {
  return (
    <div className="px-4 pt-3">
      <div className="flex">
        <div className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background/90 pl-1.5 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
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
            {item.nameEn}
          </span>
          <button
            type="button"
            aria-label={`Remove video style ${item.nameEn}`}
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
  onRemove,
}: {
  item: IllustrationTemplateItem;
  onRemove: () => void;
}) {
  return (
    <div className="px-4 pt-3">
      <div className="flex">
        <div className="inline-flex h-8 max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background/90 pl-1.5 pr-1 text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            <img
              src={item.previewImage}
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
  const presentationItem = selectedPresentationTemplateItem(picker?.value);
  const illustrationItem = selectedIllustrationTemplateItem(picker?.value);
  const videoItem = selectedVideoTemplateItem(picker?.value);
  if (!picker) {
    return null;
  }
  if (presentationItem) {
    return (
      <SelectedTemplateChip
        item={presentationItem}
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
  hasIllustrationTab,
  hasVideoTab,
}: {
  picker: ComposerTemplatePicker;
  hasPptTab: boolean;
  hasIllustrationTab: boolean;
  hasVideoTab: boolean;
}) {
  const open = useGet(templatePickerOpen$);
  const setOpen = useSet(setTemplatePickerOpen$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const setVideoGroup = useSet(setTemplatePickerVideoGroup$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const setSelectedSlideIndex = useSet(setTemplatePickerPreviewSlideIndex$);
  const selectedTitle = selectedTemplateTitle(picker.value);

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "rounded-lg p-2 transition-colors duration-200 hover:bg-accent hover:text-foreground sm:p-[9px]",
                picker.value && "bg-accent text-foreground",
              )}
              aria-label="Template"
              aria-pressed={picker.value !== undefined}
              onClick={() => {
                setSearch("");
                setVideoGroup("all");
                setPreviewSlug(null);
                setSelectedSlideIndex(0);
                setOpen(true);
              }}
            >
              <IconTemplate size={18} stroke={1.5} />
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
  if (!picker || (!hasChatTemplatePicker && !hasVideoTab)) {
    return null;
  }
  return (
    <TemplatePickerButton
      picker={picker}
      hasPptTab={hasPptTab}
      hasIllustrationTab={hasIllustrationTab}
      hasVideoTab={hasVideoTab}
    />
  );
}

function ConnectorTriggerIcons({
  connectors,
}: {
  connectors: ComposerConnectorItem[];
}) {
  const enabled = connectors
    .filter((c) => {
      return c.authorized;
    })
    .slice(0, 3);
  if (enabled.length === 0) {
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

function ConnectorsPopoverButton({
  agentConnectors,
  connectorsLoading,
  savingType,
  onOpenAddDialog,
  onToggle,
}: {
  agentConnectors: ComposerConnectorItem[];
  connectorsLoading: boolean;
  savingType: string | null;
  onOpenAddDialog: () => void;
  onToggle: (type: ConnectorType, checked: boolean) => void | Promise<void>;
}) {
  const search = useGet(popoverSearch$);
  const setSearch = useSet(setPopoverSearch$);
  const sortOrder = useGet(popoverSortOrder$);
  const setSortOrder = useSet(setPopoverSortOrder$);
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
                <ConnectorTriggerIcons connectors={agentConnectors} />
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
                    <div
                      key={item.type}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
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
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        <div
          className={cn(
            "p-1 flex flex-col",
            (agentConnectors.length > 0 || connectorsLoading) &&
              "border-t border-border/50",
          )}
        >
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
    </Popover>
  );
}

function ComputerUsePopoverButton({
  computerUse,
}: {
  computerUse: ComposerComputerUse;
}) {
  const active = computerUse.selectedHostId !== null;
  const open = useGet(computerUsePopoverOpen$);
  const setOpen = useSet(setComputerUsePopoverOpen$);
  const clearCloseSuppression = useSet(
    clearComputerUsePopoverCloseSuppression$,
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setOpen(true);
      computerUse.onRefresh();
      window.setTimeout(() => {
        clearCloseSuppression();
      }, 300);
      return;
    }

    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-lg px-1 transition-colors hover:bg-accent sm:h-9 sm:min-w-9 sm:px-1.5",
                  active && "text-primary",
                )}
                aria-label="Computer Use"
              >
                <IconDeviceDesktop size={18} stroke={1.5} />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            Computer
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="top" align="start" className="w-72 p-0 rounded-lg">
        <div className="py-1">
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
              className="flex max-h-72 flex-col overflow-y-auto"
              role="radiogroup"
              aria-label="Computer Use host"
            >
              {computerUse.hosts.map((host) => {
                const checked = computerUse.selectedHostId === host.id;
                return (
                  <button
                    key={host.id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    onClick={() => {
                      computerUse.onChange(checked ? null : host.id);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                      checked ? "bg-primary/5" : "hover:bg-muted/50",
                    )}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                      <IconDeviceDesktop size={16} stroke={1.5} />
                    </span>
                    <span className="text-sm flex-1 truncate text-foreground">
                      {host.hostName}
                    </span>
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-transparent",
                      )}
                      aria-hidden="true"
                    >
                      {checked && <IconCheck size={11} stroke={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No online computers
            </div>
          )}
        </div>
        <div className="border-t border-border/50 p-1">
          <a
            href={computerUse.downloadUrl}
            target="_blank"
            rel="noreferrer"
            className="flex w-full items-center gap-2 px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-accent transition-colors"
          >
            <IconPlug
              size={18}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            Connect my computer
          </a>
        </div>
      </PopoverContent>
    </Popover>
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
  textarea: HTMLTextAreaElement,
  currentValue: string,
  pastedText: string,
): string {
  if (!pastedText) {
    return currentValue;
  }
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
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

interface SlashSkillRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

interface ComposerSlashSkill extends ZeroAgentCustomSkill {
  readonly token: string;
}

function findActiveSlashSkillRange(
  value: string,
  caretIndex: number,
): SlashSkillRange | null {
  const beforeCaret = value.slice(0, caretIndex);
  const match = /(?:^|\s)\/([a-z0-9-]*)$/i.exec(beforeCaret);
  if (!match) {
    return null;
  }

  const query = match[1] ?? "";
  const slashOffset = match[0].lastIndexOf("/");
  const start = beforeCaret.length - match[0].length + slashOffset;
  return { start, end: caretIndex, query };
}

function matchesSkillQuery(skill: ComposerSlashSkill, query: string): boolean {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLowerCase();
  return [skill.name, skill.displayName ?? "", skill.description ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(normalizedQuery);
}

function skillTokenPattern(skillNames: readonly string[]): RegExp | null {
  if (skillNames.length === 0) {
    return null;
  }

  const escaped = skillNames.map((name) => {
    return name.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  });
  return new RegExp(`/(?:${escaped.join("|")})(?=$|\\s)`, "g");
}

function ComposerInputHighlight({
  input,
  skills,
}: {
  readonly input: string;
  readonly skills: readonly ComposerSlashSkill[];
}) {
  const pattern = skillTokenPattern(
    skills.map((skill) => {
      return skill.name;
    }),
  );

  if (!input || !pattern) {
    return null;
  }

  const parts: { text: string; skill: boolean; start: number }[] = [];
  let lastIndex = 0;
  for (const match of input.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({
        text: input.slice(lastIndex, start),
        skill: false,
        start: lastIndex,
      });
    }
    parts.push({ text: match[0], skill: true, start });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < input.length) {
    parts.push({
      text: input.slice(lastIndex),
      skill: false,
      start: lastIndex,
    });
  }

  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 whitespace-pre-wrap break-words px-4 pt-4 pb-0 text-[0.9375rem] leading-6 text-transparent"
      aria-hidden="true"
    >
      {parts.map((part) => {
        return (
          <span
            key={`${part.start}:${part.skill ? "skill" : "text"}:${part.text}`}
            className={part.skill ? "text-primary" : "text-transparent"}
          >
            {part.text}
          </span>
        );
      })}
    </div>
  );
}

function SlashSkillMenu({
  skills,
  loading,
  selectedIndex,
  showSkillsPageLink,
  onSelect,
}: {
  readonly skills: readonly ComposerSlashSkill[];
  readonly loading: boolean;
  readonly selectedIndex: number;
  readonly showSkillsPageLink: boolean;
  readonly onSelect: (skill: ComposerSlashSkill) => void;
}) {
  const setMenuRef = useSet(setSlashSkillMenuRef$);

  return (
    <div
      ref={setMenuRef}
      popover="manual"
      className="slash-skill-popover flex max-h-80 w-[260px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-md border border-border/70 bg-popover/95 text-popover-foreground shadow-lg backdrop-blur"
      data-testid="slash-skill-menu"
    >
      <div className="px-2.5 pt-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
        Skills
      </div>
      {loading ? (
        <div className="px-2.5 py-2 text-sm text-muted-foreground">
          Loading skills...
        </div>
      ) : skills.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {skills.map((skill, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                id={slashSkillOptionId(skill.name)}
                key={skill.name}
                type="button"
                className={cn(
                  "flex w-full items-center rounded px-2 py-1.5 text-left transition-colors",
                  selected ? "bg-accent" : "hover:bg-accent/60",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(skill);
                }}
              >
                <span className="truncate font-mono text-sm text-primary">
                  {skill.token}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-2.5 pt-1 pb-2.5 text-sm text-muted-foreground">
          No matching skills
        </div>
      )}
      {showSkillsPageLink && (
        <div className="shrink-0 border-t border-border/60 bg-popover/95 p-1.5">
          <Link
            pathname="/skills"
            className="flex h-9 w-full items-center justify-between rounded px-2 text-sm font-medium text-popover-foreground transition-colors hover:bg-accent"
          >
            <span className="flex min-w-0 items-center gap-2">
              <IconFileText
                size={16}
                stroke={1.8}
                className="shrink-0 text-muted-foreground"
              />
              <span className="truncate">View all skills</span>
            </span>
            <IconChevronRight
              size={16}
              stroke={1.8}
              className="shrink-0 text-muted-foreground"
            />
          </Link>
        </div>
      )}
    </div>
  );
}

function slashSkillOptionId(skillName: string): string {
  return `slash-skill-option-${skillName}`;
}

function scrollSlashSkillIntoView(skill: ComposerSlashSkill | undefined): void {
  if (!skill) {
    return;
  }

  window.requestAnimationFrame(() => {
    const option = document.getElementById(slashSkillOptionId(skill.name));
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

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
  readonly onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
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

function buildComposerSlashSkills({
  agentSkillNames,
  orgSkills,
}: {
  readonly agentSkillNames: readonly string[];
  readonly orgSkills: readonly ZeroAgentCustomSkill[];
}): readonly ComposerSlashSkill[] {
  const metadataByName = new Map(
    orgSkills.map((skill) => {
      return [skill.name, skill];
    }),
  );
  return agentSkillNames.map((name) => {
    const metadata = metadataByName.get(name);
    return {
      name,
      displayName: metadata?.displayName ?? null,
      description: metadata?.description ?? null,
      token: `/${name}`,
    };
  });
}

function SlashSkillComposerInput({
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
  readonly onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const caretIndex = useGet(slashSkillCaretIndex$);
  const setCaretIndex = useSet(setSlashSkillCaretIndex$);
  const selectedSkillIndex = useGet(selectedSlashSkillIndex$);
  const setSelectedSkillIndex = useSet(setSelectedSlashSkillIndex$);
  const currentAgent = useLastResolved(currentChatAgent$);
  const features = useLastResolved(featureSwitch$);
  const orgSkillsLoadable = useLastLoadable(orgSkills$);
  const orgSkills =
    orgSkillsLoadable.state === "hasData" ? orgSkillsLoadable.data : [];
  const composerSkills = buildComposerSlashSkills({
    agentSkillNames: currentAgent?.customSkills ?? [],
    orgSkills,
  });
  const slashRange = findActiveSlashSkillRange(input, caretIndex);
  const slashSkillSuggestions = slashRange
    ? composerSkills.filter((skill) => {
        return matchesSkillQuery(skill, slashRange.query);
      })
    : [];
  const isLoadingOrgSkills = orgSkillsLoadable.state === "loading";
  const showSkillsPageLink = features?.[FeatureSwitchKey.SkillsViewer] ?? false;
  const showSlashSkillMenu =
    slashRange !== null &&
    (isLoadingOrgSkills || composerSkills.length > 0 || showSkillsPageLink);

  const updateCaretIndex = (textarea: HTMLTextAreaElement) => {
    setCaretIndex(textarea.selectionStart);
  };

  const insertSlashSkill = (
    skill: ComposerSlashSkill,
    textarea: HTMLTextAreaElement | null,
  ) => {
    if (!slashRange) {
      return;
    }

    const suffix = input.slice(slashRange.end).startsWith(" ") ? "" : " ";
    const nextInput = `${input.slice(0, slashRange.start)}${skill.token}${suffix}${input.slice(slashRange.end)}`;
    const nextCaret = slashRange.start + skill.token.length + suffix.length;
    onInputChange(nextInput);
    onDraftChange?.();
    setCaretIndex(nextCaret);
    window.requestAnimationFrame(() => {
      textarea?.setSelectionRange(nextCaret, nextCaret);
      textarea?.focus();
    });
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (!showSlashSkillMenu) {
      onKeyDown(e);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIndex = Math.min(
        selectedSkillIndex + 1,
        Math.max(slashSkillSuggestions.length - 1, 0),
      );
      setSelectedSkillIndex(nextIndex);
      scrollSlashSkillIntoView(slashSkillSuggestions[nextIndex]);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextIndex = Math.max(selectedSkillIndex - 1, 0);
      setSelectedSkillIndex(nextIndex);
      scrollSlashSkillIntoView(slashSkillSuggestions[nextIndex]);
      return;
    }

    if ((e.key === "Enter" || e.key === "Tab") && slashSkillSuggestions[0]) {
      e.preventDefault();
      insertSlashSkill(
        slashSkillSuggestions[
          Math.min(selectedSkillIndex, slashSkillSuggestions.length - 1)
        ]!,
        e.currentTarget,
      );
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      setCaretIndex(-1);
      return;
    }

    onKeyDown(e);
  };

  return (
    <div className="slash-skill-anchor relative">
      {showSlashSkillMenu && (
        <SlashSkillMenu
          skills={slashSkillSuggestions}
          loading={isLoadingOrgSkills}
          selectedIndex={selectedSkillIndex}
          showSkillsPageLink={showSkillsPageLink}
          onSelect={(skill) => {
            insertSlashSkill(
              skill,
              document.activeElement instanceof HTMLTextAreaElement
                ? document.activeElement
                : null,
            );
          }}
        />
      )}
      <div className="relative min-h-[96px]">
        <ComposerInputHighlight input={input} skills={composerSkills} />
        <ComposerTextarea
          input={input}
          onInputChange={onInputChange}
          sending={sending}
          autoFocus={autoFocus}
          setInputRef={setInputRef}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          onAfterInputChange={(textarea) => {
            setSelectedSkillIndex(0);
            updateCaretIndex(textarea);
          }}
          onPointerSelectionChange={updateCaretIndex}
        />
      </div>
    </div>
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
  readonly onKeyDown: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  readonly onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const features = useLastResolved(featureSwitch$);
  const slashSkillCommandsEnabled =
    features?.[FeatureSwitchKey.ChatSlashSkillCommands] ?? false;

  if (slashSkillCommandsEnabled) {
    return (
      <SlashSkillComposerInput
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
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
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

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
                    onOpenAddDialog={() => {
                      return setShowAddDialog(true);
                    }}
                    onToggle={handleToggle}
                  />
                  {computerUse && (
                    <ComputerUsePopoverButton computerUse={computerUse} />
                  )}
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
