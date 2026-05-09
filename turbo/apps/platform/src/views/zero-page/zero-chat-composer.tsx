// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type React from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { ensurePushSubscription$ } from "../../lib/push-notifications.ts";
import {
  IconArrowUp,
  IconLoader2,
  IconMicrophone,
  IconPaperclip,
  IconPlayerStop,
  IconPlug,
  IconPlus,
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
} from "../../signals/utils.ts";
import { sendMode$ } from "../../signals/send-mode.ts";
import { toggleSidebarOff$ } from "../../signals/zero-page/zero-nav.ts";
import type { DraftSignals } from "../../signals/chat-page/create-chat-thread.ts";
import { isVisualAttachment } from "../../signals/chat-page/resolve-draft-attachments.ts";
import type { Command, Computed } from "ccstate";
import {
  zeroChatAttachments$ as singletonAttachments$,
  uploadZeroAttachment$ as singletonUpload$,
  restoreZeroAttachments$ as singletonRestore$,
  removeZeroAttachment$ as singletonRemove$,
  canSendZeroChat$ as singletonCanSend$,
  zeroDragOver$ as singletonDragOver$,
  setZeroDragOver$ as singletonSetDragOver$,
  composerFileInput$ as singletonComposerFileInput$,
  setComposerFileInput$ as singletonSetComposerFileInput$,
} from "../../signals/chat-page/chat-message.ts";
import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";
import {
  getModelImageInputSupport,
  type ModelProviderResponse,
  type ModelProviderType,
} from "@vm0/api-contracts/contracts/model-providers";
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
  pollingConnectorType$,
  type ConnectorTypeWithStatus,
} from "../../signals/zero-page/settings/connectors.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  zeroAuthorizedConnectors$,
  authorizeConnector$,
  deauthorizeConnector$,
} from "../../signals/zero-page/zero-connectors.ts";
import { resolveWorkspaceDefaultSelection } from "../../signals/zero-page/model-provider-default.ts";
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
  onSend: (message: string) => void;
  onQueue?: (message: string) => void;
  sending?: boolean;
  queueWhileSending?: boolean;
  /**
   * Cancel the active run. When provided, the Send button switches to a Stop
   * button while sending and the composer is empty; with content present the
   * Send button stays visible and clicks queue the message instead.
   * Clicking Stop while a queue exists recalls the queued text to draft.
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
    providers: ModelProviderResponse[];
    /**
     * Per-provider tier annotation (Wave 3 of Epic #11868). When provided,
     * the picker groups items into "Personal" and "Workspace" sections
     * with personal first and renders distinct default badges. Composer
     * call sites pass the merged map from `composerModelProviders$`;
     * settings / schedule editors omit it for byte-for-byte unchanged
     * behavior.
     */
    tiers?: Map<string, "personal" | "org">;
    value: ModelProviderSelection | null;
    onChange: (value: ModelProviderSelection | null) => void;
    /**
     * Provider type of the current session's first run. When set, options whose
     * base URL differs are disabled to preserve session continuity.
     */
    sessionProviderType: ModelProviderType | null;
    // When true, picker is read-only (e.g. existing chat thread).
    disabled?: boolean;
    /** The agent-level default model, shown as a "Default" tag in the dropdown. */
    agentDefault?: ModelProviderSelection | null;
    /** Hide the "Use default" row in compact chat pickers. */
    showUseDefault?: boolean;
  };
}

type ComposerModelPicker = NonNullable<ZeroChatComposerProps["modelPicker"]>;

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
  if (modelPicker.agentDefault) {
    return modelPicker.agentDefault;
  }
  return resolveWorkspaceDefaultSelection(
    modelPicker.providers,
    modelPicker.tiers,
  );
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
}: {
  draftCanSend: boolean;
  input: string;
  visibleAttachmentCount: number;
}): boolean {
  return draftCanSend && (input.trim() !== "" || visibleAttachmentCount > 0);
}

// ---------------------------------------------------------------------------
// Connector sub-components
// ---------------------------------------------------------------------------

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
  });

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
  const pollingConnType = useGet(pollingConnectorType$);
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
    await authorizeFn(type, pageSignal).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        toast.error(`${label} was authorized but could not be saved`, {
          id: `connector-save-error-${type}`,
        });
      }
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
    canSend,
    sending,
    queueWhileSending,
    hasQueueHandler: onQueue !== undefined,
  });

  const handleSend = () => {
    if (sendAction === "send") {
      // Fire-and-forget: request push permission on first send, never blocks
      detach(ensurePushSubscription(rootSignal), Reason.DomCallback);
      onSend(input.trim());
      return;
    }
    if (sendAction === "queue") {
      onQueue?.(input.trim());
    }
  };

  // Stop button replaces Send only when there is nothing to dispatch — i.e.
  // the composer is empty during an active run. With draft content present
  // the Send button stays visible so the click can queue the message.
  const showStopButton = Boolean(sending && onCancel) && !canSend;

  // Routes a button click to queue (while an active run exists and the
  // queue feature is on) or to the normal send path.
  const handleButtonSend = () => {
    if (sending && queueWhileSending && onQueue) {
      onQueue(input.trim());
    } else {
      handleSend();
    }
  };

  const sendModeLoadable = useLastLoadable(sendMode$);
  const sendMode =
    sendModeLoadable.state === "hasData" ? sendModeLoadable.data : "enter";
  const toggleSidebar = useSet(toggleSidebarOff$);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        "mod+alt+.": () => {
          if (modelPicker) {
            setModelPickerOpen(true);
          }
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
      <Card
        className={cn(
          "zero-composer overflow-hidden",
          className,
          dragOver && "outline outline-2 outline-blue-400/60",
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <CardContent className="p-0">
          <div className="flex flex-col">
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
                "w-full resize-none bg-transparent px-4 pt-4 pb-0 text-sm text-foreground placeholder:text-muted-foreground/40 border-0 focus:outline-none focus:ring-0 min-h-[96px]",
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
              </div>
              <div className="flex items-center gap-1 sm:gap-2">
                {actionsLoading ? (
                  <Skeleton
                    className={cn(
                      "h-9 rounded-md",
                      modelPicker ? "w-[184px]" : "w-20",
                    )}
                  />
                ) : (
                  <>
                    {modelPicker && (
                      <ModelProviderPicker
                        providers={modelPicker.providers}
                        tiers={modelPicker.tiers}
                        value={modelPicker.value}
                        onChange={handleModelPickerChange}
                        placeholder="Default"
                        triggerClassName={cn(
                          "h-9 w-9 max-w-none gap-0 border-transparent bg-transparent px-0 text-sm text-muted-foreground transition-colors sm:w-auto sm:max-w-[14rem] sm:gap-1 sm:px-2",
                          "[&>span]:flex [&>span]:items-center [&>span]:justify-center sm:[&>span]:justify-start [&>svg]:hidden sm:[&>svg]:block",
                          "hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
                        )}
                        sessionProviderType={modelPicker.sessionProviderType}
                        compactTrigger
                        mobileIconTrigger
                        open={modelPickerOpen}
                        onOpenChange={setModelPickerOpen}
                        disabled={modelPicker.disabled}
                        agentDefault={modelPicker.agentDefault}
                        inheritLabel="agent"
                        showUseDefault={modelPicker.showUseDefault}
                      />
                    )}
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
