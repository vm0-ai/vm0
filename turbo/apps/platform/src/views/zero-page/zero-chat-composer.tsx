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
  IconChevronLeft,
  IconChevronRight,
  IconChartBar,
  IconEye,
  IconLoader2,
  IconMicrophone,
  IconPaperclip,
  IconPlayerStop,
  IconPlug,
  IconPlus,
  IconSearch,
  IconTemplate,
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
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import {
  PRESENTATION_TEMPLATE_ITEMS,
  type PresentationTemplateItem,
} from "@vm0/core";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
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
  templatePickerPreviewSlideIndex$,
  setTemplatePickerPreviewSlideIndex$,
  templateCardHover$,
  setTemplateCardHover$,
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
}

export interface QueuedComposerItem {
  id: string;
  text: string;
}

type ComposerModelPicker = NonNullable<ZeroChatComposerProps["modelPicker"]>;
type ComposerTemplatePicker = NonNullable<
  ZeroChatComposerProps["templatePicker"]
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ComposerConnectorItem {
  type: string;
  label: string;
  helpText: string;
  tags: readonly string[];
  connected: boolean;
  authorized: boolean;
  available: boolean;
}

function resolveConnectorLabel(
  type: string,
  connectorMap: Map<ConnectorType, { label: string }>,
): string {
  return connectorMap.get(type as ConnectorType)?.label ?? type;
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
  return selectedPresentationTemplateItem(value)?.title;
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
    <div className="flex min-h-40 items-center justify-center rounded-[22px] border-2 border-dashed border-border bg-background px-6 py-10 text-center">
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
  if (item.previewImages.length > 0) {
    return item.previewImages;
  }
  return [item.previewImage];
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
  const previewImage = slideImages[hoverSlideIndex] ?? item.previewImage;

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
      setHover({ slug: item.slug, index: nextIndex });
    }
  };

  return (
    <div
      className="relative aspect-[16/9] overflow-hidden bg-muted"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => {
        setHover(null);
      }}
    >
      {previewImage ? (
        <img
          src={previewImage}
          alt=""
          title={`${item.title} card preview slide ${hoverSlideIndex + 1}`}
          className="h-full w-full object-cover"
          loading="lazy"
        />
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
  const selectedSlideImage = slideImages[safeSlideIndex] ?? item.previewImage;
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

function TemplatePickerDialog({
  value,
  onChange,
  onClose,
}: {
  value: GenerationTemplateRequest | undefined;
  onChange: (value: GenerationTemplateRequest | undefined) => void;
  onClose: () => void;
}) {
  const category = useGet(templatePickerCategory$);
  const setCategory = useSet(setTemplatePickerCategory$);
  const search = useGet(templatePickerSearch$);
  const setSearch = useSet(setTemplatePickerSearch$);
  const previewSlug = useGet(templatePickerPreviewSlug$);
  const setPreviewSlug = useSet(setTemplatePickerPreviewSlug$);
  const selectedSlideIndex = useGet(templatePickerPreviewSlideIndex$);
  const setSelectedSlideIndex = useSet(setTemplatePickerPreviewSlideIndex$);
  const previewItem =
    PRESENTATION_TEMPLATE_ITEMS.find((item) => {
      return item.slug === previewSlug;
    }) ?? null;
  const filteredItems = PRESENTATION_TEMPLATE_ITEMS.filter((item) => {
    return presentationTemplateMatchesSearch(item, search);
  });

  const handleSelect = (item: PresentationTemplateItem) => {
    onChange(toPresentationGenerationTemplate(item));
    onClose();
  };

  const handlePreview = (item: PresentationTemplateItem) => {
    setSelectedSlideIndex(0);
    setPreviewSlug(item.slug);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          if (previewItem) {
            setPreviewSlug(null);
            return;
          }
          onClose();
        }
      }}
    >
      <DialogContent
        className={cn(
          "p-0 gap-0 overflow-hidden",
          previewItem ? "max-w-6xl" : "max-w-4xl",
        )}
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
            onSelect={handleSelect}
          />
        ) : (
          <>
            <DialogHeader className="shrink-0 border-b border-border px-5 py-4">
              <DialogTitle>Templates</DialogTitle>
            </DialogHeader>
            <div className="flex shrink-0 flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <Tabs value={category} onValueChange={setCategory}>
                <TabsList className="h-auto rounded-none bg-transparent p-0">
                  <TabsTrigger
                    value="slides"
                    className="h-11 gap-2 rounded-none border-b-2 border-foreground bg-transparent px-1 pb-3 pt-2 text-base font-semibold text-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                  >
                    <IconChartBar
                      className="h-5 w-5 text-blue-500"
                      stroke={1.8}
                    />
                    PPT
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="relative w-full sm:w-64">
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
            {category === "slides" && (
              <div className="max-h-[66vh] overflow-y-auto px-5 py-4">
                <TemplateSectionHeader
                  label="VM0 templates"
                  count={filteredItems.length}
                />
                {filteredItems.length > 0 ? (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredItems.map((item) => {
                      const selected = isSelectedPresentationTemplate(
                        item,
                        value,
                      );
                      return (
                        <div
                          key={item.slug}
                          className={cn(
                            "group overflow-hidden rounded-lg border bg-card shadow-sm transition-colors hover:bg-muted/20",
                            selected
                              ? "border-primary ring-1 ring-primary"
                              : "border-border",
                          )}
                        >
                          <TemplatePreview
                            item={item}
                            onPreview={handlePreview}
                          />
                          <div className="flex items-start justify-between gap-3 px-3.5 py-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-foreground">
                                {item.title}
                              </p>
                              <p className="mt-1 truncate text-xs text-muted-foreground">
                                {formatPresentationTemplateKind(
                                  item.templateId,
                                )}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center">
                              <button
                                type="button"
                                aria-label={`Select template ${item.title}`}
                                aria-pressed={selected}
                                onClick={() => {
                                  handleSelect(item);
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
                    })}
                  </div>
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
            Template
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

function SelectedTemplateChipSlot({
  picker,
  onDraftChange,
}: {
  picker: ComposerTemplatePicker | undefined;
  onDraftChange: (() => void) | undefined;
}) {
  const selectedItem = selectedPresentationTemplateItem(picker?.value);
  if (!selectedItem || !picker) {
    return null;
  }
  return (
    <SelectedTemplateChip
      item={selectedItem}
      onRemove={() => {
        picker.onChange(undefined);
        onDraftChange?.();
      }}
    />
  );
}

function TemplatePickerButton({ picker }: { picker: ComposerTemplatePicker }) {
  const open = useGet(templatePickerOpen$);
  const setOpen = useSet(setTemplatePickerOpen$);
  const setSearch = useSet(setTemplatePickerSearch$);
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
  if (!picker || !features?.[FeatureSwitchKey.ChatTemplatePicker]) {
    return null;
  }
  return <TemplatePickerButton picker={picker} />;
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
              <ConnectorIcon type={c.type as ConnectorType} size={16} />
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
  onSelect: (type: string) => void;
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
                      {item.type in CONNECTOR_TYPES ? (
                        <ConnectorIcon
                          type={item.type as ConnectorType}
                          size={20}
                        />
                      ) : (
                        <IconPlug
                          size={18}
                          stroke={1.5}
                          className="text-muted-foreground"
                        />
                      )}
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
                      {item.helpText ?? ""}
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
  onToggle: (type: string, checked: boolean) => void | Promise<void>;
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
                        <ConnectorIcon
                          type={item.type as ConnectorType}
                          size={16}
                        />
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
  modelPickerLoading = false,
  submitBlocker,
  queuedItems,
  onRemoveQueuedItem,
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

  const handleConnectSuccess = async (type: string) => {
    const label = resolveConnectorLabel(type, connectorMap);
    await tapError(authorizeFn(type, pageSignal), () => {
      toast.error(`${label} was authorized but could not be saved`, {
        id: `connector-save-error-${type}`,
      });
    });
    toast.success(`${label} connected and authorized for ${displayName}`, {
      id: `connector-connected-${type}`,
    });
  };

  const handleToggle = async (type: string, checked: boolean) => {
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
            "zero-composer relative z-10 overflow-hidden",
            dragOver && "outline outline-2 outline-blue-400/60",
          )}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <CardContent className="p-0">
            <div className="flex flex-col">
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
              <textarea
                ref={(el) => {
                  if (el && autoFocus && !isIOSDevice()) {
                    el.focus();
                  }
                  setInputRef?.(el);
                }}
                className={cn(
                  "w-full resize-none bg-transparent px-4 pt-4 pb-0 text-[0.9375rem] text-foreground placeholder:text-muted-foreground/40 border-0 focus:outline-none focus:ring-0 min-h-[96px]",
                )}
                rows={3}
                placeholder={
                  sending
                    ? "Type your next message\u2026"
                    : "Ask me to automate workflows, manage tasks..."
                }
                value={input}
                onChange={(e) => {
                  return onInputChange(e.target.value);
                }}
                enterKeyHint="enter"
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
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
                      {showStopButton ? (
                        <Button
                          size="sm"
                          variant="destructive"
                          className="rounded-lg h-9 w-9 p-0 shrink-0"
                          onClick={onCancel}
                          aria-label="Stop"
                        >
                          <IconPlayerStop size={16} />
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          className="rounded-lg h-9 w-9 p-0 shrink-0"
                          onClick={handleButtonSend}
                          disabled={sendAction === "none"}
                          aria-label="Send"
                        >
                          <IconArrowUp size={18} stroke={2} />
                        </Button>
                      )}
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
            setSelectedConnType(type as ConnectorType);
          }}
        />
      )}
    </>
  );
}
