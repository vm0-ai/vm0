import type {
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  UIEvent as ReactUIEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  useGet,
  useSet,
  useLoadableState,
  useLastLoadable,
  useLastResolved,
  useLoadable,
} from "ccstate-react";
import { equalArrays } from "../../lib/equality.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  runUsagePopoverOpenRunId$,
  setRunUsagePopoverOpenRunId$,
} from "../../signals/chat-page/run-usage-popover.ts";
import {
  replaceWorkflowPromptDraftTarget$,
  setReplaceWorkflowPromptDraftTarget$,
} from "../../signals/chat-page/workflow-prompt-action.ts";
import {
  IconAlertCircle,
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconHandStop,
  IconPhoto,
  IconChartLine,
  IconPlayerPlay,
  IconVideo,
  IconCopy,
  IconDeviceDesktop,
  IconCheck,
  IconArrowDown,
  IconArrowUpRight,
  IconChevronRight,
  IconLink,
  IconLoader2,
  IconMessageCircle,
  IconMoodPlus,
  IconPackage,
  IconPresentation,
  IconRoute,
  IconSearch,
  IconTarget,
  IconX,
  IconClock,
  IconCoins,
  IconHourglass,
  IconBrandSlack,
  IconWorld,
} from "@tabler/icons-react";
import {
  cn,
  getShortcutLabel,
  getShortcutParts,
  Button,
  Input,
  Skeleton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Popover,
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
} from "@vm0/ui";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import type {
  ChatThreadArtifactFile,
  ChatMessageUsagePayload,
  FeedbackNotePart,
  ChatFollowupsEvent,
  GenerationTemplateRequest,
  ResolvedAttachFile,
  UserMessageDocument,
  UserMessagePart,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  terminatedChatRunIds,
} from "@vm0/api-contracts/contracts/chat-events";
import {
  messageDocumentToDisplayText,
  messageDocumentToPrompt,
  shouldUseStructuredPrompt,
  type EditorDocumentSnapshot,
} from "../../signals/zero-page/user-message-document-codec.ts";
import type {
  ChatThreadWorkflowAutomation,
  ZeroWorkflowSchedule,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  findWebsiteTemplateItem,
  findVideoTemplateItem,
  findWorkflowTemplateItem,
  r2ImageTransformUrl,
} from "@vm0/core";
import type {
  UserPermissionGrantExpiresIn,
  UserPermissionGrantResponse,
} from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type { PublicConnectorCatalogPermissionDetail } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { emptyArtifactImg, emptyChatImg } from "./platform-assets.ts";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { Markdown } from "../components/markdown.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  featureSwitch$,
  newChatThreadSidebarEnabled$,
} from "../../signals/external/feature-switch.ts";
import {
  captureRecommendedFollowupSelected,
  captureRecommendedFollowupsShown,
} from "../../lib/posthog.ts";
import { getCreditUsageDisplayName } from "../../lib/credit-usage-display.ts";
import {
  AttachmentLightbox,
  FileAttachmentChip,
  PreviewableAudioAttachmentChip,
  PreviewableFileAttachmentChip,
  publicAttachmentUrl,
} from "./zero-attachment-chips.tsx";
import { ArtifactSidebar } from "./zero-artifact-sidebar.tsx";
import { MailDraftCard } from "./mail-draft-card.tsx";
import { BrowserSessionCard } from "./browser-session-card.tsx";
import { BrowserSessionSidebar } from "./browser-session-sidebar.tsx";
import { MailDraftSidebar } from "./mail-draft-sidebar.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  classifyChatAttachment,
  contentTypeForBodyPreviewKind,
  type BodyRenderBlock,
} from "../../signals/chat-page/parse-body-blocks.ts";
import type { ArtifactSignals } from "../../signals/chat-page/artifact-card-signals.ts";
import {
  isTextPreviewKind,
  type TextPreviewComputed,
} from "../../signals/text-preview.ts";
import {
  activeChatConnectorAction$,
  closeChatConnectorActionConnectDialog$,
  type ConnectorSignals,
  type CustomConnectorSignals,
} from "../../signals/chat-page/connector-action-block.ts";
import { connectorCurrentConnectionStatus } from "../../signals/zero-page/settings/connectors.ts";
import {
  completedWorkExpandedKeys$,
  toggleCompletedWorkExpanded$,
} from "../../signals/chat-page/completed-work-folding.ts";
import { isCancelledRunEvent } from "../../signals/chat-page/chat-run-lifecycle.ts";
import {
  buildRunGroupFolding,
  runGroupExpansionOverrides$,
  toggleRunGroupExpanded$,
  type RunGroupFold,
  type RunGroupFolding,
} from "../../signals/chat-page/run-group-folding.ts";
import { runChatActionCallback$ } from "../../signals/chat-page/action-callback.ts";
import type { ComputerUseAuthorizationSignals } from "../../signals/chat-page/computer-use-authorization-block.ts";
import type { PlanUpgradeSignals } from "../../signals/chat-page/plan-upgrade-block.ts";
import {
  emptyMailDraftSignalsById$,
  type MailDraftSignals,
} from "../../signals/chat-page/mail-draft.ts";
import {
  emptyBrowserSessionSignalsById$,
  type BrowserSessionSignals,
} from "../../signals/chat-page/browser-session-block.ts";
import type { PermissionSignals } from "../../signals/chat-page/permission-card-signals.ts";
import { AttachmentPreview } from "./zero-attachment-preview.tsx";
import { ArtifactThumbnailImage } from "./zero-artifact-thumbnail.tsx";
import { FilePreviewIcon } from "./zero-file-preview-icon.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { PermissionGrantDurationSelect } from "../components/permission-grant-duration-select.tsx";
import { lightboxUrl$ as attachmentLightboxUrl$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN,
  permissionGrantExpiresInByScope$,
  permissionGrantExpiryText,
  setPermissionGrantExpiresIn$,
} from "../../signals/permission-allow/permission-grant-expiration.ts";
import { isActiveUserPermissionGrant } from "../../signals/user-permission-grants.ts";
import {
  artifactFullscreen$,
  artifactInboxQuery$,
  artifactInboxSearchOpen$,
  artifactInboxSection$,
  ARTIFACT_PANEL_MIN_THREAD_WIDTH,
  ARTIFACT_PANEL_MIN_WIDTH,
  artifactPanelResizing$,
  artifactPanelWidth$,
  backToArtifactInbox$,
  type ArtifactInboxSection,
  type ArtifactRef,
  closeArtifact$,
  currentArtifactInboxThreadId$,
  currentArtifactRef$,
  openArtifactFromInbox$,
  setArtifactInboxQuery$,
  setArtifactInboxSection$,
  setArtifactPanelResizing$,
  setArtifactPanelWidth$,
  openImageLightboxOrArtifact$ as openAttachmentImageLightbox$,
  openVideoLightboxOrArtifact$ as openAttachmentVideoLightbox$,
  toggleArtifactFullscreen$,
  toggleArtifactInboxSearch$,
} from "../../signals/zero-page/zero-artifact-sidebar.ts";
import type { ChatClipboardAttachment } from "../../signals/zero-page/clipboard.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import type {
  HeaderAutomationSignals,
  HeaderWorkflowAutomationEntry,
} from "../../signals/chat-page/header-automation-menu.ts";
import { pauseChatThreadGoal$ } from "../../signals/chat-page/chat-goal.ts";
import {
  closeHeaderAutomationSidebar$,
  currentEditingHeaderWorkflowAutomationId$,
  currentHeaderAutomationThreadId$,
  setEditingHeaderWorkflowAutomationId$,
} from "../../signals/chat-page/header-automation-sidebar.ts";
import {
  activeThreadSidebar$,
  openThreadAutomations$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import {
  ThreadSidebarSlot,
  useOpenThreadArtifacts,
} from "./thread-sidebar.tsx";
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
import { currentMailDraftId$ } from "../../signals/zero-page/mail-draft-sidebar.ts";
import { currentBrowserSessionId$ } from "../../signals/zero-page/browser-session-sidebar.ts";
import {
  closeChatThreadEmojiMenu$,
  emojiMenuThreadId$,
  emojiMenuTitle$,
  openChatThreadEmojiMenu$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { Link } from "../router/link.tsx";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  atTimeInTimezone,
  cronWallTimeInTimezone,
} from "../../signals/zero-page/cron.ts";

import {
  buildGmailLabelAppliedEventConfig,
  buildGmailNewMessageEventConfig,
  formatWorkflowIntervalSeconds,
  GMAIL_TEXT_FIELDS,
  getWorkflowIntervalSecondOptions,
  gmailMatcherDefaultValue,
  gmailAutomationSummary,
  gmailAutomationTitle,
} from "../workflows-page/workflow-shared.tsx";
import {
  WorkflowAutomationCard,
  type WorkflowAutomationCardRow,
} from "../workflows-page/workflow-automation-card.tsx";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "./workflow-chat-prompts.ts";
import { ReplaceComposerDraftDialog } from "./replace-composer-draft-dialog.tsx";

import {
  renameChatThread$,
  type EnrichedChatMessage,
  type GroupedChatMessageGroup,
} from "../../signals/chat-page/chat-message.ts";
import type {
  ChatInputMessage,
  ChatMessage,
} from "../../signals/chat-page/chat-message-types.ts";
import type {
  ChatThreadSignals,
  QueuedChatMessageItem,
  RecommendedFollowupSource,
  ThinkingIndicatorMode,
} from "../../signals/chat-page/chat-thread-signals.ts";
import {
  applyChatThreadEmoji,
  removeChatThreadEmoji,
  CHAT_THREAD_EMOJI_OPTIONS,
} from "../../signals/chat-page/chat-thread-title.ts";
import {
  chatThreadEmojiGroups$,
  chatThreadEmojiQuery$,
  filterChatThreadEmojiGroups,
  setChatThreadEmojiQuery$,
  type ChatThreadEmojiItem,
} from "../../signals/chat-page/chat-thread-emoji.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import { ATTACH_ONLY_PLACEHOLDER } from "../../signals/chat-page/resolve-draft-attachments.ts";
import {
  useZeroChatComposer,
  type ZeroChatComposerProps,
  type QueuedComposerItem,
  type WorkflowEventComposerItem,
} from "./zero-chat-composer.tsx";
import { ChatFeedbackSelection } from "./zero-chat-feedback-selection.tsx";
import {
  computerUseHosts$,
  selectedComputerUseHostId as resolveSelectedComputerUseHostId,
  visibleComputerUseHosts,
  ZERO_DESKTOP_DOWNLOAD_URL,
} from "../../signals/zero-page/computer-use-hosts.ts";
import type { ModelProviderSelection } from "./components/model-provider-picker.tsx";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { setBillingSubPage$ } from "../../signals/zero-page/settings/workspace-settings-state.ts";
import { openSettingsDialogAt$ } from "../../signals/zero-page/settings/settings-dialog.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  applyUserPermissionGrant$,
  findPermissionInMetadata,
  resolveUserPermissionGrantPolicy,
} from "../../signals/permission-allow/permission-allow-signals.ts";
import {
  billingStatusAsync$,
  type CreditCheckoutSelection,
  startCheckout$,
  startCreditCheckout$,
} from "../../signals/zero-page/billing.ts";
import { orgPlanCapabilitiesFromBilling } from "../../signals/zero-page/org-plan-capabilities.ts";
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
  focusChatThreadContainer$,
  setChatKeyboardScrollRoot$,
} from "../../signals/chat-page/chat-keyboard.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";

type RecommendedFollowup = NonNullable<
  ChatFollowupsEvent["recommendedFollowups"]
>[number];

function isInputChatEvent(message: ChatMessage): message is ChatInputMessage {
  return (
    message.eventType === "input.prompt" ||
    message.eventType === "input.rejected"
  );
}

function asInputChatEvent(message: ChatMessage): ChatInputMessage | undefined {
  return isInputChatEvent(message) ? message : undefined;
}

function visibleStructuredPrompt(
  inputMessage: ChatInputMessage | undefined,
  structuredPromptEnabled: boolean,
): UserMessageDocument | undefined {
  return inputMessage &&
    shouldUseStructuredPrompt(
      structuredPromptEnabled,
      inputMessage.structuredPrompt,
    )
    ? inputMessage.structuredPrompt
    : undefined;
}

function chatEventAttachments(message: ChatMessage) {
  return isInputChatEvent(message) || message.eventType === "run.completed"
    ? message.attachFiles
    : undefined;
}

function chatEventError(message: ChatMessage): string | undefined {
  if (
    message.eventType === "input.rejected" ||
    message.eventType === "output.error" ||
    message.eventType === "run.failed" ||
    message.eventType === "run.cancelled"
  ) {
    return message.error;
  }
  return undefined;
}

function ArtifactsButton({ thread }: { thread: ChatThreadSignals }) {
  return <ArtifactsButtonInner thread={thread} />;
}

function ArtifactsButtonInner({ thread }: { thread: ChatThreadSignals }) {
  const newSidebarEnabled = useGet(newChatThreadSidebarEnabled$);
  const inboxThreadId = useGet(currentArtifactInboxThreadId$);
  const sidebarTarget = useGet(thread.sidebar.target$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const openThreadArtifacts = useOpenThreadArtifacts(thread);
  const open = newSidebarEnabled
    ? sidebarTarget?.type === "artifacts"
    : inboxThreadId === thread.threadId;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              reloadArtifacts();
              openThreadArtifacts();
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
// Loads automations and only renders once this thread has at least one linked
// automation.
export function AutomationMenuButton({
  thread,
  ariaLabel = "Automations",
}: {
  thread: ChatThreadSignals;
  ariaLabel?: string;
}) {
  const reloadAutomations = useSet(thread.headerAutomations.reload$);
  const newSidebarEnabled = useGet(newChatThreadSidebarEnabled$);
  const openAutomationSidebar = useSet(openThreadAutomations$);
  const openThreadId = useGet(currentHeaderAutomationThreadId$);
  const sidebarTarget = useGet(thread.sidebar.target$);
  const workflowAutomations$ = thread.headerAutomations.automations$;
  const workflowAutomationsLoadable = useLastLoadable(workflowAutomations$);
  const lastResolvedAutomations = useLastResolved(workflowAutomations$);
  const workflowAutomations =
    workflowAutomationsLoadable.state === "hasData"
      ? workflowAutomationsLoadable.data
      : (lastResolvedAutomations ?? []);
  const open = newSidebarEnabled
    ? sidebarTarget?.type === "automations"
    : openThreadId === thread.threadId;

  // Show the opener when the thread has a workflow automation.
  // Goals live in the composer, so a goal-only thread has nothing here.
  if (workflowAutomations.length === 0) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
              open
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground/70 hover:bg-accent hover:text-foreground",
            )}
            aria-label={ariaLabel}
            aria-pressed={open}
            onClick={() => {
              reloadAutomations();
              openAutomationSidebar(thread);
            }}
          >
            <IconClock size={18} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open automations</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
function ChatThreadHeader({ thread }: { thread: ChatThreadSignals }) {
  const threadTitle = useGet(thread.threadTitle$)?.trim() ?? "";
  const threadTitleEmoji = useGet(thread.threadTitleEmoji$);
  const threadTitleText = useGet(thread.threadTitleText$);
  const openRenameChatThreadDialog = useSet(
    openRenameChatThreadDialogForThreadId$,
  );
  const pageSignal = useGet(pageSignal$);
  function openRenameDialog(event: ReactMouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    detach(
      openRenameChatThreadDialog(thread.threadId, pageSignal),
      Reason.DomCallback,
    );
  }

  return (
    <header className="hidden sm:flex shrink-0 bg-transparent px-6 py-3 items-center justify-between">
      <div className="flex min-w-0 items-center gap-2">
        <ChatThreadEmojiMenuButton
          threadId={thread.threadId}
          title={threadTitle}
          emoji={threadTitleEmoji}
        />
        {threadTitleText && (
          <span
            className="min-w-0 truncate text-sm font-medium text-foreground"
            data-testid="chat-thread-header-title"
            onDoubleClick={openRenameDialog}
          >
            {threadTitleText}
          </span>
        )}
      </div>
      <div className="hidden sm:flex items-center gap-0.5">
        <AutomationMenuButton key={thread.threadId} thread={thread} />
        <ArtifactsButton thread={thread} />
      </div>
    </header>
  );
}

function useChatThreadEmojiMenuActions({
  threadId,
  title,
}: {
  threadId: string;
  title: string | null | undefined;
}) {
  const emojiMenuThreadId = useGet(emojiMenuThreadId$);
  const emojiMenuTitle = useGet(emojiMenuTitle$);
  const openChatThreadEmojiMenu = useSet(openChatThreadEmojiMenu$);
  const closeChatThreadEmojiMenu = useSet(closeChatThreadEmojiMenu$);
  const renameChatThread = useSet(renameChatThread$);
  const focusChatThreadContainer = useSet(focusChatThreadContainer$);
  const pageSignal = useGet(pageSignal$);
  const open = emojiMenuThreadId === threadId;

  function closeMenu() {
    const openThreadId = emojiMenuThreadId;
    closeChatThreadEmojiMenu();
    if (openThreadId) {
      queueMicrotask(() => {
        focusChatThreadContainer(openThreadId);
      });
    }
  }

  function selectEmoji(nextEmoji: string) {
    const activeThreadId = emojiMenuThreadId;
    if (!activeThreadId) {
      return;
    }
    detach(
      (async () => {
        await renameChatThread(
          {
            threadId: activeThreadId,
            title: applyChatThreadEmoji(emojiMenuTitle ?? title, nextEmoji),
          },
          pageSignal,
        );
        closeMenu();
      })(),
      Reason.DomCallback,
    );
  }

  function clearEmoji() {
    const activeThreadId = emojiMenuThreadId;
    if (!activeThreadId) {
      return;
    }
    const nextTitle = removeChatThreadEmoji(emojiMenuTitle ?? title);
    if (!nextTitle) {
      closeMenu();
      return;
    }
    detach(
      (async () => {
        await renameChatThread(
          { threadId: activeThreadId, title: nextTitle },
          pageSignal,
        );
        closeMenu();
      })(),
      Reason.DomCallback,
    );
  }

  return { open, openChatThreadEmojiMenu, closeMenu, selectEmoji, clearEmoji };
}

function ChatThreadEmojiMenuButton({
  emoji,
  threadId,
  title,
}: {
  emoji: string | null | undefined;
  threadId: string;
  title: string | null | undefined;
}) {
  const { open, openChatThreadEmojiMenu, closeMenu, selectEmoji, clearEmoji } =
    useChatThreadEmojiMenuActions({ threadId, title });
  const setEmojiQuery = useSet(setChatThreadEmojiQuery$);

  return (
    <TooltipProvider delayDuration={200}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setEmojiQuery("");
            openChatThreadEmojiMenu({ threadId, title });
          } else {
            closeMenu();
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Change icon"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {emoji ? (
                  <span
                    aria-hidden="true"
                    className="zero-emoji text-base leading-none"
                  >
                    {emoji}
                  </span>
                ) : (
                  <IconMoodPlus size={18} stroke={1.75} aria-hidden="true" />
                )}
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Chat thread icon</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          className="w-80 p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          <ChatThreadEmojiPicker
            hasEmoji={Boolean(emoji)}
            onSelect={selectEmoji}
            onRemove={clearEmoji}
          />
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

const FREQUENTLY_USED_EMOJI: ChatThreadEmojiItem[] =
  CHAT_THREAD_EMOJI_OPTIONS.map((option) => {
    return { emoji: option.emoji, name: option.label };
  });

function ChatThreadEmojiPicker({
  hasEmoji,
  onSelect,
  onRemove,
}: {
  hasEmoji: boolean;
  onSelect: (emoji: string) => void;
  onRemove: () => void;
}) {
  const query = useGet(chatThreadEmojiQuery$);
  const setQuery = useSet(setChatThreadEmojiQuery$);
  const groups = useLastResolved(chatThreadEmojiGroups$) ?? null;

  const isSearching = query.trim().length > 0;
  const searchResults =
    isSearching && groups ? filterChatThreadEmojiGroups(groups, query) : [];

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 p-2">
        <div className="relative flex-1">
          <IconSearch
            size={15}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label="Search emoji"
            placeholder="Search emoji"
            value={query}
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className="h-8 pl-8"
          />
        </div>
        {hasEmoji && (
          <button
            type="button"
            className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onRemove}
          >
            Remove
          </button>
        )}
      </div>
      <div className="max-h-72 overflow-y-auto px-2 pb-2">
        {isSearching ? (
          searchResults.length > 0 ? (
            <ChatThreadEmojiGrid items={searchResults} onSelect={onSelect} />
          ) : (
            <p className="px-1 py-6 text-center text-xs text-muted-foreground">
              No emoji found
            </p>
          )
        ) : (
          <>
            <ChatThreadEmojiSection
              label="Frequently used"
              items={FREQUENTLY_USED_EMOJI}
              onSelect={onSelect}
              showShortcutDigits
            />
            {groups?.map((group) => {
              return (
                <ChatThreadEmojiSection
                  key={group.name}
                  label={group.name}
                  items={group.emojis}
                  onSelect={onSelect}
                />
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function ChatThreadEmojiSection({
  label,
  items,
  onSelect,
  showShortcutDigits = false,
}: {
  label: string;
  items: ChatThreadEmojiItem[];
  onSelect: (emoji: string) => void;
  showShortcutDigits?: boolean;
}) {
  // Ctrl+Shift is a shared prefix for every digit shortcut, so surface it once
  // as a quiet hint next to the label rather than repeating it on each emoji.
  // getShortcutParts keeps the modifiers OS-aware (⌃⇧ on Mac, Ctrl+Shift else).
  const shortcutHint = showShortcutDigits
    ? `${formatModifierPrefix(getShortcutParts("ctrl+shift"))} + number`
    : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 px-1 pb-1 pt-2">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        {shortcutHint && (
          <span className="text-[11px] text-muted-foreground/70">
            {shortcutHint}
          </span>
        )}
      </div>
      <ChatThreadEmojiGrid
        items={items}
        onSelect={onSelect}
        showShortcutDigits={showShortcutDigits}
      />
    </div>
  );
}

// Join modifier keycap labels the way each platform reads them: Mac symbols
// run together (⌃⇧), word labels are joined with "+" (Ctrl+Shift).
function formatModifierPrefix(modifiers: string[]): string {
  const usesWords = /[A-Za-z]/.test(modifiers[0] ?? "");
  return modifiers.join(usesWords ? "+" : "");
}

function ChatThreadEmojiGrid({
  items,
  onSelect,
  showShortcutDigits = false,
}: {
  items: ChatThreadEmojiItem[];
  onSelect: (emoji: string) => void;
  showShortcutDigits?: boolean;
}) {
  // Nine columns so the nine frequently-used digit shortcuts sit on a single
  // row; every other emoji group uses the same width to stay aligned.
  return (
    <div className="grid grid-cols-9 gap-0.5">
      {items.map((item, index) => {
        // Ctrl+Shift+1-9 set the first nine "frequently used" icons. Keep a
        // faint digit in the corner and reveal the full combo on hover so the
        // shortcut is discoverable without cluttering the grid.
        const shortcutDigit =
          showShortcutDigits && index < 9 ? index + 1 : null;
        const shortcutLabel =
          shortcutDigit !== null
            ? getShortcutLabel(`ctrl+shift+${shortcutDigit}`)
            : undefined;
        return (
          <button
            key={`${item.name}-${item.emoji}`}
            type="button"
            aria-label={item.name}
            title={shortcutLabel}
            className="relative flex aspect-square items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-accent"
            onClick={() => {
              onSelect(item.emoji);
            }}
          >
            <span aria-hidden="true" className="zero-emoji">
              {item.emoji}
            </span>
            {shortcutDigit !== null && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 right-0.5 text-[9px] leading-none text-muted-foreground/60"
              >
                {shortcutDigit}
              </span>
            )}
          </button>
        );
      })}
    </div>
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

function formatChatTimestamp(value: string): string {
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

const ARTIFACT_INBOX_SECTIONS = [
  { key: "all", label: "All" },
  { key: "media", label: "Media" },
  { key: "docs", label: "Docs" },
  { key: "sites", label: "Sites" },
] as const satisfies readonly {
  key: ArtifactInboxSection;
  label: string;
}[];

type ArtifactInboxSectionEntry = (typeof ARTIFACT_INBOX_SECTIONS)[number];

function artifactItemKey(item: ChatArtifactItem): string {
  return `${item.runId}:${item.file.id}:${item.file.url}`;
}

function getArtifactPreviewKind(
  file: ChatThreadArtifactFile,
): ArtifactPreviewKind {
  const kind = classifyChatAttachment({
    filename: file.filename,
    url: file.url,
    contentType: file.contentType,
  });

  if (kind === "image") {
    return "image";
  }
  if (kind === "video") {
    return "video";
  }
  if (kind === "audio") {
    return "audio";
  }
  if (
    kind === "markdown" ||
    kind === "text" ||
    kind === "json" ||
    kind === "csv" ||
    kind === "pdf" ||
    kind === "html"
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

function artifactFileKindLabel(file: ChatThreadArtifactFile): string {
  if (file.artifactKind === "presentation-html") {
    return "Presentation";
  }
  const documentKind = getArtifactDocumentPreviewKind(file);
  if (documentKind === "html") {
    return "Hosted site";
  }
  if (documentKind === "pdf") {
    return "PDF";
  }
  if (documentKind === "markdown") {
    return "Markdown";
  }
  if (documentKind === "json") {
    return "JSON";
  }
  if (documentKind === "csv") {
    return "Data";
  }
  if (documentKind === "text") {
    return "Text";
  }

  const previewKind = getArtifactPreviewKind(file);
  switch (previewKind) {
    case "image": {
      return "Image";
    }
    case "video": {
      return "Video";
    }
    case "audio": {
      return "Audio";
    }
    case "document": {
      return "Document";
    }
    case "file": {
      return "File";
    }
  }
}

function artifactMatchesInboxSection(
  item: ChatArtifactItem,
  section: ArtifactInboxSection,
): boolean {
  if (section === "all") {
    return true;
  }

  const documentKind = getArtifactDocumentPreviewKind(item.file);
  if (section === "sites") {
    return documentKind === "html";
  }
  if (section === "docs") {
    return documentKind !== null && documentKind !== "html";
  }

  const previewKind = getArtifactPreviewKind(item.file);
  return (
    previewKind === "image" ||
    previewKind === "video" ||
    previewKind === "audio"
  );
}

function artifactInboxSectionsForItems(
  items: readonly ChatArtifactItem[],
): readonly ArtifactInboxSectionEntry[] {
  return ARTIFACT_INBOX_SECTIONS.filter((entry) => {
    return (
      entry.key === "all" ||
      items.some((item) => {
        return artifactMatchesInboxSection(item, entry.key);
      })
    );
  });
}

function resolveVisibleArtifactInboxSection(
  section: ArtifactInboxSection,
  sections: readonly ArtifactInboxSectionEntry[],
): ArtifactInboxSection {
  return sections.some((entry) => {
    return entry.key === section;
  })
    ? section
    : "all";
}

function artifactMatchesSearch(item: ChatArtifactItem, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const haystack =
    `${item.file.filename} ${item.file.contentType}`.toLowerCase();
  return haystack.includes(query);
}

function ArtifactFileIcon({
  file,
  size = "sm",
}: {
  file: ChatThreadArtifactFile;
  size?: "sm" | "md";
}) {
  return (
    <FilePreviewIcon
      filename={file.filename}
      contentType={file.contentType}
      size={size}
      testId="artifact-file-icon"
    />
  );
}

function ArtifactPreviewBadge({ file }: { file: ChatThreadArtifactFile }) {
  const previewKind = getArtifactPreviewKind(file);
  const publicUrl = publicAttachmentUrl(file.url);

  if (previewKind === "image") {
    return (
      <img
        src={r2ImageTransformUrl(publicUrl, { width: 96, height: 96 })}
        alt=""
        aria-hidden="true"
        className="h-full w-full object-cover"
      />
    );
  }

  if (previewKind === "video") {
    const videoFallback = (
      <video
        src={videoPosterFrameUrl(publicUrl)}
        preload="metadata"
        muted
        playsInline
        aria-hidden="true"
        className="h-full w-full object-cover"
        data-testid="artifact-video-preview-fallback"
      />
    );
    return (
      <span
        aria-hidden="true"
        className="relative block h-full w-full overflow-hidden bg-black"
        data-testid="artifact-video-preview-badge"
      >
        {file.previewImageUrl ? (
          <ArtifactThumbnailImage
            src={file.previewImageUrl}
            testId="artifact-video-thumbnail-badge"
            className="absolute inset-0 h-full w-full object-cover"
            fallback={videoFallback}
          />
        ) : (
          videoFallback
        )}
      </span>
    );
  }

  if (getArtifactDocumentPreviewKind(file) === "html") {
    const iframeFallback = (
      <iframe
        src={publicUrl}
        title={`${file.filename} artifact thumbnail`}
        sandbox="allow-same-origin allow-scripts"
        tabIndex={-1}
        loading="lazy"
        scrolling="no"
        className="pointer-events-none absolute left-0 top-0 h-[400%] w-[400%] origin-top-left scale-[0.25] border-0 bg-background"
      />
    );
    return (
      <span
        className="relative block h-full w-full overflow-hidden bg-background"
        aria-hidden="true"
        data-testid="artifact-html-preview-badge"
      >
        {file.previewImageUrl ? (
          <ArtifactThumbnailImage
            src={file.previewImageUrl}
            testId="artifact-html-thumbnail-badge"
            className="absolute inset-0 h-full w-full object-cover"
            fallback={iframeFallback}
          />
        ) : (
          iframeFallback
        )}
      </span>
    );
  }

  return <ArtifactFileIcon file={file} />;
}

type ArtifactTextPreviewKind = "markdown" | "text" | "json" | "csv";
type ArtifactDocumentPreviewKind = ArtifactTextPreviewKind | "pdf" | "html";

function getArtifactTextPreviewKind(
  file: ChatThreadArtifactFile,
): ArtifactTextPreviewKind | null {
  const kind = classifyChatAttachment({
    filename: file.filename,
    url: file.url,
    contentType: file.contentType,
  });

  if (
    kind === "markdown" ||
    kind === "text" ||
    kind === "json" ||
    kind === "csv"
  ) {
    return kind;
  }

  if (/\.log$/i.test(file.filename)) {
    return "text";
  }

  return null;
}

function getArtifactDocumentPreviewKind(
  file: ChatThreadArtifactFile,
): ArtifactDocumentPreviewKind | null {
  const textKind = getArtifactTextPreviewKind(file);
  if (textKind) {
    return textKind;
  }

  const contentType = file.contentType.toLowerCase();
  const filename = file.filename.toLowerCase();
  if (contentType === "application/pdf" || filename.endsWith(".pdf")) {
    return "pdf";
  }
  if (
    contentType === "text/html" ||
    filename.endsWith(".html") ||
    filename.endsWith(".htm")
  ) {
    return "html";
  }

  return null;
}

type ChatImagePreviewLinkProps = {
  alt: string;
  ariaLabel: string;
  imageClassName: string;
  linkClassName: string;
  onPreview: () => void;
  placeholderClassName: string;
  url: string;
};

const CHAT_INLINE_MEDIA_PREVIEW_CHROME_CLASS = cn(
  "border border-foreground/10 shadow-sm transition-all duration-200",
  "hover:scale-[1.015] hover:border-foreground/20 hover:shadow-lg hover:shadow-black/10 dark:hover:shadow-black/30",
);
const CHAT_INLINE_MEDIA_THUMBNAIL_PREVIEW_CLASS = cn(
  "aspect-[10/9] w-[50px] max-w-full cursor-pointer rounded-lg",
  CHAT_INLINE_MEDIA_PREVIEW_CHROME_CLASS,
);
const CHAT_INLINE_IMAGE_PREVIEW_CLASS = cn(
  CHAT_INLINE_MEDIA_THUMBNAIL_PREVIEW_CLASS,
  "bg-muted/30",
);
const CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS = cn(
  CHAT_INLINE_MEDIA_THUMBNAIL_PREVIEW_CLASS,
  "bg-black",
);
const CHAT_INLINE_VIDEO_BODY_PREVIEW_CLASS = cn(
  "aspect-[16/10] w-[min(100%,400px)] max-w-full cursor-pointer rounded-lg",
  CHAT_INLINE_MEDIA_PREVIEW_CHROME_CLASS,
  "bg-black",
);

const ARTIFACT_FULLSCREEN_SHELL_CLASSNAME =
  "fixed inset-0 z-[100] flex min-h-0 flex-col bg-background pt-[var(--sat)] pb-[var(--sab)]";

function ChatImagePreviewLink({
  alt,
  ariaLabel,
  imageClassName,
  linkClassName,
  onPreview,
  placeholderClassName,
  url,
}: ChatImagePreviewLinkProps) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageUrl = publicAttachmentUrl(url);
  const previewImageUrl = r2ImageTransformUrl(imageUrl, {
    width: 800,
    height: 720,
  });
  const imageLoadKey = `chat-image-preview:${previewImageUrl}`;
  const imageStatus = imageLoadStatuses[imageLoadKey] ?? "loading";

  const showPlaceholder = imageStatus !== "loaded";

  const openPreview = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    onPreview();
  };

  return (
    <a
      href={imageUrl}
      onClick={openPreview}
      className={cn(
        "group/image-preview relative inline-flex self-start items-center justify-center overflow-hidden",
        linkClassName,
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
        src={previewImageUrl}
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
    </a>
  );
}

type ChatVideoPreviewButtonProps = {
  ariaLabel: string;
  buttonClassName: string;
  filename: string;
  onPreview: () => void;
  posterClassName: string;
  previewImagePending?: boolean;
  previewImageUrl?: string;
  url: string;
  videoClassName: string;
};

function videoPosterFrameUrl(url: string): string {
  const hashIndex = url.indexOf("#");
  const urlWithoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  return `${urlWithoutHash}#t=0.001`;
}

function ChatVideoPreviewButton({
  ariaLabel,
  buttonClassName,
  filename,
  onPreview,
  posterClassName,
  previewImagePending,
  previewImageUrl,
  url,
  videoClassName,
}: ChatVideoPreviewButtonProps) {
  const videoUrl = publicAttachmentUrl(url);
  const posterVideoUrl = videoPosterFrameUrl(videoUrl);
  const videoFallback = (
    <video
      src={posterVideoUrl}
      preload="metadata"
      muted
      playsInline
      aria-hidden="true"
      className={cn("absolute inset-0", videoClassName)}
      data-testid="chat-video-preview-fallback"
    />
  );

  return (
    <button
      type="button"
      onClick={onPreview}
      title={filename}
      aria-label={ariaLabel}
      className={cn(
        "group/video-preview relative inline-flex items-center justify-center overflow-hidden",
        buttonClassName,
      )}
    >
      <span
        data-testid="chat-video-preview-poster"
        className={cn("block bg-black", posterClassName)}
      />
      {previewImageUrl ? (
        <ArtifactThumbnailImage
          src={previewImageUrl}
          testId="chat-video-preview-thumbnail"
          className={cn("absolute inset-0", videoClassName)}
          fallback={videoFallback}
        />
      ) : previewImagePending ? null : (
        videoFallback
      )}
      <span className="absolute inset-0 flex items-center justify-center bg-black/10 transition-colors group-hover/video-preview:bg-black/35">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white shadow-lg transition-transform group-hover/video-preview:scale-105">
          <IconPlayerPlay size={17} stroke={1.8} />
        </span>
      </span>
    </button>
  );
}

function ChatArtifactInboxHeader({
  count,
  fullscreen,
  searchOpen,
  onClose,
  onToggleSearch,
  onToggleFullscreen,
}: {
  count: number | null;
  fullscreen: boolean;
  searchOpen: boolean;
  onClose: () => void;
  onToggleSearch: () => void;
  onToggleFullscreen: () => void;
}) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h2 className="truncate text-sm font-medium text-foreground">
          Artifacts
        </h2>
        {count !== null && (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleSearch}
              aria-label="Search artifacts"
              aria-pressed={searchOpen}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                searchOpen && "bg-muted/60 text-foreground",
              )}
            >
              <IconSearch size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Search artifacts</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleFullscreen}
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              data-testid="artifact-inbox-fullscreen-toggle"
              className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground xl:inline-flex"
            >
              {fullscreen ? (
                <IconArrowsDiagonalMinimize2 size={16} />
              ) : (
                <IconArrowsDiagonal size={16} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close artifacts"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <IconX size={16} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close artifacts</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function ArtifactInboxTabs({
  section,
  sections,
  setSection,
}: {
  section: ArtifactInboxSection;
  sections: readonly ArtifactInboxSectionEntry[];
  setSection: (value: ArtifactInboxSection) => void;
}) {
  return (
    <div
      className="grid rounded-lg bg-muted/70 p-1"
      style={{
        gridTemplateColumns: `repeat(${sections.length}, minmax(0, 1fr))`,
      }}
      role="tablist"
      aria-label="Artifact sections"
    >
      {sections.map((entry) => {
        const selected = section === entry.key;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              setSection(entry.key);
            }}
            className={cn(
              "h-8 rounded-md px-2 text-xs font-medium transition-colors",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

function ArtifactInboxSearch({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (value: string) => void;
}) {
  return (
    <label className="relative block">
      <span className="sr-only">Search artifacts</span>
      <IconSearch
        size={15}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
        className="h-9 w-full rounded-lg border border-border/70 bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
        placeholder="Search"
        autoComplete="off"
        autoFocus
      />
    </label>
  );
}

function ArtifactInboxRow({
  item,
  onOpen,
}: {
  item: ChatArtifactItem;
  onOpen: () => void;
}) {
  const { file } = item;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open artifact ${file.filename}`}
      className="group flex w-full min-w-0 items-center gap-3 rounded-lg border border-border/60 bg-background/80 p-3 text-left shadow-sm transition-colors hover:border-foreground/20 hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
        <ArtifactPreviewBadge file={file} />
      </span>
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-sm font-medium text-foreground"
          title={file.filename}
        >
          {file.filename}
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{artifactFileKindLabel(file)}</span>
          <span aria-hidden>·</span>
          <span>{formatBytes(file.size)}</span>
          <span aria-hidden>·</span>
          <span>{formatChatTimestamp(file.createdAt)}</span>
        </span>
      </span>
      <IconChevronRight
        size={16}
        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
      />
    </button>
  );
}

function ChatArtifactInboxBody({ thread }: { thread: ChatThreadSignals }) {
  const loadable = useLastLoadable(thread.artifacts$);
  const section = useGet(artifactInboxSection$);
  const query = useGet(artifactInboxQuery$);
  const searchOpen = useGet(artifactInboxSearchOpen$);
  const setSection = useSet(setArtifactInboxSection$);
  const setQuery = useSet(setArtifactInboxQuery$);
  const openArtifact = useSet(openArtifactFromInbox$);

  if (loadable.state === "loading") {
    return (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }, (_, i) => {
          return <Skeleton key={i} className="h-[74px] rounded-lg" />;
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

  const items = flattenArtifactRuns(loadable.data);
  if (items.length === 0) {
    return (
      <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/70 p-8 text-center">
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

  const normalizedQuery = query.trim().toLowerCase();
  const sections = artifactInboxSectionsForItems(items);
  const activeSection = resolveVisibleArtifactInboxSection(section, sections);
  const visibleItems = items.filter((item) => {
    return (
      artifactMatchesInboxSection(item, activeSection) &&
      artifactMatchesSearch(item, normalizedQuery)
    );
  });

  return (
    <div className="flex min-h-full flex-col gap-4">
      <ArtifactInboxTabs
        section={activeSection}
        sections={sections}
        setSection={setSection}
      />
      {(searchOpen || query.length > 0) && (
        <ArtifactInboxSearch query={query} setQuery={setQuery} />
      )}
      {visibleItems.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/70 p-8 text-center text-sm text-muted-foreground">
          No artifacts match this view.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleItems.map((item) => {
            return (
              <ArtifactInboxRow
                key={artifactItemKey(item)}
                item={item}
                onOpen={() => {
                  openArtifact({
                    threadId: thread.threadId,
                    url: item.file.url,
                  });
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChatArtifactInboxList({ thread }: { thread: ChatThreadSignals }) {
  const loadable = useLastLoadable(thread.artifacts$);
  const fullscreen = useGet(artifactFullscreen$);
  const searchOpen = useGet(artifactInboxSearchOpen$);
  const toggleFullscreen = useSet(toggleArtifactFullscreen$);
  const toggleSearch = useSet(toggleArtifactInboxSearch$);
  const close = useSet(closeArtifact$);
  const count =
    loadable.state === "hasData"
      ? flattenArtifactRuns(loadable.data).length
      : null;

  const inbox = (
    <div
      className={cn(
        fullscreen
          ? ARTIFACT_FULLSCREEN_SHELL_CLASSNAME
          : "flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0",
        "animate-in fade-in duration-[180ms] ease",
      )}
      data-testid="artifact-inbox"
    >
      <ChatArtifactInboxHeader
        count={count}
        fullscreen={fullscreen}
        searchOpen={searchOpen}
        onToggleSearch={toggleSearch}
        onToggleFullscreen={toggleFullscreen}
        onClose={close}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ChatArtifactInboxBody thread={thread} />
      </div>
    </div>
  );
  return fullscreen && typeof document !== "undefined"
    ? createPortal(inbox, document.body)
    : inbox;
}

function ChatArtifactInboxSlot({
  artifactRef,
  leftThread,
  rightThread,
}: {
  artifactRef: ArtifactRef | null;
  leftThread: ChatThreadSignals | null;
  rightThread: ChatThreadSignals | null;
}) {
  const inboxThreadId = useGet(currentArtifactInboxThreadId$);
  const backToInbox = useSet(backToArtifactInbox$);
  const close = useSet(closeArtifact$);
  const thread =
    [leftThread, rightThread].find((candidate) => {
      return candidate?.threadId === inboxThreadId;
    }) ??
    leftThread ??
    rightThread;

  if (artifactRef) {
    return (
      <ArtifactSidebar
        artifactRef={artifactRef}
        thread={thread ?? undefined}
        onBack={inboxThreadId ? backToInbox : undefined}
        onClose={close}
      />
    );
  }

  if (!thread || !inboxThreadId) {
    return null;
  }

  return <ChatArtifactInboxList key={thread.threadId} thread={thread} />;
}

function formatHeaderWorkflowAutomationRun(value: string | null): string {
  if (!value) {
    return "No runs yet";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "No runs yet";
  }
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatHeaderWorkflowAutomationNextRun(value: string | null): string {
  if (!value) {
    return "No upcoming run";
  }
  return formatHeaderWorkflowAutomationRun(value);
}

function formatHeaderClockTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function formatHeaderIntervalSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `Every ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function headerCronRuleLabel(
  cronExpression: string,
  sourceTimezone: string,
  displayTimezone: string,
): string {
  const [minutePart, hourPart, dayOfMonth = "*", , dayOfWeek = "*"] =
    cronExpression.split(" ");
  const minute = Number(minutePart);
  const hour = Number(hourPart);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return `${cronExpression} (${sourceTimezone})`;
  }
  const converted = cronWallTimeInTimezone(
    hour,
    minute,
    sourceTimezone,
    displayTimezone,
  );
  const time = formatHeaderClockTime(converted.hour, converted.minute);
  if (dayOfMonth !== "*") {
    return `Every month on day ${dayOfMonth} at ${time}`;
  }
  if (dayOfWeek === "1-5") {
    return `Every weekday at ${time}`;
  }
  if (dayOfWeek !== "*") {
    const dayNames: Readonly<Record<string, string>> = {
      "0": "Sunday",
      "1": "Monday",
      "2": "Tuesday",
      "3": "Wednesday",
      "4": "Thursday",
      "5": "Friday",
      "6": "Saturday",
    };
    const days = dayOfWeek
      .split(",")
      .map((day) => {
        return dayNames[day];
      })
      .filter(Boolean)
      .join(", ");
    return days ? `Every week on ${days} at ${time}` : `Every week at ${time}`;
  }
  return `Every day at ${time}`;
}

function headerWorkflowAutomationRule(
  automation: HeaderWorkflowAutomationEntry,
): string {
  const source = automation.automation;
  if (source.kind !== "schedule") {
    return gmailAutomationTitle(source);
  }
  const schedule = source.schedule;
  if (schedule.type === "loop") {
    return formatHeaderIntervalSeconds(schedule.intervalSeconds);
  }
  if (schedule.type === "once") {
    const { date, hour, minute } = atTimeInTimezone(
      schedule.atTime,
      automation.timezone,
    );
    return `Once on ${date} at ${formatHeaderClockTime(hour, minute)}`;
  }
  return headerCronRuleLabel(
    schedule.cronExpression,
    schedule.timezone,
    automation.timezone,
  );
}

function headerWorkflowAutomationRows(
  automation: HeaderWorkflowAutomationEntry,
): readonly WorkflowAutomationCardRow[] {
  const rows: WorkflowAutomationCardRow[] = [
    {
      label: "Status",
      value: automation.enabled ? "Active" : "Disabled",
    },
    {
      label:
        automation.automation.kind === "schedule" ? "Schedule" : "Automation",
      value: headerWorkflowAutomationRule(automation),
    },
    {
      label: "Last run",
      value: formatHeaderWorkflowAutomationRun(automation.automation.lastRunAt),
    },
  ];
  if (automation.automation.kind === "schedule") {
    rows.push({
      label: "Next run",
      value: formatHeaderWorkflowAutomationNextRun(
        automation.automation.nextRunAt,
      ),
    });
  }
  const matchSummary = gmailAutomationSummary(automation.automation);
  if (matchSummary) {
    rows.splice(1, 0, { label: "Match", value: matchSummary });
  }
  return rows;
}

function HeaderWorkflowAutomationCard({
  automation,
  headerAutomations,
}: {
  automation: HeaderWorkflowAutomationEntry;
  headerAutomations: HeaderAutomationSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const editingAutomationId = useGet(currentEditingHeaderWorkflowAutomationId$);
  const setEditingAutomationId = useSet(setEditingHeaderWorkflowAutomationId$);
  const [runningLoadable, runNow] = useLoadableSet(headerAutomations.runNow$);
  const running = runningLoadable.state === "loading";
  const title =
    automation.workflowDisplayName?.trim() || automation.workflowName;
  const rows = headerWorkflowAutomationRows(automation);
  const editing = editingAutomationId === automation.id;

  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-normal leading-snug text-muted-foreground">
          {title}
        </p>
        <Link
          pathname={ROUTES.workflowDetailAutomations}
          options={{
            pathParams: {
              workflowId: automation.workflowId,
            },
          }}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
        >
          View
          <IconArrowUpRight size={12} stroke={1.5} />
        </Link>
      </div>
      <WorkflowAutomationCard
        rows={rows}
        dimmed={!automation.enabled}
        actions={
          <>
            {automation.automation.kind === "schedule" ||
            (automation.automation.kind === "event" &&
              (automation.automation.eventType === "gmail-new-message" ||
                automation.automation.eventType === "gmail-label-applied")) ? (
              <button
                type="button"
                className="rounded-md px-1 py-1 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                onClick={() => {
                  setEditingAutomationId(automation.id);
                }}
              >
                Edit
              </button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="zero-btn-morandi h-8 shrink-0 gap-1.5 rounded-lg px-3 text-xs font-medium"
              disabled={running}
              onClick={() => {
                detach(
                  runNow(automation.id, pageSignal),
                  Reason.DomCallback,
                  "run header workflow automation now",
                );
              }}
            >
              {running ? (
                <IconLoader2 size={13} className="animate-spin" />
              ) : (
                <IconPlayerPlay size={13} stroke={1.5} />
              )}
              {running ? "Starting..." : "Run now"}
            </Button>
          </>
        }
      />
      <HeaderWorkflowAutomationEditDialog
        automation={automation.automation}
        headerAutomations={headerAutomations}
        displayTimezone={automation.timezone}
        open={editing}
        onOpenChange={(open) => {
          setEditingAutomationId(open ? automation.id : null);
        }}
      />
    </div>
  );
}

function HeaderWorkflowAutomationEditDialog({
  automation,
  headerAutomations,
  displayTimezone,
  open,
  onOpenChange,
}: {
  readonly automation: ChatThreadWorkflowAutomation;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly displayTimezone: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          automation.kind === "event" &&
          automation.eventType === "gmail-new-message"
            ? "max-w-2xl"
            : ""
        }
      >
        <DialogHeader>
          <DialogTitle>Edit automation</DialogTitle>
          <DialogDescription>
            Update this workflow automation.
          </DialogDescription>
        </DialogHeader>
        {automation.kind === "schedule" ? (
          <HeaderScheduleAutomationEditForm
            automation={automation}
            headerAutomations={headerAutomations}
            displayTimezone={displayTimezone}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-new-message" ? (
          <HeaderGmailNewMessageAutomationEditForm
            automation={automation}
            headerAutomations={headerAutomations}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
        {automation.kind === "event" &&
        automation.eventType === "gmail-label-applied" ? (
          <HeaderGmailLabelAutomationEditForm
            automation={automation}
            headerAutomations={headerAutomations}
            onDone={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const HEADER_AUTOMATION_FIELD_CLASS =
  "h-9 w-full rounded-md border border-border/60 bg-background px-2.5 text-sm outline-none transition-colors focus:border-primary disabled:opacity-60";

function localDateTimeInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function scheduleFromHeaderAutomationForm(
  automation: Extract<ChatThreadWorkflowAutomation, { kind: "schedule" }>,
  form: FormData,
): ZeroWorkflowSchedule | null {
  const schedule = automation.schedule;
  if (schedule.type === "loop") {
    const intervalSeconds = Number(form.get("intervalSeconds"));
    return Number.isInteger(intervalSeconds) && intervalSeconds > 0
      ? { type: "loop", intervalSeconds }
      : null;
  }
  if (schedule.type === "once") {
    const rawAtTime = String(form.get("atTime") ?? "");
    if (!rawAtTime) {
      return null;
    }
    const atTime = new Date(rawAtTime);
    return Number.isNaN(atTime.getTime())
      ? null
      : {
          type: "once",
          atTime: atTime.toISOString(),
          timezone: schedule.timezone,
        };
  }
  const cronExpression = String(form.get("cronExpression") ?? "").trim();
  return cronExpression
    ? {
        type: "cron",
        cronExpression,
        timezone: schedule.timezone,
      }
    : null;
}

function HeaderScheduleAutomationEditForm({
  automation,
  headerAutomations,
  displayTimezone,
  onDone,
}: {
  readonly automation: Extract<
    ChatThreadWorkflowAutomation,
    { kind: "schedule" }
  >;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly displayTimezone: string;
  readonly onDone: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateAutomation] = useLoadableSet(
    headerAutomations.updateSchedule$,
  );
  const saving = updateLoadable.state === "loading";
  const schedule = automation.schedule;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const scheduleValue = scheduleFromHeaderAutomationForm(
          automation,
          new FormData(event.currentTarget),
        );
        if (!scheduleValue) {
          return;
        }
        detach(
          (async () => {
            await updateAutomation(
              { automationId: automation.id, schedule: scheduleValue },
              pageSignal,
            );
            onDone();
          })(),
          Reason.DomCallback,
          "update header workflow schedule automation",
        );
      }}
    >
      {schedule.type === "loop" ? (
        <HeaderIntervalField
          disabled={saving}
          defaultIntervalSeconds={schedule.intervalSeconds}
        />
      ) : null}
      {schedule.type === "once" ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Run at
          <input
            name="atTime"
            aria-label="Run at"
            type="datetime-local"
            defaultValue={localDateTimeInputValue(schedule.atTime)}
            disabled={saving}
            className={HEADER_AUTOMATION_FIELD_CLASS}
          />
          <span>Displays in {displayTimezone}</span>
        </label>
      ) : null}
      {schedule.type === "cron" ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Cron expression
          <input
            name="cronExpression"
            aria-label="Cron expression"
            defaultValue={schedule.cronExpression}
            disabled={saving}
            className={HEADER_AUTOMATION_FIELD_CLASS}
          />
          <span>Runs in {schedule.timezone}</span>
        </label>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <IconLoader2 size={14} className="animate-spin" /> : null}
          Save automation
        </Button>
      </DialogFooter>
    </form>
  );
}

function HeaderIntervalField({
  disabled,
  defaultIntervalSeconds,
}: {
  readonly disabled: boolean;
  readonly defaultIntervalSeconds: number;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      Every
      <Select
        name="intervalSeconds"
        defaultValue={String(defaultIntervalSeconds)}
        disabled={disabled}
      >
        <SelectTrigger className="h-9 w-full" aria-label="Every">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {getWorkflowIntervalSecondOptions(defaultIntervalSeconds).map(
            (seconds) => {
              return (
                <SelectItem key={seconds} value={String(seconds)}>
                  {formatWorkflowIntervalSeconds(seconds)}
                </SelectItem>
              );
            },
          )}
        </SelectContent>
      </Select>
    </label>
  );
}

function HeaderGmailNewMessageAutomationEditForm({
  automation,
  headerAutomations,
  onDone,
}: {
  readonly automation: Extract<
    ChatThreadWorkflowAutomation,
    { eventType: "gmail-new-message" }
  >;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly onDone: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateAutomation] = useLoadableSet(
    headerAutomations.updateGmailNewMessage$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        detach(
          (async () => {
            await updateAutomation(
              {
                automationId: automation.id,
                eventConfig: buildGmailNewMessageEventConfig(
                  form,
                  automation.eventConfig,
                ),
              },
              pageSignal,
            );
            onDone();
          })(),
          Reason.DomCallback,
          "update header workflow Gmail automation",
        );
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {GMAIL_TEXT_FIELDS.map(({ field, label }) => {
          return (
            <div key={field} className="grid grid-cols-2 gap-2">
              <input
                name={`${field}Contains`}
                aria-label={`${label} contains`}
                defaultValue={gmailMatcherDefaultValue(
                  automation.eventConfig,
                  field,
                  "contains",
                )}
                disabled={saving}
                placeholder={`${label} contains`}
                className={HEADER_AUTOMATION_FIELD_CLASS}
              />
              <input
                name={`${field}DoesNotContain`}
                aria-label={`${label} does not contain`}
                defaultValue={gmailMatcherDefaultValue(
                  automation.eventConfig,
                  field,
                  "doesNotContain",
                )}
                disabled={saving}
                placeholder={`${label} does not contain`}
                className={HEADER_AUTOMATION_FIELD_CLASS}
              />
            </div>
          );
        })}
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <IconLoader2 size={14} className="animate-spin" /> : null}
          Save automation
        </Button>
      </DialogFooter>
    </form>
  );
}

function HeaderGmailLabelAutomationEditForm({
  automation,
  headerAutomations,
  onDone,
}: {
  readonly automation: Extract<
    ChatThreadWorkflowAutomation,
    { eventType: "gmail-label-applied" }
  >;
  readonly headerAutomations: HeaderAutomationSignals;
  readonly onDone: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const [updateLoadable, updateAutomation] = useLoadableSet(
    headerAutomations.updateGmailLabelApplied$,
  );
  const saving = updateLoadable.state === "loading";

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const eventConfig = buildGmailLabelAppliedEventConfig(
          new FormData(event.currentTarget),
        );
        if (!eventConfig) {
          return;
        }
        detach(
          (async () => {
            await updateAutomation(
              { automationId: automation.id, eventConfig },
              pageSignal,
            );
            onDone();
          })(),
          Reason.DomCallback,
          "update header workflow Gmail label automation",
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Label name
        <input
          name="labelName"
          aria-label="Label name"
          required
          defaultValue={automation.eventConfig.labelName}
          disabled={saving}
          placeholder="Support"
          className={HEADER_AUTOMATION_FIELD_CLASS}
        />
      </label>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <IconLoader2 size={14} className="animate-spin" /> : null}
          Save automation
        </Button>
      </DialogFooter>
    </form>
  );
}
function HeaderAutomationSidebar({
  thread,
  onClose,
}: {
  thread: ChatThreadSignals;
  // Overrides the legacy search-param close when the thread-owned sidebar
  // hosts the automations list.
  onClose?: () => void;
}) {
  const workflowAutomations$ = thread.headerAutomations.automations$;
  const workflowAutomationsLoadable = useLastLoadable(workflowAutomations$);
  const lastResolvedAutomations = useLastResolved(workflowAutomations$);
  const legacyClose = useSet(closeHeaderAutomationSidebar$);
  const close = onClose ?? legacyClose;
  const workflowAutomations =
    workflowAutomationsLoadable.state === "hasData"
      ? workflowAutomationsLoadable.data
      : (lastResolvedAutomations ?? []);
  const isEmpty = workflowAutomations.length === 0;
  const loading = isEmpty && workflowAutomationsLoadable.state === "loading";

  return (
    <aside
      aria-label="Automations"
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0 animate-in fade-in slide-in-from-right-2 duration-[180ms] ease"
      data-testid="automation-sidebar"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            Automations
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close automations"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <IconX size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="grid gap-3">
            <Skeleton className="h-36 rounded-lg" />
            <Skeleton className="h-36 rounded-lg" />
          </div>
        ) : isEmpty ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No automations yet.
          </div>
        ) : (
          <div className="grid gap-3">
            {workflowAutomations.map((automation) => {
              return (
                <HeaderWorkflowAutomationCard
                  key={automation.id}
                  automation={automation}
                  headerAutomations={thread.headerAutomations}
                />
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

function ChatThread({
  isMain,
  thread,
}: {
  isMain?: boolean;
  thread: ChatThreadSignals;
}) {
  const setContainerRef = useSet(
    isMain ? thread.setMainContainerRef$ : thread.setContainerRef$,
  );

  return (
    <section
      aria-label="Chat thread"
      className="flex min-w-0 basis-0 flex-1 flex-col min-h-0 bg-transparent focus:outline-none"
      data-chat-thread-container-id={thread.threadId}
      ref={setContainerRef}
      tabIndex={-1}
    >
      <ChatThreadContent thread={thread} />
    </section>
  );
}

// Drag the divider to resize the artifact preview against the chat thread.
// The preview panel is the right-most child, so its right edge coincides with
// the container's right edge; the width is the gap from the pointer to it.
function startArtifactPanelResize(
  event: ReactPointerEvent<HTMLDivElement>,
  setWidth: (width: number) => void,
  setResizing: (resizing: boolean) => void,
): void {
  const container = event.currentTarget.parentElement;
  if (!container) {
    return;
  }
  event.preventDefault();
  const rect = container.getBoundingClientRect();
  const maxWidth = Math.max(
    ARTIFACT_PANEL_MIN_WIDTH,
    rect.width - ARTIFACT_PANEL_MIN_THREAD_WIDTH,
  );
  setResizing(true);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";

  function onMove(moveEvent: PointerEvent): void {
    const next = Math.min(
      Math.max(rect.right - moveEvent.clientX, ARTIFACT_PANEL_MIN_WIDTH),
      maxWidth,
    );
    setWidth(next);
  }
  function onUp(): void {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    setResizing(false);
  }
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// Resolve the artifact panel's CSS width and transition from the persisted
// width and the live drag state. A null width means "never resized" -> keep
// the responsive default; once resized, the stored px is clamped against the
// live container so the chat thread always keeps ARTIFACT_PANEL_MIN_THREAD_WIDTH.
// The transition is dropped mid-drag so the panel tracks the pointer 1:1.
function artifactPanelLayout(
  width: number | null,
  resizing: boolean,
): { style: CSSProperties; transition: string } {
  const widthValue =
    width === null
      ? "min(760px, 48vw)"
      : `clamp(${ARTIFACT_PANEL_MIN_WIDTH}px, ${width}px, calc(100% - ${ARTIFACT_PANEL_MIN_THREAD_WIDTH}px))`;
  return {
    style: { "--artifact-panel-width": widthValue } as CSSProperties,
    transition: resizing
      ? ""
      : "transition-[flex-basis,width] duration-[240ms] ease",
  };
}

function ArtifactResizeHandle() {
  const setWidth = useSet(setArtifactPanelWidth$);
  const setResizing = useSet(setArtifactPanelResizing$);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview panel"
      className="group relative hidden xl:flex w-1 shrink-0 cursor-col-resize items-stretch justify-center"
      onPointerDown={(event) => {
        startArtifactPanelResize(event, setWidth, setResizing);
      }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/60 transition-colors group-hover:bg-border"
      />
    </div>
  );
}

function ChatThreadArea({
  leftThread,
  rightThread,
}: {
  leftThread: ChatThreadSignals | null;
  rightThread: ChatThreadSignals | null;
}) {
  const setKeyboardScrollRoot = useSet(setChatKeyboardScrollRoot$);

  return (
    <div
      ref={setKeyboardScrollRoot}
      className="flex w-full flex-1 min-w-0 min-h-0 bg-transparent"
    >
      {leftThread && <ChatThread isMain thread={leftThread} />}
      {rightThread && (
        <>
          <div className="w-px shrink-0 bg-border/60" aria-hidden="true" />
          <ChatThread thread={rightThread} />
        </>
      )}
    </div>
  );
}

function useSelectedBrowserSessionSignals(
  leftThread: ChatThreadSignals | null,
  rightThread: ChatThreadSignals | null,
): BrowserSessionSignals | undefined {
  const selectedBrowserId = useGet(currentBrowserSessionId$);
  const leftBrowserSignalsById = useGet(
    leftThread?.browserSessionCardSignalsById$ ??
      emptyBrowserSessionSignalsById$,
  );
  const rightBrowserSignalsById = useGet(
    rightThread?.browserSessionCardSignalsById$ ??
      emptyBrowserSessionSignalsById$,
  );
  if (!selectedBrowserId) {
    return undefined;
  }
  return (
    leftBrowserSignalsById.get(selectedBrowserId) ??
    rightBrowserSignalsById.get(selectedBrowserId)
  );
}

function useSelectedMailDraftSignals(
  leftThread: ChatThreadSignals | null,
  rightThread: ChatThreadSignals | null,
): MailDraftSignals | undefined {
  const selectedMailDraftId = useGet(currentMailDraftId$);
  const leftMailDraftSignalsById = useGet(
    leftThread?.mailDraftCardSignalsById$ ?? emptyMailDraftSignalsById$,
  );
  const rightMailDraftSignalsById = useGet(
    rightThread?.mailDraftCardSignalsById$ ?? emptyMailDraftSignalsById$,
  );
  if (!selectedMailDraftId) {
    return undefined;
  }
  return (
    leftMailDraftSignalsById.get(selectedMailDraftId) ??
    rightMailDraftSignalsById.get(selectedMailDraftId)
  );
}

function ThreadAutomationsSidebarSlot({
  thread,
}: {
  thread: ChatThreadSignals;
}) {
  const close = useSet(thread.sidebar.close$);
  return <HeaderAutomationSidebar thread={thread} onClose={close} />;
}

export function ZeroChatThreadPage() {
  const newSidebarEnabled = useGet(newChatThreadSidebarEnabled$);
  const activeThreadSidebar = useGet(activeThreadSidebar$);
  const leftThread = useGet(currentLeftThread$);
  const rightThread = useGet(currentRightThread$);
  const lightboxUrl = useGet(attachmentLightboxUrl$);
  const artifactRef = useGet(currentArtifactRef$);
  const artifactInboxThreadId = useGet(currentArtifactInboxThreadId$);
  const automationPanelThreadId = useGet(currentHeaderAutomationThreadId$);
  const automationPanelThread = [leftThread, rightThread].find((thread) => {
    return thread?.threadId === automationPanelThreadId;
  });
  const selectedMailDraftSignals = useSelectedMailDraftSignals(
    leftThread,
    rightThread,
  );
  const selectedBrowserSessionSignals = useSelectedBrowserSessionSignals(
    leftThread,
    rightThread,
  );
  const artifactPanelOpen =
    artifactRef !== null || artifactInboxThreadId !== null;
  const automationPanelOpen = automationPanelThread !== undefined;
  const mailDraftPanelOpen = selectedMailDraftSignals !== undefined;
  const browserPanelOpen = selectedBrowserSessionSignals !== undefined;
  const rightPanelOpen = newSidebarEnabled
    ? activeThreadSidebar !== null
    : artifactPanelOpen ||
      automationPanelOpen ||
      mailDraftPanelOpen ||
      browserPanelOpen;
  const { style: artifactPanelStyle, transition: artifactTransition } =
    artifactPanelLayout(
      useGet(artifactPanelWidth$),
      useGet(artifactPanelResizing$),
    );
  return (
    <>
      {/* Keep the wrapper structure stable across right panel open/close so the
          thread area's React subtree (and its scroll/keyboard state) never
          unmounts when the sidebar appears. Only the wrapper className and
          the optional sidebar sibling change with state. Below xl: the
          thread half hides so the sidebar fills the pane (no toggle, the
          50/50 split needs each half ~640px to clear the composer's sm:
          breakpoint, below which the model picker collapses to icons). */}
      <div
        className="flex flex-1 min-h-0 bg-transparent"
        style={artifactPanelStyle}
      >
        <div
          className={cn(
            "min-w-0 min-h-0",
            artifactTransition,
            rightPanelOpen ? "hidden xl:flex flex-1 basis-0" : "flex flex-1",
          )}
        >
          <ChatThreadArea leftThread={leftThread} rightThread={rightThread} />
        </div>
        {rightPanelOpen && <ArtifactResizeHandle />}
        <div
          className={cn(
            "flex min-h-0 min-w-0 overflow-hidden",
            artifactTransition,
            rightPanelOpen
              ? "flex-1 basis-0 xl:w-[var(--artifact-panel-width)] xl:flex-none xl:basis-[var(--artifact-panel-width)]"
              : "pointer-events-none w-0 flex-none basis-0",
          )}
          aria-hidden={!rightPanelOpen}
        >
          {newSidebarEnabled ? (
            activeThreadSidebar ? (
              activeThreadSidebar.target.type === "automations" ? (
                <ThreadAutomationsSidebarSlot
                  key={activeThreadSidebar.thread.threadId}
                  thread={activeThreadSidebar.thread}
                />
              ) : (
                <ThreadSidebarSlot
                  thread={activeThreadSidebar.thread}
                  target={activeThreadSidebar.target}
                />
              )
            ) : null
          ) : selectedBrowserSessionSignals ? (
            <BrowserSessionSidebar signals={selectedBrowserSessionSignals} />
          ) : selectedMailDraftSignals ? (
            <MailDraftSidebar signals={selectedMailDraftSignals} />
          ) : automationPanelThread ? (
            <HeaderAutomationSidebar
              key={automationPanelThread.threadId}
              thread={automationPanelThread}
            />
          ) : artifactPanelOpen ? (
            <ChatArtifactInboxSlot
              artifactRef={artifactRef}
              leftThread={leftThread}
              rightThread={rightThread}
            />
          ) : null}
        </div>
      </div>
      {lightboxUrl && <AttachmentLightbox />}
      <ChatConnectorActionConnectModal />
    </>
  );
}

type LoadableValue<T> =
  | { state: "loading" }
  | { state: "hasData"; data: T }
  | { state: "hasError"; error: unknown };

function resolveSessionError(
  renderedGroupsReadyLoadable: LoadableValue<boolean>,
): string | null {
  if (renderedGroupsReadyLoadable.state === "hasError") {
    return renderedGroupsReadyLoadable.error instanceof Error
      ? renderedGroupsReadyLoadable.error.message
      : "Failed to load messages";
  }
  return null;
}

const CHAT_THREAD_CONTENT_MAIN_CLASS =
  "items-center py-4 pl-4 pr-4 sm:pl-6 sm:pr-6 @container";
const CHAT_RENDER_LOAD_MORE_TOP_THRESHOLD_PX = 100;

function ChatThreadRenderedMessageGroups({
  thread,
}: {
  thread: ChatThreadSignals;
}) {
  const renderedGroups =
    useLastResolved(thread.visibleRenderedChatGroups$, {
      equalityFn: equalArrays,
    }) ?? [];
  const { activeGroups: renderedActiveGroups } =
    splitQueuedMessagesForThinkingIndicator(renderedGroups);
  const runGroupExpansionOverrides = useGet(runGroupExpansionOverrides$);
  const toggleRunGroupExpanded = useSet(toggleRunGroupExpanded$);
  const runGroupFolding = buildRunGroupFolding(
    renderedActiveGroups,
    runGroupExpansionOverrides,
  );
  const runGroupVisibleGroups =
    runGroupFolding?.visibleGroups ?? renderedActiveGroups;
  const completedWorkFolding = buildCompletedWorkFolding(runGroupVisibleGroups);
  const completedWorkExpandedKeys = useGet(completedWorkExpandedKeys$);
  const toggleCompletedWorkExpanded = useSet(toggleCompletedWorkExpanded$);
  const visibleGroups =
    completedWorkFolding?.visibleGroups ?? runGroupVisibleGroups;

  return (
    <ChatThreadMessageGroups
      thread={thread}
      groups={visibleGroups}
      runGroupFolding={runGroupFolding}
      onToggleRunGroup={toggleRunGroupExpanded}
      completedWorkFolding={completedWorkFolding}
      completedWorkExpandedKeys={completedWorkExpandedKeys}
      onToggleCompletedWork={toggleCompletedWorkExpanded}
    />
  );
}

function ChatThreadSessionError({ thread }: { thread: ChatThreadSignals }) {
  const renderedGroupsReadyLoadable = useLastLoadable(
    thread.visibleRenderedChatGroupsReady$,
  );
  const sessionError = resolveSessionError(renderedGroupsReadyLoadable);
  if (!sessionError) {
    return null;
  }
  return (
    <div className="flex-1 flex items-center justify-center py-16">
      <div className="flex items-center gap-2 text-destructive">
        <IconAlertCircle size={16} />
        <p className="text-sm">{sessionError}</p>
      </div>
    </div>
  );
}

function ChatThreadEmptyState({ thread }: { thread: ChatThreadSignals }) {
  const renderedGroupsReady =
    useLastResolved(thread.visibleRenderedChatGroupsReady$) ?? false;
  const threadSettledInServer = useGet(thread.threadSettledInServer$);
  const hasMessages = useLastResolved(thread.hasMessages$);
  const hasNewMessagesState = useLoadableState(thread.hasNewMessages$);
  if (
    !renderedGroupsReady ||
    !threadSettledInServer ||
    hasMessages !== false ||
    hasNewMessagesState === "loading"
  ) {
    return null;
  }
  return (
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
  );
}

function ChatThreadMessagesMain({ thread }: { thread: ChatThreadSignals }) {
  const renderedGroupsReady =
    useLastResolved(thread.visibleRenderedChatGroupsReady$) ?? false;

  return (
    <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
      <div
        data-message-container
        className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4 overflow-visible"
        style={{ visibility: renderedGroupsReady ? "visible" : "hidden" }}
      >
        <ChatThreadSessionError thread={thread} />
        <ChatThreadEmptyState thread={thread} />
        <ChatThreadRenderedMessageGroups thread={thread} />
        <ChatThreadThinkingIndicator thread={thread} />
      </div>
    </main>
  );
}

function ChatThreadThinkingIndicator({
  thread,
}: {
  thread: ChatThreadSignals;
}) {
  return <ThinkingIndicator thread={thread} />;
}

function ChatThreadMessageGroups({
  thread,
  groups,
  runGroupFolding,
  onToggleRunGroup,
  completedWorkFolding,
  completedWorkExpandedKeys,
  onToggleCompletedWork,
}: {
  thread: ChatThreadSignals;
  groups: readonly GroupedChatMessageGroup[];
  runGroupFolding: RunGroupFolding | null;
  onToggleRunGroup: (key: string, expanded: boolean) => void;
  completedWorkFolding: CompletedWorkFolding | null;
  completedWorkExpandedKeys: ReadonlySet<string>;
  onToggleCompletedWork: (key: string) => void;
}) {
  const { embeddedRunGroupFolds, externalRunGroupFolds } =
    resolveRunGroupFoldPlacements({
      groups,
      runGroupFolding,
      onToggleRunGroup,
    });

  return (
    <>
      {groups.map((group) => {
        const runGroupFolds =
          externalRunGroupFolds.get(group.beginMessageId) ?? [];
        const embeddedFolds =
          embeddedRunGroupFolds.get(group.beginMessageId) ?? [];
        const completedWorkFold = completedWorkFoldForGroup(
          completedWorkFolding,
          group,
        );
        const completedWorkExpanded =
          completedWorkFold !== null &&
          completedWorkExpandedKeys.has(completedWorkFold.key);
        return (
          <div key={group.beginMessageId} className="contents">
            {runGroupFolds.map((runGroupFold) => {
              return (
                <RunGroupFoldRow
                  key={runGroupFold.fold.key}
                  control={runGroupFold}
                />
              );
            })}
            <PagedGroupRow
              group={group}
              thread={thread}
              runGroupFolds={embeddedFolds}
              completedWorkFold={
                completedWorkFold !== null
                  ? {
                      groups: completedWorkFold.labelGroups,
                      hiddenGroups: completedWorkFold.hiddenGroups,
                      expanded: completedWorkExpanded,
                      onToggle: () => {
                        onToggleCompletedWork(completedWorkFold.key);
                      },
                    }
                  : undefined
              }
            />
          </div>
        );
      })}
    </>
  );
}

interface RunGroupFoldControl {
  fold: RunGroupFold;
  expanded: boolean;
  onToggle: () => void;
}

function resolveRunGroupFoldPlacements({
  groups,
  runGroupFolding,
  onToggleRunGroup,
}: {
  groups: readonly GroupedChatMessageGroup[];
  runGroupFolding: RunGroupFolding | null;
  onToggleRunGroup: (key: string, expanded: boolean) => void;
}): {
  embeddedRunGroupFolds: Map<string, RunGroupFoldControl[]>;
  externalRunGroupFolds: Map<string, RunGroupFoldControl[]>;
} {
  const embeddedRunGroupFolds = new Map<string, RunGroupFoldControl[]>();
  const externalRunGroupFolds = new Map<string, RunGroupFoldControl[]>();

  if (runGroupFolding === null) {
    return { embeddedRunGroupFolds, externalRunGroupFolds };
  }

  for (const [index, group] of groups.entries()) {
    const folds = runGroupFolding.foldsByNextGroupId.get(group.beginMessageId);
    if (!folds || folds.length === 0) {
      continue;
    }

    for (const fold of folds) {
      const control: RunGroupFoldControl = {
        fold,
        expanded: fold.expanded,
        onToggle: () => {
          onToggleRunGroup(fold.key, fold.expanded);
        },
      };
      const embeddedGroupId = control.expanded
        ? undefined
        : inlineGroupIdForCollapsedRunGroupFold(groups, index);
      const target = embeddedGroupId
        ? embeddedRunGroupFolds
        : externalRunGroupFolds;
      const targetGroupId = embeddedGroupId ?? group.beginMessageId;
      const existing = target.get(targetGroupId);
      if (existing) {
        existing.push(control);
      } else {
        target.set(targetGroupId, [control]);
      }
    }
  }

  return { embeddedRunGroupFolds, externalRunGroupFolds };
}

function inlineGroupIdForCollapsedRunGroupFold(
  groups: readonly GroupedChatMessageGroup[],
  index: number,
): string | undefined {
  const group = groups[index];
  if (!group || group.role !== "user") {
    return undefined;
  }
  if (firstRunIdForMessages(group.messages) === undefined) {
    return undefined;
  }
  return (
    assistantGroupIdForCollapsedRunGroupFold(groups, index) ??
    group.beginMessageId
  );
}

function assistantGroupIdForCollapsedRunGroupFold(
  groups: readonly GroupedChatMessageGroup[],
  index: number,
): string | undefined {
  const group = groups[index];
  if (!group || group.role !== "user") {
    return undefined;
  }
  const runId = firstRunIdForMessages(group.messages);
  if (runId === undefined) {
    return undefined;
  }

  for (let nextIndex = index + 1; nextIndex < groups.length; nextIndex++) {
    const candidate = groups[nextIndex]!;
    const candidateRunId = firstRunIdForMessages(candidate.messages);
    if (candidateRunId !== runId) {
      return undefined;
    }
    if (candidate.role === "assistant") {
      return candidate.beginMessageId;
    }
  }

  return undefined;
}

function completedWorkFoldForGroup(
  completedWorkFolding: CompletedWorkFolding | null,
  group: GroupedChatMessageGroup,
): CompletedWorkFold | null {
  if (completedWorkFolding === null) {
    return null;
  }
  return (
    group.messages
      .map((message) => {
        return completedWorkFolding.foldsByFinalMessageId.get(message.id);
      })
      .find((fold) => {
        return fold !== undefined;
      }) ?? null
  );
}

function groupMessagesByRole(
  messages: readonly EnrichedChatMessage[],
): GroupedChatMessageGroup[] {
  const groups: GroupedChatMessageGroup[] = [];
  for (const message of messages) {
    const role = chatEventCompatibilityRole(message.eventType);
    const last = groups[groups.length - 1];
    if (last && last.role === role) {
      last.messages.push(message);
      continue;
    }
    groups.push({
      beginMessageId: message.id,
      role,
      messages: [message],
    });
  }
  return groups;
}

interface CompletedWorkFold {
  key: string;
  finalMessageId: string;
  hiddenGroups: GroupedChatMessageGroup[];
  labelGroups: GroupedChatMessageGroup[];
}

interface CompletedWorkFolding {
  visibleGroups: GroupedChatMessageGroup[];
  foldsByFinalMessageId: Map<string, CompletedWorkFold>;
}

function groupMessagesForCompletedWorkDisplay(
  messages: readonly EnrichedChatMessage[],
  foldFinalMessageIds: ReadonlySet<string>,
): GroupedChatMessageGroup[] {
  const groups: GroupedChatMessageGroup[] = [];
  for (const message of messages) {
    const role = chatEventCompatibilityRole(message.eventType);
    const forceStandalone = foldFinalMessageIds.has(message.id);
    const last = groups[groups.length - 1];
    const lastHasFoldFinal =
      last?.messages.some((candidate) => {
        return foldFinalMessageIds.has(candidate.id);
      }) ?? false;
    const lastFoldFinal = last?.messages.find((candidate) => {
      return foldFinalMessageIds.has(candidate.id);
    });
    const continuesFoldFinalRun =
      lastFoldFinal?.runId !== undefined &&
      lastFoldFinal.runId === message.runId;

    if (
      !forceStandalone &&
      last &&
      last.role === role &&
      (!lastHasFoldFinal || continuesFoldFinalRun)
    ) {
      last.messages.push(message);
      continue;
    }

    groups.push({
      beginMessageId: message.id,
      role,
      messages: [message],
    });
  }
  return groups;
}

function firstRunIdForMessages(
  messages: readonly EnrichedChatMessage[],
): string | undefined {
  return messages.find((message) => {
    return message.runId !== undefined;
  })?.runId;
}

function usageByRunIdFromGroups(
  groups: readonly GroupedChatMessageGroup[],
): Map<string, ChatMessageUsagePayload> {
  return foldLatestChatUsageByRunId(
    groups.flatMap((group) => {
      const runId = firstRunIdForMessages(group.messages);
      return group.role === "assistant" &&
        group.usage !== undefined &&
        runId !== undefined
        ? [
            {
              eventType: "usage.recorded" as const,
              runId,
              usage: group.usage,
            },
          ]
        : [];
    }),
  );
}

function attachUsageToCompletedWorkGroups(
  groups: readonly GroupedChatMessageGroup[],
  usageByRunId: ReadonlyMap<string, ChatMessageUsagePayload>,
): GroupedChatMessageGroup[] {
  return groups.map((group) => {
    if (group.role !== "assistant") {
      return group;
    }
    const runId = firstRunIdForMessages(group.messages);
    const usage = runId === undefined ? undefined : usageByRunId.get(runId);
    return usage === undefined ? group : { ...group, usage };
  });
}

function isRenderableAssistantMessage(message: EnrichedChatMessage): boolean {
  return (
    chatEventCompatibilityRole(message.eventType) === "assistant" &&
    (Boolean(message.content) ||
      Boolean(chatEventError(message)) ||
      message.blocks.length > 0 ||
      Boolean(chatEventAttachments(message)?.length))
  );
}

function isPrimaryAssistantResult(message: EnrichedChatMessage): boolean {
  return (
    (message.eventType !== "run.completed" || Boolean(message.content)) &&
    isRenderableAssistantMessage(message)
  );
}

function isThinkingOnlyAssistantMessage(message: EnrichedChatMessage): boolean {
  return (
    message.eventType === "output.thinking" &&
    message.thinking.trim().length > 0
  );
}

function terminatedRunIdsForCompletedWork(
  messages: readonly EnrichedChatMessage[],
): Set<string> {
  return terminatedChatRunIds(messages);
}

function buildCompletedWorkFolding(
  groups: readonly GroupedChatMessageGroup[],
): CompletedWorkFolding | null {
  const usageByRunId = usageByRunIdFromGroups(groups);
  const messages = groups.flatMap((group) => {
    return group.messages;
  });
  const terminatedRunIds = terminatedRunIdsForCompletedWork(messages);
  const visibleMessages: EnrichedChatMessage[] = [];
  const folds: CompletedWorkFold[] = [];

  for (let index = 0; index < messages.length; ) {
    const runId = messages[index]!.runId;
    if (runId === undefined) {
      visibleMessages.push(messages[index]!);
      index++;
      continue;
    }

    let endIndex = index + 1;
    while (endIndex < messages.length && messages[endIndex]!.runId === runId) {
      endIndex++;
    }

    const runMessages = messages.slice(index, endIndex);
    if (!terminatedRunIds.has(runId) || runMessages.some(isCancelledRunEvent)) {
      visibleMessages.push(...runMessages);
      index = endIndex;
      continue;
    }

    let finalMessageIndex = -1;
    for (let offset = runMessages.length - 1; offset >= 0; offset--) {
      if (isPrimaryAssistantResult(runMessages[offset]!)) {
        finalMessageIndex = offset;
        break;
      }
    }
    if (finalMessageIndex < 0) {
      for (let offset = runMessages.length - 1; offset >= 0; offset--) {
        if (isRenderableAssistantMessage(runMessages[offset]!)) {
          finalMessageIndex = offset;
          break;
        }
      }
    }
    const finalMessage =
      finalMessageIndex >= 0 ? runMessages[finalMessageIndex]! : undefined;
    const precedingMessages =
      finalMessageIndex > 0 ? runMessages.slice(0, finalMessageIndex) : [];
    const hiddenMessages = precedingMessages.filter((message) => {
      return (
        chatEventCompatibilityRole(message.eventType) !== "user" &&
        !isThinkingOnlyAssistantMessage(message)
      );
    });
    const trailingMessages =
      finalMessageIndex >= 0 ? runMessages.slice(finalMessageIndex + 1) : [];
    const trailingMessagesAreMarkers = trailingMessages.every((message) => {
      return (
        chatEventCompatibilityRole(message.eventType) === "assistant" &&
        (!isRenderableAssistantMessage(message) ||
          message.eventType === "run.completed")
      );
    });
    const visibleTrailingMessages = trailingMessages.filter((message) => {
      return isRenderableAssistantMessage(message);
    });
    if (
      finalMessage !== undefined &&
      hiddenMessages.length > 0 &&
      trailingMessagesAreMarkers
    ) {
      visibleMessages.push(
        ...precedingMessages.filter((message) => {
          return chatEventCompatibilityRole(message.eventType) === "user";
        }),
        finalMessage,
        ...visibleTrailingMessages,
      );
      folds.push({
        key: `${runId}:${finalMessage.id}`,
        finalMessageId: finalMessage.id,
        hiddenGroups: groupMessagesByRole(hiddenMessages),
        labelGroups: groupMessagesByRole(runMessages),
      });
    } else {
      visibleMessages.push(...runMessages);
    }

    index = endIndex;
  }

  if (folds.length === 0) {
    return null;
  }

  const foldFinalMessageIds = new Set(
    folds.map((fold) => {
      return fold.finalMessageId;
    }),
  );
  return {
    visibleGroups: attachUsageToCompletedWorkGroups(
      groupMessagesForCompletedWorkDisplay(
        visibleMessages,
        foldFinalMessageIds,
      ),
      usageByRunId,
    ),
    foldsByFinalMessageId: new Map(
      folds.map((fold) => {
        return [fold.finalMessageId, fold];
      }),
    ),
  };
}

function parseMessageTime(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatCompactDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.round(totalMinutes / 60);
  return `${totalHours}h`;
}

function durationLabelForGroups(
  groups: readonly GroupedChatMessageGroup[],
): string | null {
  const timestamps = groups.flatMap((group) => {
    return group.messages.flatMap((message) => {
      const timestamp = parseMessageTime(message.createdAt);
      return timestamp === null ? [] : [timestamp];
    });
  });
  if (timestamps.length < 2) {
    return null;
  }
  const elapsedSeconds = Math.max(
    1,
    Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1000),
  );
  return formatCompactDuration(elapsedSeconds);
}

function completedWorkLabel(
  groups: readonly GroupedChatMessageGroup[],
): string {
  const duration = durationLabelForGroups(groups);
  return duration ? `Worked for ${duration}` : "Worked";
}

const RUN_SECTION_LABEL_CLASS =
  "shrink-0 font-serif text-[13px] italic text-muted-foreground/50";

function CompletedWorkFoldRow({
  groups,
  expanded,
  onToggle,
}: {
  groups: readonly GroupedChatMessageGroup[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const label = completedWorkLabel(groups);
  return (
    <div data-chat-completed-work-fold className="-mx-2 @[900px]:-mb-[15px]">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse work history" : "Expand work history"}
        onClick={onToggle}
        className="mt-1.5 inline-flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <IconHourglass
          aria-hidden
          size={14}
          className="shrink-0 text-muted-foreground/70"
        />
        <span className="text-[13px]">{label}</span>
        <IconChevronRight
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground/70 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
    </div>
  );
}

function normalizedInlineLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function runGroupFoldMessages(fold: RunGroupFold): EnrichedChatMessage[] {
  return fold.labelGroups.flatMap((group) => {
    return group.messages;
  });
}

function runGroupFoldSourceLabel(
  fold: RunGroupFold,
  structuredPromptEnabled: boolean,
): string {
  const messages = runGroupFoldMessages(fold);
  const workflowLabel = runGroupFoldWorkflowLabel(fold);
  if (workflowLabel) {
    return workflowLabel;
  }
  for (const message of messages) {
    if (!isInputChatEvent(message)) {
      continue;
    }
    const content = shouldUseStructuredPrompt(
      structuredPromptEnabled,
      message.structuredPrompt,
    )
      ? messageDocumentToDisplayText(message.structuredPrompt)
      : message.content;
    if (content?.trim()) {
      return normalizedInlineLabel(content);
    }
  }
  return "Automated run";
}

function runGroupFoldWorkflowLabel(fold: RunGroupFold): string | null {
  for (const message of runGroupFoldMessages(fold)) {
    if (isWorkflowUserMessage(message)) {
      return normalizedInlineLabel(workflowMessageBody(message));
    }
    const workflowSnapshot = message.workflowSnapshot;
    const label =
      workflowSnapshot?.triggerBrief?.trim() ||
      workflowSnapshot?.description?.trim() ||
      workflowSnapshot?.displayName?.trim() ||
      workflowSnapshot?.name?.trim();
    if (label) {
      return normalizedInlineLabel(label);
    }
  }
  return null;
}

function runGroupFoldGoalLabel(fold: RunGroupFold): string {
  const goalMessage = runGroupFoldMessages(fold).find(isGoalUserMessage);
  const content = goalMessage ? goalUserMessageBrief(goalMessage) : null;
  return content ? normalizedInlineLabel(content) : "goal";
}

function goalUserMessageBrief(message: EnrichedChatMessage): string | null {
  return (
    message.goalSnapshot?.objectiveBrief?.trim() ||
    message.content?.trim() ||
    null
  );
}

function isGoalUserMessage(
  message: EnrichedChatMessage,
): message is EnrichedChatMessage & ChatInputMessage {
  return (
    isInputChatEvent(message) &&
    message.isGoalRun === true &&
    !hasWorkflowMessageMetadata(message) &&
    goalUserMessageBrief(message) !== null
  );
}

function isGoalRunGroupFold(fold: RunGroupFold): boolean {
  return fold.labelGroups.some((group) => {
    return group.messages.some(isGoalUserMessage);
  });
}

function verboseDurationLabelForRunGroupFold(
  fold: RunGroupFold,
): string | null {
  const timestamps = fold.labelGroups.flatMap((group) => {
    return group.messages.flatMap((message) => {
      if (message.runGroupId !== fold.runGroupId) {
        return [];
      }
      const timestamp = parseMessageTime(message.createdAt);
      return timestamp === null ? [] : [timestamp];
    });
  });
  if (timestamps.length < 2) {
    return null;
  }
  const elapsedMinutes = Math.max(
    1,
    Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 60_000),
  );
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes} ${minutes === 1 ? "min" : "mins"}`);
  }
  return parts.join(" ");
}

function runGroupFoldLabel(
  fold: RunGroupFold,
  structuredPromptEnabled: boolean,
): string {
  if (isGoalRunGroupFold(fold)) {
    const duration = verboseDurationLabelForRunGroupFold(fold);
    const label = runGroupFoldGoalLabel(fold);
    return duration ? `${duration} for ${label}` : `Goal for ${label}`;
  }
  const runLabel = fold.hiddenRunCount === 1 ? "run" : "runs";
  const sourceLabel = runGroupFoldSourceLabel(fold, structuredPromptEnabled);
  return `${fold.hiddenRunCount} ${runLabel} for ${sourceLabel}`;
}

function RunGroupFoldRow({
  control,
  embedded = false,
}: {
  control: RunGroupFoldControl;
  embedded?: boolean;
}) {
  const { fold, expanded, onToggle } = control;
  const featureSwitches = useGet(featureSwitch$);
  const label = runGroupFoldLabel(
    fold,
    featureSwitches[FeatureSwitchKey.StructuredPrompt] ?? false,
  );
  const isGoal = isGoalRunGroupFold(fold);
  const Icon = isGoal ? IconTarget : IconPackage;
  return (
    <div
      data-chat-run-group-fold
      className={cn("-mx-2", embedded && "@[900px]:-mb-[15px]")}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={
          expanded
            ? "Collapse grouped run history"
            : "Expand grouped run history"
        }
        onClick={onToggle}
        className={cn(
          "inline-flex min-h-9 max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted/50",
          embedded && "mt-1.5",
        )}
      >
        <Icon
          aria-hidden
          size={14}
          className="shrink-0 text-muted-foreground/70"
        />
        <span className="min-w-0 truncate whitespace-nowrap text-[13px]">
          {label}
        </span>
        <IconChevronRight
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground/70 transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
    </div>
  );
}

function ChatThreadSkeletonOverlay({ thread }: { thread: ChatThreadSignals }) {
  const renderedGroupsReadyLoadable = useLastLoadable(
    thread.visibleRenderedChatGroupsReady$,
  );
  const sessionError = resolveSessionError(renderedGroupsReadyLoadable);
  const hasMessages = useLastResolved(thread.hasMessages$);
  const hasNewMessagesState = useLoadableState(thread.hasNewMessages$);
  const skeletonVisible =
    hasMessages === false && hasNewMessagesState === "loading";
  if (!skeletonVisible || sessionError) {
    return null;
  }

  return (
    <div
      data-chat-skeleton
      className="absolute inset-0 z-10 overflow-hidden pointer-events-none bg-background"
    >
      <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
        <div className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4">
          <ChatSkeleton />
        </div>
      </main>
    </div>
  );
}

function ChatThreadMessagesPane({ thread }: { thread: ChatThreadSignals }) {
  const setScrollContainer = useSet(thread.setScrollContainer$);
  const loadMoreRenderedChatGroups = useSet(thread.loadMoreRenderedChatGroups$);
  const pageSignal = useGet(pageSignal$);

  const handleScroll = (event: ReactUIEvent<HTMLDivElement>) => {
    if (
      event.currentTarget.scrollTop > CHAT_RENDER_LOAD_MORE_TOP_THRESHOLD_PX
    ) {
      return;
    }
    detach(loadMoreRenderedChatGroups(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex-1 min-h-0 relative isolate">
      <div
        ref={setScrollContainer}
        data-scroll-container
        tabIndex={-1}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto focus:outline-none [overflow-anchor:none] [scrollbar-gutter:stable]"
      >
        <ChatThreadMessagesMain
          key={`messages:${thread.threadId}`}
          thread={thread}
        />
      </div>
      <ChatThreadSkeletonOverlay
        key={`skeleton:${thread.threadId}`}
        thread={thread}
      />
      <ScrollToBottomButton
        key={`scroll-button:${thread.threadId}`}
        thread={thread}
      />
    </div>
  );
}

function ChatHistoryBackfillProgress({
  thread,
}: {
  thread: ChatThreadSignals;
}) {
  const featureSwitches = useGet(featureSwitch$);
  const enabled =
    featureSwitches[FeatureSwitchKey.ChatHistoryBackfillProgress] ?? false;
  const progress = useLastResolved(thread.historyBackfillProgress$);
  if (!enabled || progress === null || progress === undefined) {
    return null;
  }
  const percent = Math.min(100, Math.max(0, progress * 100));
  return (
    <div
      data-history-backfill-progress
      role="progressbar"
      aria-label="Loading message history"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="h-0.5 w-full shrink-0 overflow-hidden"
    >
      <div
        className="h-full bg-primary/60 transition-[width] duration-500 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function ChatThreadContent({ thread }: { thread: ChatThreadSignals }) {
  return (
    <>
      <ChatThreadHeader thread={thread} />
      <ChatHistoryBackfillProgress key={thread.threadId} thread={thread} />

      <div className="relative min-h-0 flex-1">
        <div className="flex h-full min-w-0 flex-col">
          <ChatThreadMessagesPane thread={thread} />
          {/* Command loadables are hook-owned, so keep their identity boundary
              narrower than the persistent thread and message owners. */}
          <ChatThreadComposer key={thread.threadId} thread={thread} />
        </div>
      </div>

      <ChatFeedbackSelection feedback={thread.workflowComposer.feedback} />
    </>
  );
}

function ScrollToBottomButton({ thread }: { thread: ChatThreadSignals }) {
  const awayFromBottom = useGet(thread.awayFromBottom$);
  const scrollToBottom = useSet(thread.scrollToBottom$);
  const renderedGroupsReadyLoadable = useLastLoadable(
    thread.visibleRenderedChatGroupsReady$,
  );
  const sessionError = resolveSessionError(renderedGroupsReadyLoadable);
  const skeletonVisible = renderedGroupsReadyLoadable.state === "loading";

  if (!awayFromBottom || skeletonVisible || sessionError) {
    return null;
  }

  return (
    <button
      type="button"
      data-scroll-to-bottom
      aria-label="Scroll to bottom"
      onClick={() => {
        scrollToBottom();
      }}
      className="absolute bottom-4 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground"
    >
      <IconArrowDown size={18} />
    </button>
  );
}

function RecommendedFollowupIcon({
  followup,
}: {
  followup: RecommendedFollowup;
}) {
  if (followup.kind !== "generate") {
    return <IconMessageCircle size={14} stroke={1.8} />;
  }

  if (followup.generationType === "image") {
    return <IconPhoto size={14} stroke={1.8} />;
  }
  if (followup.generationType === "video") {
    return <IconVideo size={14} stroke={1.8} />;
  }
  if (followup.generationType === "presentation") {
    return <IconChartLine size={14} stroke={1.8} />;
  }
  if (followup.generationType === "website") {
    return <IconLink size={14} stroke={1.8} />;
  }
  return <IconPackage size={14} stroke={1.8} />;
}

function recommendedFollowupShownKey(
  source: RecommendedFollowupSource,
): string {
  return [
    source.messageId,
    source.followups.length,
    ...source.followups.map((followup) => {
      return `${followup.kind}:${followup.generationType ?? ""}`;
    }),
  ].join("|");
}

function reportRecommendedFollowupsShown(
  element: HTMLDivElement | null,
  source: RecommendedFollowupSource,
): void {
  if (!element) {
    return;
  }

  const shownKey = recommendedFollowupShownKey(source);
  if (element.dataset.recommendedFollowupsShownKey === shownKey) {
    return;
  }
  element.dataset.recommendedFollowupsShownKey = shownKey;

  captureRecommendedFollowupsShown({
    messageId: source.messageId,
    followups: source.followups,
  });
}

function RecommendedFollowupList({
  thread,
  source,
}: {
  thread: ChatThreadSignals;
  source: RecommendedFollowupSource;
}) {
  const selectComposerText = useSet(thread.workflowComposer.selectText$);
  const appendComposerText = useSet(thread.workflowComposer.appendText$);
  const queueDraftSync = useSet(thread.queueDraftSync$);
  const pageSignal = useGet(pageSignal$);
  const handleRecommendedFollowupsRef = (element: HTMLDivElement | null) => {
    reportRecommendedFollowupsShown(element, source);
  };

  const handleSelect = (
    followup: RecommendedFollowup,
    followupIndex: number,
  ) => {
    captureRecommendedFollowupSelected({
      messageId: source.messageId,
      followupIndex,
      followupCount: source.followups.length,
      followup,
    });
    if (!selectComposerText(followup.prompt)) {
      appendComposerText(followup.prompt);
      detach(queueDraftSync(pageSignal), Reason.DomCallback);
    }
  };

  return (
    <div ref={handleRecommendedFollowupsRef} className="-mx-2">
      {source.followups.map((followup, followupIndex) => {
        return (
          <button
            key={followup.prompt}
            type="button"
            title={followup.prompt}
            className="group flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/40"
            onClick={() => {
              handleSelect(followup, followupIndex);
            }}
          >
            <span className="shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground">
              <RecommendedFollowupIcon followup={followup} />
            </span>
            <span className="min-w-0 flex-1 break-words text-[0.9375rem] font-medium leading-6 text-muted-foreground group-hover:text-foreground">
              {followup.prompt}
            </span>
            <IconArrowUpRight
              size={14}
              stroke={1.8}
              className="shrink-0 text-muted-foreground/60 opacity-0 transition-all group-hover:text-foreground group-hover:opacity-100"
            />
          </button>
        );
      })}
    </div>
  );
}

function splitQueuedMessagesForThinkingIndicator(
  groups: GroupedChatMessageGroup[],
): {
  activeGroups: GroupedChatMessageGroup[];
  queuedGroups: GroupedChatMessageGroup[];
} {
  const activeGroups: GroupedChatMessageGroup[] = [];
  const queuedMessages: EnrichedChatMessage[] = [];

  for (const group of groups) {
    if (group.role !== "user") {
      activeGroups.push(group);
      continue;
    }

    const activeMessages: EnrichedChatMessage[] = [];
    for (const message of group.messages) {
      if (message.isQueued) {
        queuedMessages.push(message);
      } else {
        activeMessages.push(message);
      }
    }

    if (activeMessages.length > 0) {
      activeGroups.push({
        ...group,
        beginMessageId: activeMessages[0]!.id,
        messages: activeMessages,
      });
    }
  }

  return {
    activeGroups,
    queuedGroups:
      queuedMessages.length > 0
        ? [
            {
              beginMessageId: queuedMessages[0]!.id,
              role: "user",
              messages: queuedMessages,
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Composer wrapper — reads chat signals from thread prop
// ---------------------------------------------------------------------------

function canQueueMessage({ sending }: { sending: boolean }): boolean {
  return sending;
}

function shouldAutoFocusComposer({
  autoFocus,
  hasMessages,
}: {
  autoFocus: boolean;
  hasMessages: boolean;
}): boolean {
  return (
    autoFocus && !hasMessages && !window.matchMedia("(pointer: coarse)").matches
  );
}

interface ChatComposerModelPickerConfig {
  value: ModelProviderSelection | null;
  onChange: (value: ModelProviderSelection | null) => void;
  disabled: boolean;
}

function resolveChatComposerModelPicker(params: {
  modelSelection: ModelProviderSelection | null;
  setModelSelection: (value: ModelProviderSelection | null) => void;
  disabled: boolean;
}): ChatComposerModelPickerConfig {
  return {
    value: params.modelSelection,
    onChange: params.setModelSelection,
    disabled: params.disabled,
  };
}

function useChatComposerQueue(
  thread: ChatThreadSignals,
  queuedMessages: readonly QueuedChatMessageItem[],
) {
  const recallMessage = useSet(thread.recallMessage$);
  const focusInput = useSet(thread.focusInput$);
  const pageSignal = useGet(pageSignal$);

  const queuedMessagesById = new Map(
    queuedMessages.map((message) => {
      return [message.id, message] as const;
    }),
  );
  const queuedItems: QueuedComposerItem[] = Array.from(
    queuedMessagesById.values(),
  ).map((message) => {
    return {
      id: message.id,
      text: message.text,
    };
  });

  const onRemoveQueuedItem = (id: string) => {
    if (!queuedMessagesById.has(id)) {
      return;
    }
    detach(
      (async () => {
        await recallMessage(id, pageSignal);
        focusInput();
      })(),
      Reason.DomCallback,
    );
  };

  return { queuedItems, onRemoveQueuedItem };
}

function useChatComposerWorkflowEvents(thread: ChatThreadSignals) {
  const queue = useLastResolved(thread.workflowQueue.queue$);
  const workflowAutomations =
    useLastResolved(thread.headerAutomations.automations$) ?? [];
  const skipEvent = useSet(thread.workflowQueue.skipEvent$);
  const clearEvents = useSet(thread.workflowQueue.clear$);
  const setEventsPaused = useSet(thread.workflowQueue.setPaused$);
  const pageSignal = useGet(pageSignal$);
  const pendingEventIds = new Set(
    queue?.pending.map((event) => {
      return event.id;
    }) ?? [],
  );
  const workflowLabelsByAutomationId = new Map(
    workflowAutomations.map((automation) => {
      return [
        automation.id,
        automation.workflowDisplayName?.trim() || automation.workflowName,
      ] as const;
    }),
  );
  const workflowEventItems: WorkflowEventComposerItem[] =
    queue?.pending.map((event) => {
      return {
        id: event.id,
        text:
          event.triggerBrief?.trim() ||
          workflowLabelsByAutomationId.get(event.automationId) ||
          "Automation event",
      };
    }) ?? [];

  const onRemoveWorkflowEvent = (id: string) => {
    if (!pendingEventIds.has(id)) {
      return;
    }
    detach(skipEvent(id, pageSignal), Reason.DomCallback);
  };

  return {
    workflowEventItems,
    onRemoveWorkflowEvent,
    workflowEventsPaused: queue ? queue.pausedAt !== null : false,
    workflowEventsPauseReason: queue?.pauseReason,
    onSetWorkflowEventsPaused: (paused: boolean) => {
      detach(setEventsPaused(paused, pageSignal), Reason.DomCallback);
    },
    onClearWorkflowEvents: () => {
      detach(clearEvents(pageSignal), Reason.DomCallback);
    },
  };
}

// The thread's active goal (folded from goal-state markers, no separate
// poll) plus its cancel handler. Cancelling pauses the goal through the goal API;
// the backend then emits a goal_event marker, so the row folds away.
function useChatComposerActiveGoal(
  thread: ChatThreadSignals,
  pageSignal: AbortSignal,
) {
  const activeGoalObjective =
    useLastResolved(thread.activeGoalObjective$) ?? undefined;
  const activeGoal = activeGoalObjective
    ? { objective: activeGoalObjective }
    : undefined;
  const pauseChatThreadGoal = useSet(pauseChatThreadGoal$);
  const onCancelActiveGoal = activeGoal
    ? () => {
        detach(
          pauseChatThreadGoal(thread.threadId, pageSignal),
          Reason.DomCallback,
        );
      }
    : undefined;
  return { activeGoal, onCancelActiveGoal };
}

function useChatComposerModel(
  thread: ChatThreadSignals,
  pageSignal: AbortSignal,
) {
  // Per-thread composer selection comes from the event projection. Read with
  // useGet because event-backed thread metadata is a synchronous projection.
  const selectedModelResolved = useGet(thread.selectedModel$);
  const codexFastModeActive =
    useLastResolved(thread.codexFastModeActive$) ?? false;
  const baseModelSelection = selectedModelResolved
    ? { selectedModel: selectedModelResolved }
    : null;
  const modelSelection =
    baseModelSelection && codexFastModeActive
      ? {
          ...baseModelSelection,
          codexServiceTier: "fast" as const,
        }
      : baseModelSelection;
  const setModelSelection = useSet(thread.setModelSelection$);
  const selectedModelOauthAvailable =
    useLastResolved(thread.selectedModelOauthAvailable$) ?? true;
  const configureSelectedModel = useSet(thread.configureSelectedModel$);

  const handleModelSelectionChange = (
    selection: ModelProviderSelection | null,
  ): void => {
    detach(setModelSelection(selection, pageSignal), Reason.DomCallback);
  };

  const modelPicker = modelSelection
    ? resolveChatComposerModelPicker({
        modelSelection,
        setModelSelection: handleModelSelectionChange,
        disabled: false,
      })
    : undefined;
  const modelPickerLoading = selectedModelResolved === undefined;
  const submitBlockerProps =
    modelSelection && !selectedModelOauthAvailable
      ? {
          message:
            "The selected model is not available. Configure it before sending.",
          actionLabel: "Model Configure",
          onAction: () => {
            detach(configureSelectedModel(pageSignal), Reason.DomCallback);
          },
        }
      : undefined;

  return {
    modelPicker,
    modelPickerLoading,
    submitBlockerProps,
  };
}

function useChatThreadComposerSendState({
  thread,
  computerUseHostIdForSend,
  clearComputerUseHostOverride,
}: {
  thread: ChatThreadSignals;
  computerUseHostIdForSend: string | null | undefined;
  clearComputerUseHostOverride: () => void;
}) {
  const [sendLoadable, send] = useLoadableSet(thread.sendMessage$);
  const [queueLoadable, queueMessage] = useLoadableSet(thread.queueMessage$);
  const rootSignal = useGet(rootSignal$);
  const generationTemplate = useGet(thread.draft.generationTemplate$);
  const setGenerationTemplate = useSet(thread.draft.setGenerationTemplate$);

  const handleSend = (
    text: string,
    generationTemplate: GenerationTemplateRequest | undefined,
    editorDocument: EditorDocumentSnapshot,
  ) => {
    detach(
      (async () => {
        const computerUsePatch =
          computerUseHostIdForSend === undefined
            ? {}
            : { computerUseHostId: computerUseHostIdForSend };
        const sent = await send(
          text,
          { ...computerUsePatch, generationTemplate, editorDocument },
          rootSignal,
        );
        if (sent) {
          clearComputerUseHostOverride();
        }
      })(),
      Reason.DomCallback,
    );
  };

  const handleQueue = (
    text: string,
    generationTemplate: GenerationTemplateRequest | undefined,
    editorDocument: EditorDocumentSnapshot,
  ) => {
    detach(
      (async () => {
        const computerUseHostId = computerUseHostIdForSend;
        const queued = await queueMessage(
          text,
          { computerUseHostId, generationTemplate, editorDocument },
          rootSignal,
        );
        if (queued) {
          clearComputerUseHostOverride();
        }
      })(),
      Reason.DomCallback,
    );
  };

  return {
    handleSend,
    handleQueue,
    submissionLoading:
      sendLoadable.state === "loading" || queueLoadable.state === "loading",
    templatePicker: {
      value: generationTemplate,
      onChange: (value: GenerationTemplateRequest | undefined) => {
        setGenerationTemplate(value);
      },
    },
  };
}

function useChatThreadComputerUse(
  thread: ChatThreadSignals,
  pageSignal: AbortSignal,
) {
  const computerUseHostsLoadable = useLastLoadable(computerUseHosts$);
  const computerUseHosts =
    computerUseHostsLoadable.state === "hasData"
      ? computerUseHostsLoadable.data
      : [];
  const storedComputerUseHostId = useGet(thread.computerUseHostId$);
  const computerUseHostIdExplicit = useGet(thread.computerUseHostIdExplicit$);
  const selectedComputerUseHostId =
    computerUseHostsLoadable.state === "hasData" || computerUseHosts.length > 0
      ? resolveSelectedComputerUseHostId(
          computerUseHosts,
          storedComputerUseHostId,
        )
      : (storedComputerUseHostId ?? null);
  const visibleHosts = visibleComputerUseHosts(
    computerUseHosts,
    selectedComputerUseHostId,
  );
  const setComputerUseHostId = useSet(thread.setComputerUseHostId$);
  const clearComputerUseHostOverride = useSet(
    thread.clearComputerUseHostIdOverride$,
  );
  const computerUseHostIdForSend = computerUseHostIdExplicit
    ? selectedComputerUseHostId
    : undefined;
  const handleComputerUseHostChange = (hostId: string | null) => {
    detach(setComputerUseHostId(hostId, pageSignal), Reason.DomCallback);
  };

  return {
    selectedComputerUseHostId,
    computerUseHostIdForSend,
    clearComputerUseHostOverride,
    computerUse: {
      hosts: visibleHosts,
      loading:
        computerUseHostsLoadable.state === "loading" &&
        computerUseHosts.length === 0,
      selectedHostId: selectedComputerUseHostId,
      onChange: handleComputerUseHostChange,
      downloadUrl: ZERO_DESKTOP_DOWNLOAD_URL,
    },
  };
}

function useChatThreadComposerWorkflowPrompt({
  thread,
  pageSignal,
}: {
  thread: ChatThreadSignals;
  pageSignal: AbortSignal;
}): {
  onCreateWorkflowPrompt: (() => void) | undefined;
  replaceDraftDialogOpen: boolean;
  onConfirmReplaceDraft: () => void;
  onReplaceDialogOpenChange: (open: boolean) => void;
} {
  const attachments = useGet(thread.draft.attachments$);
  const readInput = useSet(thread.draft.readInput$);
  const setInput = useSet(thread.draft.setInput$);
  const clearDraft = useSet(thread.draft.clear$);
  const queueDraftSync = useSet(thread.queueDraftSync$);
  const focusComposer = useSet(thread.focusInput$);
  const replaceDraftTarget = useGet(replaceWorkflowPromptDraftTarget$);
  const setReplaceDraftTarget = useSet(setReplaceWorkflowPromptDraftTarget$);
  const workflowPromptDraftTarget = `composer:${thread.threadId}`;
  const replaceDraftDialogOpen =
    replaceDraftTarget === workflowPromptDraftTarget;

  const applyWorkflowPrompt = () => {
    clearDraft();
    setInput(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
    detach(queueDraftSync(pageSignal), Reason.DomCallback);
    focusComposer();
  };

  const handleCreateWorkflowPrompt = () => {
    if (readInput().trim().length > 0 || attachments.length > 0) {
      setReplaceDraftTarget(workflowPromptDraftTarget);
      return;
    }
    applyWorkflowPrompt();
  };

  const handleConfirmReplaceDraft = () => {
    setReplaceDraftTarget(null);
    applyWorkflowPrompt();
  };

  const handleReplaceDialogOpenChange = (open: boolean) => {
    setReplaceDraftTarget(open ? workflowPromptDraftTarget : null);
  };

  return {
    onCreateWorkflowPrompt: handleCreateWorkflowPrompt,
    replaceDraftDialogOpen,
    onConfirmReplaceDraft: handleConfirmReplaceDraft,
    onReplaceDialogOpenChange: handleReplaceDialogOpenChange,
  };
}

const EMPTY_QUEUED_MESSAGE_ITEMS: readonly QueuedChatMessageItem[] = [];

function equalQueuedMessageItems(
  previous: readonly QueuedChatMessageItem[],
  next: readonly QueuedChatMessageItem[],
): boolean {
  return equalArrays(previous, next, (left, right) => {
    return left.id === right.id && left.text === right.text;
  });
}

function useQueuedMessageItems(thread: ChatThreadSignals) {
  const hasQueuedMessages = useLastResolved(thread.hasQueuedMessages$) ?? false;
  const queuedMessageItems$ = hasQueuedMessages
    ? thread.queuedMessageItems$
    : thread.emptyQueuedMessageItems$;
  return (
    useLastResolved(queuedMessageItems$, {
      equalityFn: equalQueuedMessageItems,
    }) ?? EMPTY_QUEUED_MESSAGE_ITEMS
  );
}

function ChatThreadComposer({ thread }: { thread: ChatThreadSignals }) {
  const queuedMessageItems = useQueuedMessageItems(thread);
  const hasMessagesResolved = useLastResolved(thread.hasMessages$);
  const hasMessages = hasMessagesResolved ?? false;
  const displayName = useLastResolved(thread.agentDisplayName$) ?? "Zero";
  const sendButtonStatus =
    useLastResolved(thread.composerSendButtonStatus$) ?? "sending";
  const cancelRun = useSet(thread.cancelRun$);
  const queueDraftSync = useSet(thread.queueDraftSync$);
  const pageSignal = useGet(pageSignal$);
  const {
    computerUseHostIdForSend,
    clearComputerUseHostOverride,
    computerUse,
  } = useChatThreadComputerUse(thread, pageSignal);

  const { queuedItems, onRemoveQueuedItem } = useChatComposerQueue(
    thread,
    queuedMessageItems,
  );
  const workflowEvents = useChatComposerWorkflowEvents(thread);
  const { activeGoal, onCancelActiveGoal } = useChatComposerActiveGoal(
    thread,
    pageSignal,
  );
  const { modelPicker, modelPickerLoading, submitBlockerProps } =
    useChatComposerModel(thread, pageSignal);
  const { handleSend, handleQueue, submissionLoading, templatePicker } =
    useChatThreadComposerSendState({
      thread,
      computerUseHostIdForSend,
      clearComputerUseHostOverride,
    });
  const skeletonVisible = hasMessagesResolved === undefined;
  const composerSending = sendButtonStatus === "sending";
  const queueWhileSending = canQueueMessage({ sending: composerSending });

  const handleDraftChange = () => {
    detach(queueDraftSync(pageSignal), Reason.DomCallback);
  };

  const workflowPrompt = useChatThreadComposerWorkflowPrompt({
    thread,
    pageSignal,
  });
  const composerOptions: ZeroChatComposerProps = {
    composer: thread.workflowComposer,
    composerConnectors: thread.composerConnectors,
    onSend: handleSend,
    onQueue: handleQueue,
    sending: composerSending,
    queueWhileSending,
    submissionLoading,
    onCancel: composerSending
      ? () => {
          detach(cancelRun(pageSignal), Reason.DomCallback);
        }
      : undefined,
    displayName,
    className: "w-full min-w-0",
    autoFocus: shouldAutoFocusComposer({
      autoFocus: true,
      hasMessages,
    }),
    enableMobileSingleLine: true,
    onDraftChange: handleDraftChange,
    draft: thread.draft,
    composerFileInput$: thread.composerFileInput$,
    setComposerFileInput$: thread.setComposerFileInput$,
    chatThreadId: thread.threadId,
    actionsLoading: skeletonVisible,
    modelPicker,
    templatePicker,
    onCreateWorkflowPrompt: workflowPrompt.onCreateWorkflowPrompt,
    computerUse,
    modelPickerLoading,
    submitBlocker: submitBlockerProps,
    queuedItems,
    onRemoveQueuedItem,
    ...workflowEvents,
    activeGoal,
    onCancelActiveGoal,
  };
  const composer = useZeroChatComposer(composerOptions);

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 bg-[hsl(var(--background))] pb-2"
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-[21px] bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div className="overflow-y-auto [scrollbar-gutter:stable] pb-2 pl-4 pr-4 pt-3 sm:pl-6 sm:pr-6">
        <div className="mx-auto max-w-[900px]">
          {composer}
          <ReplaceComposerDraftDialog
            open={workflowPrompt.replaceDraftDialogOpen}
            onOpenChange={workflowPrompt.onReplaceDialogOpenChange}
            onConfirm={workflowPrompt.onConfirmReplaceDraft}
          />
          <PersonalClaudeCodeDeviceAuthDialog />
          <PersonalCodexDeviceAuthDialog />
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

interface ServerThinkingLabel {
  readonly displayedText: string;
  readonly fullText: string;
  readonly id: string;
  readonly setRef: (
    el: HTMLParagraphElement | null,
  ) => (() => void) | undefined;
}

function ThinkingLabel({
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
}: {
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
}) {
  const openQueueDrawer = useSet(openQueueDrawer$);
  const pageSignal = useGet(pageSignal$);

  if (isQueued) {
    return (
      <p className="zero-shimmer-text min-w-0 flex-1 text-[0.8125rem] truncate">
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
    );
  }

  if (serverThinkingLabel) {
    return (
      <p
        key={serverThinkingLabel.id}
        ref={serverThinkingLabel.setRef}
        className="zero-shimmer-text min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[0.8125rem]"
        aria-label={serverThinkingLabel.fullText}
      >
        {serverThinkingLabel.displayedText || "\u00a0"}
      </p>
    );
  }

  return (
    <p className="zero-shimmer-text min-w-0 flex-1 text-[0.8125rem] truncate">
      {thinkingLabel}
    </p>
  );
}

function InlineThinkingRow({
  blockStyle,
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
}: {
  blockStyle: CSSProperties;
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
}) {
  return (
    <div className="flex items-center gap-2 h-5">
      <span className="zero-blocks shrink-0" style={blockStyle}>
        <span />
        <span />
        <span />
      </span>
      <ThinkingLabel
        isQueued={isQueued}
        thinkingLabel={thinkingLabel}
        serverThinkingLabel={serverThinkingLabel}
      />
    </div>
  );
}

function FinishedRunRow({
  thread,
  source,
}: {
  thread: ChatThreadSignals;
  source: RecommendedFollowupSource | null;
}) {
  const donePhrase = useLastResolved(thread.donePhrase$) ?? "Done";
  const runFinishedAt = useLastResolved(thread.latestRunFinishCreatedAt$);
  const label =
    source && runFinishedAt
      ? `Keep going · ${formatChatTimestamp(runFinishedAt)}`
      : source
        ? "Keep going"
        : donePhrase;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5 flex-col justify-center gap-1.5">
        <div className="h-px w-full bg-border/40" />
        <div className="flex items-center gap-2">
          <p className={RUN_SECTION_LABEL_CLASS}>{label}</p>
          <div className="h-px flex-1 bg-border/40" />
        </div>
      </div>
      {source ? (
        <RecommendedFollowupList thread={thread} source={source} />
      ) : null}
    </div>
  );
}

function WaitingForAssistantResponse({
  thread,
  blockStyle,
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
}: {
  thread: ChatThreadSignals;
  blockStyle: CSSProperties;
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
}) {
  return (
    <div
      data-thinking-indicator
      data-role="assistant"
      className="zero-thinking-enter flex flex-col gap-1"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-[0.9375rem] leading-[1.7] min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="zero-blocks shrink-0" style={blockStyle}>
              <span />
              <span />
              <span />
            </span>
            <ThinkingLabel
              isQueued={isQueued}
              thinkingLabel={thinkingLabel}
              serverThinkingLabel={serverThinkingLabel}
            />
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

function AssistantThinkingStatusRow({
  running,
  blockStyle,
  isQueued,
  thinkingLabel,
  serverThinkingLabel,
  thread,
  recommendedFollowupSource,
}: {
  running: boolean;
  blockStyle: CSSProperties;
  isQueued: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
  thread: ChatThreadSignals;
  recommendedFollowupSource: RecommendedFollowupSource | null;
}) {
  const thinkingIndicatorProps = running
    ? { "data-thinking-indicator": true }
    : {};

  return (
    <div
      {...thinkingIndicatorProps}
      data-role="assistant-thinking"
      className="-mt-5 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start"
    >
      <div className="hidden @[900px]:block" />
      <div className="min-w-0">
        {running ? (
          <InlineThinkingRow
            blockStyle={blockStyle}
            isQueued={isQueued}
            thinkingLabel={thinkingLabel}
            serverThinkingLabel={serverThinkingLabel}
          />
        ) : (
          <FinishedRunRow thread={thread} source={recommendedFollowupSource} />
        )}
      </div>
    </div>
  );
}

function thinkingIndicatorRunning(mode: ThinkingIndicatorMode): boolean {
  return mode !== null && mode !== "finished";
}

function thinkingIndicatorQueued(mode: ThinkingIndicatorMode): boolean {
  return mode === "waiting-queued" || mode === "running-queued";
}

function thinkingIndicatorUsesStatusRow(mode: ThinkingIndicatorMode): boolean {
  return mode === "running" || mode === "running-queued" || mode === "finished";
}

function equalRecommendedFollowupSources(
  previous: RecommendedFollowupSource | null,
  next: RecommendedFollowupSource | null,
): boolean {
  return (
    previous === next ||
    (previous !== null &&
      next !== null &&
      previous.messageId === next.messageId &&
      previous.followups === next.followups)
  );
}

function ThinkingIndicator({ thread }: { thread: ChatThreadSignals }) {
  const [c1, c2, c3] = useGet(thread.blockColors$);
  const blockStyle = {
    "--zb-c1": c1,
    "--zb-c2": c2,
    "--zb-c3": c3,
  } as CSSProperties;
  const mode = useLastResolved(thread.thinkingIndicatorMode$) ?? null;
  const thinkingText = useLastResolved(thread.thinkingText$);
  const recommendedFollowupSource =
    useLastResolved(thread.recommendedFollowupSource$, {
      equalityFn: equalRecommendedFollowupSources,
    }) ?? null;
  const thinkingLabel = useGet(thread.thinkingPhrase$);
  const running = thinkingIndicatorRunning(mode);
  const isQueued = thinkingIndicatorQueued(mode);
  const thinkingMessageId = useLastResolved(thread.thinkingMessageId$);
  const displayedThinkingText =
    useLastResolved(thread.displayedThinkingText$) ?? "";
  const setThinkingIndicatorTextRef = useSet(
    thread.setThinkingIndicatorTextRef$,
  );
  const serverThinkingLabel =
    thinkingText && thinkingMessageId && running
      ? {
          displayedText: displayedThinkingText,
          fullText: thinkingText,
          id: thinkingMessageId,
          setRef: setThinkingIndicatorTextRef,
        }
      : undefined;

  if (mode === null) {
    return null;
  }

  // Shared inline row with fixed h-5 to prevent layout jump on transition
  if (thinkingIndicatorUsesStatusRow(mode)) {
    return (
      <AssistantThinkingStatusRow
        running={running}
        blockStyle={blockStyle}
        isQueued={isQueued}
        thinkingLabel={thinkingLabel}
        serverThinkingLabel={serverThinkingLabel}
        thread={thread}
        recommendedFollowupSource={recommendedFollowupSource}
      />
    );
  }

  // Waiting for first assistant response — show bubble with avatar
  return (
    <WaitingForAssistantResponse
      thread={thread}
      blockStyle={blockStyle}
      isQueued={isQueued}
      thinkingLabel={thinkingLabel}
      serverThinkingLabel={serverThinkingLabel}
    />
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
  escapeMarkdownHtml = false,
  markdownMediaPreview = true,
}: {
  blocks: BodyRenderBlock[];
  openLightbox: (url: string) => void;
  hardBreaks: boolean;
  escapeMarkdownHtml?: boolean;
  markdownMediaPreview?: boolean;
}) {
  const cardOccurrences = new Map<string, number>();
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => {
        return (
          <BodyRenderBlockView
            key={bodyRenderBlockKey(block, cardOccurrences)}
            block={block}
            openLightbox={openLightbox}
            openVideoLightbox={openVideoLightbox}
            hardBreaks={hardBreaks}
            escapeMarkdownHtml={escapeMarkdownHtml}
            markdownMediaPreview={markdownMediaPreview}
          />
        );
      })}
    </div>
  );
}

function bodyRenderBlockKey(
  block: BodyRenderBlock,
  cardOccurrences: Map<string, number>,
): string {
  if (block.type === "markdown") {
    return block.id;
  }
  const resourceKey = `${block.type}:${block.resourceKey}`;
  const occurrence = (cardOccurrences.get(resourceKey) ?? 0) + 1;
  cardOccurrences.set(resourceKey, occurrence);
  return `${resourceKey}:${String(occurrence)}`;
}

function BodyRenderBlockView({
  block,
  openLightbox,
  openVideoLightbox,
  hardBreaks,
  escapeMarkdownHtml,
  markdownMediaPreview,
}: {
  block: BodyRenderBlock;
  openLightbox: (url: string) => void;
  openVideoLightbox: (value: { url: string; filename: string }) => void;
  hardBreaks: boolean;
  escapeMarkdownHtml: boolean;
  markdownMediaPreview: boolean;
}) {
  switch (block.type) {
    case "markdown": {
      return (
        <Markdown
          source={
            hardBreaks ? block.content.replace(/\n/g, "  \n") : block.content
          }
          mediaPreview={markdownMediaPreview}
          mathEnabled
          escapeHtml={escapeMarkdownHtml}
          style={{ fontSize: "inherit", lineHeight: "inherit" }}
        />
      );
    }
    case "connector-action": {
      return <ConnectorActionCard signals={block.signals} />;
    }
    case "custom-connector-action": {
      return <CustomConnectorActionCard signals={block.signals} />;
    }
    case "permission-action": {
      return <PermissionActionCard signals={block.signals} />;
    }
    case "computer-use-authorization": {
      return <ComputerUseAuthorizationCard signals={block.signals} />;
    }
    case "plan-upgrade": {
      return <PlanUpgradeCard signals={block.signals} />;
    }
    case "mail-draft": {
      return <MailDraftCard signals={block.signals} />;
    }
    case "browser-session": {
      return <BrowserSessionCard signals={block.signals} />;
    }
    case "artifact": {
      return (
        <ArtifactBodyRenderBlockView
          signals={block.signals}
          openLightbox={openLightbox}
          openVideoLightbox={openVideoLightbox}
        />
      );
    }
  }
}

function ArtifactBodyRenderBlockView({
  signals,
  openLightbox,
  openVideoLightbox,
}: {
  signals: ArtifactSignals;
  openLightbox: (url: string) => void;
  openVideoLightbox: (value: { url: string; filename: string }) => void;
}) {
  const previewImageLoadable = useLastLoadable(signals.previewImageUrl$);
  const previewImagePending = previewImageLoadable.state === "loading";
  const previewImageUrl =
    previewImageLoadable.state === "hasData"
      ? previewImageLoadable.data
      : undefined;

  if (signals.kind === "image") {
    return (
      <ChatImagePreviewLink
        alt={signals.filename}
        ariaLabel={`Preview ${signals.filename}`}
        imageClassName="block h-full w-full object-contain"
        linkClassName={CHAT_INLINE_IMAGE_PREVIEW_CLASS}
        onPreview={() => {
          openLightbox(signals.url);
        }}
        placeholderClassName="h-full w-full"
        url={signals.url}
      />
    );
  }
  if (signals.kind === "video") {
    return (
      <ChatVideoPreviewButton
        ariaLabel={`Preview ${signals.filename}`}
        buttonClassName={CHAT_INLINE_VIDEO_BODY_PREVIEW_CLASS}
        filename={signals.filename}
        onPreview={() => {
          openVideoLightbox({
            url: signals.url,
            filename: signals.filename,
          });
        }}
        posterClassName="h-full w-full"
        previewImagePending={previewImagePending}
        previewImageUrl={previewImageUrl}
        url={signals.url}
        videoClassName="h-full w-full object-contain"
      />
    );
  }
  return (
    <AttachmentPreview
      attachment={{
        filename: signals.filename,
        url: signals.url,
        contentType: contentTypeForBodyPreviewKind(signals.kind),
        ...(previewImagePending ? { previewImagePending: true } : {}),
        ...(previewImageUrl ? { previewImageUrl } : {}),
      }}
      text$={signals.text$}
    />
  );
}

function ConnectorActionCard({ signals }: { signals: ConnectorSignals }) {
  const pageSignal = useGet(pageSignal$);
  const available = useLastResolved(signals.available$) ?? false;
  const connected = useLastResolved(signals.connected$) ?? false;
  const completeLoadable = useLoadable(signals.complete$);
  const complete =
    completeLoadable.state === "hasData" && completeLoadable.data;
  const catalogItem = useLastResolved(signals.catalogItem$);
  const [activateLoadable, activate] = useLoadableSet(signals.activate$);
  const loading =
    completeLoadable.state === "loading" ||
    activateLoadable.state === "loading";
  if (!available || !catalogItem) {
    return null;
  }
  const reconnectRequired =
    connectorCurrentConnectionStatus(catalogItem) === "reconnect-required";
  const actionLabel = complete
    ? "Authorized"
    : reconnectRequired
      ? "Reconnect"
      : connected
        ? "Authorize"
        : "Connect";

  return (
    <div
      data-testid="connector-action-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <ConnectorIcon icon={catalogItem.icon} size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {catalogItem.label}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {catalogItem.description}
          </div>
        </div>
      </div>
      <button
        type="button"
        disabled={complete || loading}
        onClick={() => {
          detach(activate(pageSignal), Reason.DomCallback);
        }}
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {loading && <IconLoader2 size={15} className="animate-spin" />}
        {actionLabel}
      </button>
    </div>
  );
}

function CustomConnectorActionCard({
  signals,
}: {
  signals: CustomConnectorSignals;
}) {
  return (
    <div
      data-testid="custom-connector-action-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <IconPackage size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {signals.displayName}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {signals.agentId
              ? "Review, connect, and authorize this custom connector for the agent."
              : "Review and connect this custom connector."}
          </div>
        </div>
      </div>
      <a
        href={signals.originalUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-accent sm:w-auto"
      >
        Configure
        <IconArrowUpRight size={15} />
      </a>
    </div>
  );
}

function ComputerUseAuthorizationCard({
  signals,
}: {
  signals: ComputerUseAuthorizationSignals;
}) {
  return (
    <div
      data-testid="computer-use-authorization-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <IconDeviceDesktop size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            Computer Use authorization
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            Select a Desktop host for future runs in this thread.
          </div>
        </div>
      </div>
      <a
        href={signals.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-accent sm:w-auto"
      >
        Authorize
        <IconArrowUpRight size={15} />
      </a>
    </div>
  );
}

function PlanUpgradeCard({ signals }: { signals: PlanUpgradeSignals }) {
  const featureSwitches = useGet(featureSwitch$);
  if (!featureSwitches[FeatureSwitchKey.PlanUpgradeGuidance]) {
    return (
      <Markdown
        source={signals.fallbackMarkdown}
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    );
  }

  return (
    <div
      data-testid="plan-upgrade-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <IconCoins size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            Upgrade your workspace
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            Compare plans to unlock paid workspace features and additional
            credits.
          </div>
        </div>
      </div>
      <a
        href={signals.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-accent sm:w-auto"
      >
        Compare plans
        <IconArrowUpRight size={15} />
      </a>
    </div>
  );
}

type PermissionAction = "allow" | "deny";

type PermissionActionUserGrant = UserPermissionGrantResponse;

type PermissionActionCardStatus =
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "save-error" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "already-applied" }
  | { kind: "missing-target" }
  | { kind: "missing-permission" };

interface LoadableLike<T> {
  state: string;
  data?: T;
}

type ApplyUserPermissionGrantFn = (
  params: {
    agentId?: string;
    workflowId?: string;
    connectorRef: string;
    permission: string;
    action: PermissionAction;
    expiresIn?: UserPermissionGrantExpiresIn;
  },
  signal: AbortSignal,
) => Promise<UserPermissionGrantResponse>;

function loadableData<T>(loadable: LoadableLike<T>): T | undefined {
  return loadable.state === "hasData" ? loadable.data : undefined;
}

function permissionActionVerb(action: PermissionAction): string {
  return action === "allow" ? "Allow" : "Deny";
}

function permissionActionStatusText(
  status: PermissionActionCardStatus,
  action: "allow" | "deny",
): { label: string; className: string } | null {
  if (status.kind === "saved") {
    return action === "allow"
      ? { label: "Permissions updated", className: "text-green-600" }
      : { label: "Permission denied", className: "text-destructive" };
  }
  if (status.kind === "already-applied") {
    return action === "allow"
      ? { label: "Already allowed", className: "text-green-600" }
      : { label: "Already denied", className: "text-destructive" };
  }
  return null;
}

function PermissionActionButton({
  status,
  onClick,
}: {
  status: PermissionActionCardStatus;
  onClick: () => void;
}) {
  if (
    status.kind !== "ready" &&
    status.kind !== "saving" &&
    status.kind !== "save-error"
  ) {
    return null;
  }

  const saving = status.kind === "saving";
  return (
    <button
      type="button"
      disabled={saving}
      onClick={onClick}
      className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-accent sm:w-auto"
    >
      {saving && <IconLoader2 size={15} className="animate-spin" />}
      {saving ? "Saving..." : "Confirm"}
    </button>
  );
}

function PermissionActionTerminalStatus({
  status,
  action,
}: {
  status: PermissionActionCardStatus;
  action: "allow" | "deny";
}) {
  const text = permissionActionStatusText(status, action);
  if (!text) {
    return null;
  }
  return (
    <span className={`shrink-0 text-[0.9375rem] font-medium ${text.className}`}>
      {text.label}
    </span>
  );
}

function PermissionActionInlineStatus({
  status,
}: {
  status: PermissionActionCardStatus;
}) {
  switch (status.kind) {
    case "loading": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <IconLoader2 size={13} className="animate-spin" />
          <span>Checking permission status...</span>
        </div>
      );
    }
    case "load-error": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <IconAlertCircle size={13} />
          <span>Couldn&apos;t load permission status</span>
        </div>
      );
    }
    case "save-error": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <IconAlertCircle size={13} />
          <span>Couldn&apos;t update permissions</span>
        </div>
      );
    }
    case "missing-target": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <IconAlertCircle size={13} />
          <span>Agent not found</span>
        </div>
      );
    }
    case "missing-permission": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <IconAlertCircle size={13} />
          <span>Unknown permission</span>
        </div>
      );
    }
    case "ready":
    case "saving":
    case "saved":
    case "already-applied": {
      return null;
    }
  }
}

function isPermissionActionLoading(params: {
  agentLoading: boolean;
  permissionMetadataLoading: boolean;
  userGrantsLoading: boolean;
}): boolean {
  return (
    params.agentLoading ||
    params.permissionMetadataLoading ||
    params.userGrantsLoading
  );
}

function isPermissionActionSaving(params: { grantLoading: boolean }): boolean {
  return params.grantLoading;
}

function isPermissionActionLoadError(params: {
  agentError: boolean;
  permissionMetadataError: boolean;
  userGrantsError: boolean;
}): boolean {
  return (
    params.agentError ||
    params.permissionMetadataError ||
    params.userGrantsError
  );
}

function isPermissionActionAlreadyApplied(params: {
  hasAgent: boolean;
  userGrantPolicy: FirewallPolicyValue | undefined;
  action: "allow" | "deny";
}): boolean {
  if (!params.hasAgent) {
    return false;
  }
  return params.userGrantPolicy === params.action;
}

function findPermissionActionPermission(
  block: PermissionSignals,
  metadata: PublicConnectorCatalogPermissionDetail | undefined,
) {
  return metadata
    ? (findPermissionInMetadata(metadata, block.permission) ?? undefined)
    : undefined;
}

function permissionActionUserGrantPolicy(
  loadable: LoadableLike<readonly PermissionActionUserGrant[]>,
  block: PermissionSignals,
  metadata: PublicConnectorCatalogPermissionDetail | undefined,
): FirewallPolicyValue | undefined {
  const grants = loadableData(loadable);
  if (!grants || !metadata) {
    return undefined;
  }
  return resolveUserPermissionGrantPolicy(grants, metadata, block.permission);
}

function permissionActionUserGrant(
  loadable: LoadableLike<readonly PermissionActionUserGrant[]>,
  block: PermissionSignals,
): PermissionActionUserGrant | undefined {
  const grants = loadableData(loadable);
  if (!grants) {
    return undefined;
  }
  return grants.find((grant) => {
    return (
      grant.connectorRef === block.connectorRef &&
      grant.permission === block.permission &&
      grant.action === block.action
    );
  });
}

function permissionActionGrantExpiresAt({
  savedGrant,
  savedGrantActive,
  existingGrant,
  existingGrantActive,
  status,
}: {
  savedGrant: PermissionActionUserGrant | null;
  savedGrantActive: boolean;
  existingGrant: PermissionActionUserGrant | undefined;
  existingGrantActive: boolean;
  status: PermissionActionCardStatus;
}): string | null {
  if (savedGrantActive) {
    return savedGrant?.expiresAt ?? null;
  }
  if (existingGrantActive) {
    return existingGrant?.expiresAt ?? null;
  }
  if (status.kind !== "ready") {
    return null;
  }
  return savedGrant?.expiresAt ?? existingGrant?.expiresAt ?? null;
}

function createPermissionActionCardStatus(params: {
  hasAgent: boolean;
  hasPermission: boolean;
  loading: boolean;
  loadError: boolean;
  saving: boolean;
  saveDone: boolean;
  saveError: boolean;
  alreadyApplied: boolean;
}): PermissionActionCardStatus {
  if (params.saving) {
    return { kind: "saving" };
  }
  if (params.saveDone) {
    return { kind: "saved" };
  }
  if (params.loading) {
    return { kind: "loading" };
  }
  if (params.loadError) {
    return { kind: "load-error" };
  }
  if (!params.hasAgent) {
    return { kind: "missing-target" };
  }
  if (!params.hasPermission) {
    return { kind: "missing-permission" };
  }
  if (params.alreadyApplied) {
    return { kind: "already-applied" };
  }
  if (params.saveError) {
    return { kind: "save-error" };
  }
  return { kind: "ready" };
}

function createPermissionActionCardViewState(params: {
  block: PermissionSignals;
  hasAgent: boolean;
  agentLoadableState: string;
  permissionMetadataLoadable: LoadableLike<PublicConnectorCatalogPermissionDetail | null>;
  userGrantsLoadable: LoadableLike<readonly PermissionActionUserGrant[]>;
  grantLoadableState: string;
  savedGrantActive: boolean;
}) {
  const permissionMetadata =
    params.permissionMetadataLoadable.state === "hasData"
      ? (params.permissionMetadataLoadable.data ?? undefined)
      : undefined;
  const focusedPermission = findPermissionActionPermission(
    params.block,
    permissionMetadata,
  );
  const actionLabel = permissionActionVerb(params.block.action);
  const loading = isPermissionActionLoading({
    agentLoading: params.agentLoadableState === "loading",
    permissionMetadataLoading:
      params.permissionMetadataLoadable.state === "loading",
    userGrantsLoading: params.userGrantsLoadable.state === "loading",
  });
  const loadError = isPermissionActionLoadError({
    agentError: params.agentLoadableState === "hasError",
    permissionMetadataError:
      params.permissionMetadataLoadable.state === "hasError",
    userGrantsError: params.userGrantsLoadable.state === "hasError",
  });
  const saving = isPermissionActionSaving({
    grantLoading: params.grantLoadableState === "loading",
  });
  const saveError = params.grantLoadableState === "hasError";
  const userGrantPolicy = permissionActionUserGrantPolicy(
    params.userGrantsLoadable,
    params.block,
    permissionMetadata,
  );
  const alreadyApplied = isPermissionActionAlreadyApplied({
    hasAgent: params.hasAgent,
    userGrantPolicy,
    action: params.block.action,
  });
  const saveDone =
    params.grantLoadableState === "hasData" && params.savedGrantActive;
  const status = createPermissionActionCardStatus({
    hasAgent: params.hasAgent,
    hasPermission: Boolean(focusedPermission),
    loading,
    loadError,
    saving,
    saveDone,
    saveError,
    alreadyApplied,
  });
  return {
    actionLabel,
    status,
    focusedPermission,
  };
}

function runPermissionAction(params: {
  status: PermissionActionCardStatus;
  runUserGrant: () => void;
}): void {
  if (params.status.kind !== "ready" && params.status.kind !== "save-error") {
    return;
  }

  params.runUserGrant();
}

function createPermissionActionHandler(params: {
  block: PermissionSignals;
  pageSignal: AbortSignal;
  focusedPermission: { name: string } | undefined;
  status: PermissionActionCardStatus;
  expirationAvailable: boolean;
  expiresIn: UserPermissionGrantExpiresIn;
  applyGrant: ApplyUserPermissionGrantFn;
  runCallback: (
    args: {
      readonly threadId: string;
      readonly agentId: string;
      readonly callbackPrompt: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
}): () => void {
  return () => {
    const permissionName =
      params.focusedPermission?.name ?? params.block.permission;
    runPermissionAction({
      status: params.status,
      runUserGrant: () => {
        detach(
          (async () => {
            await params.applyGrant(
              {
                agentId: params.block.agentId,
                connectorRef: params.block.connectorRef,
                permission: permissionName,
                action: params.block.action,
                ...(params.expirationAvailable
                  ? { expiresIn: params.expiresIn }
                  : {}),
              },
              params.pageSignal,
            );
            if (params.block.callbackPrompt && params.block.threadId) {
              await params.runCallback(
                {
                  threadId: params.block.threadId,
                  agentId: params.block.agentId,
                  callbackPrompt: params.block.callbackPrompt,
                },
                params.pageSignal,
              );
            }
          })(),
          Reason.DomCallback,
        );
      },
    });
  };
}

function PermissionActionCardContent({
  signals,
  icon,
  connectorLabel,
  actionLabel,
  permissionName,
  status,
  expirationAvailable,
  expiresIn,
  onExpiresInChange,
  expiresAt,
  onClick,
}: {
  signals: PermissionSignals;
  icon: PublicConnectorCatalogPermissionDetail["icon"] | undefined;
  connectorLabel: string;
  actionLabel: string;
  permissionName: string;
  status: PermissionActionCardStatus;
  expirationAvailable: boolean;
  expiresIn: UserPermissionGrantExpiresIn;
  onExpiresInChange: (value: UserPermissionGrantExpiresIn) => void;
  expiresAt: string | null;
  onClick: () => void;
}) {
  const rawExpiryText = expirationAvailable
    ? permissionGrantExpiryText(expiresAt)
    : null;
  const expiryText =
    rawExpiryText === "Expires in less than 1 hour" ? null : rawExpiryText;
  const showDurationSelect =
    expirationAvailable &&
    (status.kind === "ready" ||
      status.kind === "saving" ||
      status.kind === "save-error");
  return (
    <div
      data-testid="permission-action-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <ConnectorIcon icon={icon} size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {connectorLabel} permissions
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {actionLabel} {permissionName}
          </div>
          <PermissionActionInlineStatus status={status} />
          {expiryText && (
            <div className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              {expiryText}
            </div>
          )}
        </div>
      </div>
      <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
        {showDurationSelect && (
          <PermissionGrantDurationSelect
            value={expiresIn}
            onValueChange={onExpiresInChange}
            disabled={status.kind === "saving"}
            ariaLabel="Permission duration"
          />
        )}
        <PermissionActionTerminalStatus
          status={status}
          action={signals.action}
        />
        <PermissionActionButton status={status} onClick={onClick} />
      </div>
    </div>
  );
}

function PermissionActionCardForTarget({
  signals,
  hasTarget,
  targetLoadableState,
  userGrantsLoadable,
}: {
  signals: PermissionSignals;
  hasTarget: boolean;
  targetLoadableState: string;
  userGrantsLoadable: LoadableLike<readonly PermissionActionUserGrant[]>;
}) {
  const pageSignal = useGet(pageSignal$);
  const expirationAvailable = signals.action === "allow";
  const durationScope = `${signals.href}\u0000${signals.expiresIn ?? ""}`;
  const expiresInByScope = useGet(permissionGrantExpiresInByScope$);
  const setExpiresInForScope = useSet(setPermissionGrantExpiresIn$);
  const expiresIn =
    expiresInByScope[durationScope] ??
    signals.expiresIn ??
    DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN;
  const permissionMetadataLoadable = useLoadable(signals.metadata$);
  const [grantLoadable, applyGrant] = useLoadableSet(applyUserPermissionGrant$);
  const runCallback = useSet(runChatActionCallback$);
  const savedGrant =
    grantLoadable.state === "hasData" ? grantLoadable.data : null;
  const savedGrantActive = savedGrant
    ? isActiveUserPermissionGrant(savedGrant)
    : false;
  const existingGrant = permissionActionUserGrant(userGrantsLoadable, signals);
  const existingGrantActive = existingGrant
    ? isActiveUserPermissionGrant(existingGrant)
    : false;
  const actionState = createPermissionActionCardViewState({
    block: signals,
    hasAgent: hasTarget,
    agentLoadableState: targetLoadableState,
    permissionMetadataLoadable,
    userGrantsLoadable,
    grantLoadableState: grantLoadable.state,
    savedGrantActive,
  });
  const permissionMetadata =
    permissionMetadataLoadable.state === "hasData"
      ? permissionMetadataLoadable.data
      : null;
  const grantExpiresAt = permissionActionGrantExpiresAt({
    savedGrant,
    savedGrantActive,
    existingGrant,
    existingGrantActive,
    status: actionState.status,
  });

  return (
    <PermissionActionCardContent
      signals={signals}
      icon={permissionMetadata?.icon}
      connectorLabel={permissionMetadata?.label ?? signals.connectorRef}
      actionLabel={actionState.actionLabel}
      permissionName={actionState.focusedPermission?.name ?? signals.permission}
      status={actionState.status}
      expirationAvailable={expirationAvailable}
      expiresIn={expiresIn}
      onExpiresInChange={(value) => {
        setExpiresInForScope(durationScope, value);
      }}
      expiresAt={grantExpiresAt}
      onClick={createPermissionActionHandler({
        block: signals,
        pageSignal,
        focusedPermission: actionState.focusedPermission,
        status: actionState.status,
        expirationAvailable,
        expiresIn,
        applyGrant,
        runCallback,
      })}
    />
  );
}

function PermissionActionCard({ signals }: { signals: PermissionSignals }) {
  const agentLoadable = useLastLoadable(signals.agent$);
  const userGrantsLoadable = useLoadable(signals.grants$);
  const agent = agentLoadable.state === "hasData" ? agentLoadable.data : null;
  return (
    <PermissionActionCardForTarget
      signals={signals}
      hasTarget={Boolean(agent)}
      targetLoadableState={agentLoadable.state}
      userGrantsLoadable={userGrantsLoadable}
    />
  );
}

function ChatConnectorActionConnectModal() {
  const active = useGet(activeChatConnectorAction$);
  const close = useSet(closeChatConnectorActionConnectDialog$);
  const runCallback = useSet(runChatActionCallback$);
  const pageSignal = useGet(pageSignal$);

  if (!active) {
    return null;
  }

  return (
    <ConnectModal
      agentId={active.agentId}
      onClose={close}
      onSuccess={async () => {
        if (active.callbackPrompt && active.threadId) {
          await runCallback(
            {
              threadId: active.threadId,
              agentId: active.agentId,
              callbackPrompt: active.callbackPrompt,
            },
            pageSignal,
          );
        }
      }}
    />
  );
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif|tiff?|psd)$/i.test(
    filename,
  );
}

const CREDITS_PER_DOLLAR = 1000;
const CREDIT_TOP_UP_OPTIONS = [100_000, 200_000, 300_000] as const;

function formatCreditsUsd(credits: number): string {
  const dollars = credits / CREDITS_PER_DOLLAR;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
  });
}

function customCreditsFromForm(form: HTMLFormElement | null): number | null {
  const element = form?.elements.namedItem("customUsd");
  if (!(element instanceof HTMLInputElement)) {
    return null;
  }

  const usd = Number(element.value);
  const credits = usd * CREDITS_PER_DOLLAR;
  if (!Number.isInteger(credits) || credits < 1000 || credits > 10_000_000) {
    return null;
  }
  return credits;
}

function CreditsAvailableMessage() {
  return (
    <div className="max-w-md">
      <p className="text-[0.9375rem] font-medium text-emerald-700 dark:text-emerald-300">
        Credits available
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Your credits have been added. You can continue chatting with Zero.
      </p>
    </div>
  );
}

function insufficientCreditsCopy(params: {
  readonly canBuyCredits: boolean;
  readonly roleResolved: boolean;
  readonly canManageBilling: boolean;
}): { readonly headline: string; readonly helper: string } {
  const headline = params.canBuyCredits
    ? "You're out of credits"
    : "Upgrade to Pro to run Zero";
  if (!params.roleResolved) {
    return { headline, helper: "Checking billing permissions..." };
  }
  if (!params.canManageBilling) {
    return {
      headline,
      helper: !params.canBuyCredits
        ? "Ask a workspace admin to upgrade to Pro so you can keep chatting with Zero."
        : "Ask a workspace admin to add credits so you can keep chatting with Zero.",
    };
  }
  return {
    headline,
    helper: !params.canBuyCredits
      ? "Upgrade to Pro to keep chatting with Zero."
      : "Add credits to keep chatting with Zero.",
  };
}

function PaidCreditCheckoutActions({
  redirecting,
  handleCreditClick,
}: {
  readonly redirecting: boolean;
  readonly handleCreditClick: (
    selection: CreditCheckoutSelection,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const handleCustomCreditClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const credits = customCreditsFromForm(event.currentTarget.form);
    if (credits === null) {
      toast.error("Enter between $1 and $10,000");
      return;
    }
    handleCreditClick({ credits, customAmount: true }, event);
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {CREDIT_TOP_UP_OPTIONS.map((credits) => {
          return (
            <button
              key={credits}
              type="button"
              onClick={(event) => {
                handleCreditClick({ credits }, event);
              }}
              disabled={redirecting}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {formatCreditsUsd(credits)}
            </button>
          );
        })}
        <details>
          <summary
            role="button"
            className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent marker:hidden disabled:opacity-60 [&::-webkit-details-marker]:hidden"
          >
            Custom
          </summary>
          <form className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <input
              type="text"
              inputMode="numeric"
              name="customUsd"
              defaultValue="100"
              onInput={(event) => {
                event.currentTarget.value = event.currentTarget.value.replace(
                  /\D/g,
                  "",
                );
              }}
              aria-label="Custom dollar amount"
              className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none transition-colors focus:border-ring"
            />
            <button
              type="button"
              onClick={handleCustomCreditClick}
              disabled={redirecting}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {redirecting ? "Redirecting..." : "Buy"}
            </button>
          </form>
        </details>
      </div>
    </div>
  );
}

function InsufficientCreditsCard() {
  const billingLoadable = useLoadable(billingStatusAsync$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const [creditCheckoutLoadable, creditCheckout] =
    useLoadableSet(startCreditCheckout$);
  const openSettings = useSet(openSettingsDialogAt$);
  const setSubPage = useSet(setBillingSubPage$);
  const pageSignal = useGet(pageSignal$);

  const billingResolved = billingLoadable.state === "hasData";
  const credits = billingResolved ? billingLoadable.data.credits : null;
  const canBuyCredits = billingResolved
    ? orgPlanCapabilitiesFromBilling(billingLoadable.data).canBuyCredits
    : false;
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const roleResolved = isAdminLoadable.state === "hasData";
  const canManageBilling = roleResolved ? isAdminLoadable.data : false;
  const hasAvailableCredits = canBuyCredits && credits !== null && credits > 0;
  const shouldStartProCheckout = !canBuyCredits;
  const canShowBillingAction = billingResolved && canManageBilling;
  const redirecting =
    checkoutLoadable.state === "loading" ||
    creditCheckoutLoadable.state === "loading";

  if (hasAvailableCredits) {
    return <CreditsAvailableMessage />;
  }

  const { headline, helper } = insufficientCreditsCopy({
    canBuyCredits,
    roleResolved: billingResolved && roleResolved,
    canManageBilling: billingResolved && canManageBilling,
  });

  const openBilling = () => {
    setSubPage(false);
    detach(openSettings("billing", pageSignal), Reason.DomCallback);
  };

  const handleUpgradeClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (shouldStartProCheckout) {
      const newTab = event.metaKey || event.ctrlKey;
      detach(
        checkout("pro", newTab, undefined, pageSignal),
        Reason.DomCallback,
      );
      return;
    }
    openBilling();
  };

  const handleCreditClick = (
    selection: CreditCheckoutSelection,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const newTab = event.metaKey || event.ctrlKey;
    detach(creditCheckout(selection, newTab, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-3 max-w-md">
      <p className="text-[0.9375rem] font-medium text-foreground">{headline}</p>
      <p className="mt-1 text-sm text-muted-foreground">{helper}</p>
      {!canShowBillingAction ? null : shouldStartProCheckout ? (
        <button
          type="button"
          onClick={handleUpgradeClick}
          disabled={redirecting}
          className="mt-3 inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {redirecting ? "Redirecting..." : "Upgrade to Pro"}
        </button>
      ) : (
        <PaidCreditCheckoutActions
          redirecting={redirecting}
          handleCreditClick={handleCreditClick}
        />
      )}
    </div>
  );
}

function isBillingRecoveryError(error: string): boolean {
  const normalized = error.trim().toLowerCase();
  return normalized === "insufficient_credits" || normalized === "pro_required";
}

function AssistantErrorContent({ error }: { error: string }) {
  const openSettings = useSet(openSettingsDialogAt$);
  const pageSignal = useGet(pageSignal$);

  if (isBillingRecoveryError(error)) {
    return <InsufficientCreditsCard />;
  }

  if (error.trim().toLowerCase() === "run cancelled") {
    return (
      <div
        className="inline-flex items-center gap-2 bg-muted/50 px-3 py-1.5 text-[0.9375rem] text-muted-foreground"
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
              detach(openSettings("model", pageSignal), Reason.DomCallback);
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
      <Markdown
        source={error}
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    </div>
  );
}

function AssistantBubbleAvatar({ thread }: { thread: ChatThreadSignals }) {
  const agentId = useGet(thread.agentId$) ?? "";
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
// Paged message rendering — renders from visibleRenderedChatGroups$ (flat data,
// no signal-based run loops).
// ---------------------------------------------------------------------------

function PagedGroupRow({
  group,
  thread,
  runGroupFolds,
  completedWorkFold,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
  runGroupFolds?: readonly RunGroupFoldControl[];
  completedWorkFold?: {
    groups: readonly GroupedChatMessageGroup[];
    hiddenGroups: readonly GroupedChatMessageGroup[];
    expanded: boolean;
    onToggle: () => void;
  };
}) {
  if (group.role === "user") {
    return (
      <PagedUserGroup
        group={group}
        thread={thread}
        runGroupFolds={runGroupFolds}
      />
    );
  }
  return (
    <PagedAssistantGroup
      group={group}
      thread={thread}
      runGroupFolds={runGroupFolds}
      completedWorkFold={completedWorkFold}
    />
  );
}

function PagedUserGroup({
  group,
  thread,
  runGroupFolds,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
  runGroupFolds?: readonly RunGroupFoldControl[];
}) {
  return (
    <>
      {group.messages.map((msg) => {
        return <PagedUserMessage key={msg.id} message={msg} thread={thread} />;
      })}
      {runGroupFolds?.map((fold) => {
        return <RunGroupFoldRow key={fold.fold.key} control={fold} />;
      })}
    </>
  );
}

function isWorkflowUserMessage(
  message: EnrichedChatMessage,
): message is EnrichedChatMessage & ChatInputMessage {
  return isInputChatEvent(message) && hasWorkflowMessageMetadata(message);
}

function hasWorkflowMessageMetadata(message: EnrichedChatMessage): boolean {
  return message.workflowSnapshot !== undefined;
}

function workflowSnapshotTitle(
  workflowSnapshot: NonNullable<EnrichedChatMessage["workflowSnapshot"]>,
): string {
  return (
    workflowSnapshot.displayName?.trim() ||
    workflowSnapshot.name.trim() ||
    "Workflow"
  );
}

function workflowMessageBrief(
  workflowSnapshot: NonNullable<EnrichedChatMessage["workflowSnapshot"]>,
): string | null {
  const brief =
    workflowSnapshot.triggerBrief?.trim() ||
    workflowSnapshot.description?.trim() ||
    "";
  return brief.length > 0 ? brief : null;
}

function workflowMessageBody(
  message: EnrichedChatMessage & ChatInputMessage,
): string {
  const workflowSnapshot = message.workflowSnapshot;
  if (!workflowSnapshot) {
    return message.content?.trim() || "Workflow";
  }
  return (
    workflowMessageBrief(workflowSnapshot) ??
    workflowSnapshotTitle(workflowSnapshot)
  );
}

interface ResolvedMessageAttachment {
  readonly id: string | null;
  readonly filename: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly assetRef?: NonNullable<ResolvedAttachFile["assetRef"]>;
  readonly isImage: boolean;
  readonly kind: ReturnType<typeof classifyChatAttachment>;
  readonly text$?: TextPreviewComputed;
}

function resolveAttachments(
  message: EnrichedChatMessage,
  parsed: { filename: string; url: string }[],
  artifactSignalsForUrl: ChatThreadSignals["artifactSignalsForUrl"],
): ResolvedMessageAttachment[] {
  const eventAttachments = chatEventAttachments(message);
  const source =
    eventAttachments && eventAttachments.length > 0 ? eventAttachments : parsed;
  return source.map((f) => {
    const resolvedFile = "id" in f ? (f as ResolvedAttachFile) : undefined;
    const contentType =
      "contentType" in f && typeof f.contentType === "string"
        ? f.contentType
        : undefined;
    const kind = classifyChatAttachment({
      filename: f.filename,
      url: f.url,
      contentType,
    });
    const text$ = isTextPreviewKind(kind)
      ? artifactSignalsForUrl(f.url)?.text$
      : undefined;
    return {
      id: "id" in f && typeof f.id === "string" ? f.id : null,
      filename: f.filename,
      url: f.url,
      contentType,
      ...(resolvedFile?.assetRef ? { assetRef: resolvedFile.assetRef } : {}),
      isImage: kind === "image" || isImageFilename(f.filename),
      kind,
      ...(text$ ? { text$ } : {}),
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

function clipboardAttachmentsFromMessage(
  message: ChatMessage,
  parsed: { filename: string; url: string }[],
): ChatClipboardAttachment[] {
  const eventAttachments = chatEventAttachments(message);
  const source =
    eventAttachments && eventAttachments.length > 0 ? eventAttachments : parsed;
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
      contentType: contentType ?? contentTypeForBodyPreviewKind(kind),
      size: "size" in f && typeof f.size === "number" ? f.size : 0,
    };
  });
}

function clipboardAttachmentsFromStructuredPrompt(
  document: UserMessageDocument,
  attachments: readonly ChatClipboardAttachment[],
): ChatClipboardAttachment[] {
  const attachmentById = new Map(
    attachments.flatMap((attachment) => {
      return attachment.id ? [[attachment.id, attachment] as const] : [];
    }),
  );
  return document.parts.flatMap((part) => {
    if (part.type !== "file") {
      return [];
    }
    const attachment = attachmentById.get(part.fileId);
    return attachment ? [attachment] : [];
  });
}

function AttachmentMaterializationState({
  attachment,
}: {
  attachment: ReturnType<typeof resolveAttachments>[number];
}) {
  const materialization = attachment.assetRef?.materialization;
  if (!materialization || materialization.status === "ready") {
    return null;
  }
  const pending = materialization.status === "pending";
  const error =
    materialization.status === "failed" ? materialization.error : undefined;
  return (
    <div
      className="flex max-w-72 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
      role={pending ? "status" : "alert"}
      title={error?.message}
    >
      {pending ? (
        <IconLoader2
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin text-muted-foreground"
        />
      ) : (
        <IconAlertCircle
          aria-hidden="true"
          className="size-4 shrink-0 text-destructive"
        />
      )}
      <span className="min-w-0">
        <span className="block truncate font-medium">
          {attachment.filename}
        </span>
        <span className="block text-xs text-muted-foreground">
          {pending ? "Importing attachment" : "Attachment unavailable"}
        </span>
      </span>
    </div>
  );
}

function UserMessageAttachments({
  attachments,
  onImageClick,
  align = "end",
}: {
  attachments: ReturnType<typeof resolveAttachments>;
  onImageClick: (url: string) => void;
  align?: "start" | "end";
}) {
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex max-w-[85%] flex-wrap gap-2",
        align === "start" ? "mt-2 justify-start" : "mb-2 justify-end self-end",
      )}
    >
      {attachments.map((a) => {
        if (a.assetRef && a.assetRef.materialization.status !== "ready") {
          return (
            <AttachmentMaterializationState
              key={a.id ?? a.url}
              attachment={a}
            />
          );
        }
        if (a.isImage) {
          return (
            <ChatImagePreviewLink
              key={a.url}
              alt={a.filename}
              ariaLabel={`Preview ${a.filename}`}
              imageClassName="block h-full w-full object-contain"
              linkClassName={CHAT_INLINE_IMAGE_PREVIEW_CLASS}
              onPreview={() => {
                onImageClick(a.url);
              }}
              placeholderClassName="h-full w-full"
              url={a.url}
            />
          );
        }
        if (a.kind === "video") {
          return (
            <ChatVideoPreviewButton
              key={a.url}
              ariaLabel={`Preview ${a.filename}`}
              buttonClassName={CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS}
              filename={a.filename}
              onPreview={() => {
                openVideoLightbox({
                  url: a.url,
                  filename: a.filename,
                });
              }}
              posterClassName="h-full w-full"
              url={a.url}
              videoClassName="h-full w-full object-contain"
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
              text$={a.text$}
            />
          );
        }
        if (a.kind === "audio") {
          return (
            <PreviewableAudioAttachmentChip
              key={a.url}
              filename={a.filename}
              url={a.url}
              contentType={a.contentType}
            />
          );
        }
        return (
          <FileAttachmentChip
            key={a.url}
            filename={a.filename}
            url={a.url}
            contentType={a.contentType}
          />
        );
      })}
    </div>
  );
}

function UserMessageActions({
  canCopy,
  copied,
  onCopy,
}: {
  canCopy: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!canCopy) {
    return null;
  }
  return (
    <div className="flex justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
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
    </div>
  );
}

function formatSelectionIdLabel(selectionId: string): string {
  const label = selectionId
    .replace(/^template:/, "")
    .replace(/^video-template:/, "")
    .replace(/^workflow-template:/, "")
    .replace(/^html-ppt-/, "")
    .replace(/-/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function generationTemplateLabel(
  value: GenerationTemplateRequest | undefined,
): string | null {
  if (!value) {
    return null;
  }
  if (value.type === "video") {
    const item = findVideoTemplateItem(value.selection.stylePresetId);
    return item?.title ?? formatSelectionIdLabel(value.selection.stylePresetId);
  }
  if (value.type === "workflow") {
    const item = findWorkflowTemplateItem(value.selection.workflowTemplateId);
    return (
      item?.title ?? formatSelectionIdLabel(value.selection.workflowTemplateId)
    );
  }
  if (value.type === "illustration") {
    const item = ILLUSTRATION_TEMPLATE_ITEMS.find((candidate) => {
      return (
        candidate.illustrationStyleId === value.selection.illustrationStyleId
      );
    });
    return (
      item?.title ?? formatSelectionIdLabel(value.selection.illustrationStyleId)
    );
  }
  if (value.type === "website") {
    const item = findWebsiteTemplateItem(value.selection.websiteTemplateId);
    return (
      item?.title ?? formatSelectionIdLabel(value.selection.websiteTemplateId)
    );
  }
  const item = PRESENTATION_TEMPLATE_PICKER_ITEMS.find((candidate) => {
    return candidate.templateId === value.selection.templateId;
  });
  return item?.title ?? formatSelectionIdLabel(value.selection.templateId);
}

function generationTemplateTypeLabel(
  value: GenerationTemplateRequest | undefined,
): string | null {
  if (!value) {
    return null;
  }
  if (value.type === "video") {
    return "Video";
  }
  if (value.type === "illustration") {
    return "Illustration";
  }
  if (value.type === "workflow") {
    return "Workflow";
  }
  if (value.type === "website") {
    return "Website";
  }
  return "Presentation";
}

function UserMessageGenerationTemplate({
  generationTemplate,
}: {
  generationTemplate: GenerationTemplateRequest | undefined;
}) {
  const label = generationTemplateLabel(generationTemplate);
  const typeLabel = generationTemplateTypeLabel(generationTemplate);
  if (!label || !typeLabel) {
    return null;
  }
  const className =
    "mb-1.5 flex max-w-[85%] items-center gap-1.5 self-end text-xs font-medium text-muted-foreground";
  const content = (
    <>
      {generationTemplate?.type === "video" ? (
        <IconVideo size={15} stroke={1.8} className="shrink-0" />
      ) : generationTemplate?.type === "illustration" ? (
        <IconPhoto size={15} stroke={1.8} className="shrink-0" />
      ) : generationTemplate?.type === "workflow" ? (
        <IconRoute size={15} stroke={1.8} className="shrink-0" />
      ) : generationTemplate?.type === "website" ? (
        <IconWorld size={15} stroke={1.8} className="shrink-0" />
      ) : (
        <IconPresentation size={15} stroke={1.8} className="shrink-0" />
      )}
      <span className="shrink-0">{typeLabel}</span>
      <span className="shrink-0">·</span>
      <span className="min-w-0 truncate">{label}</span>
    </>
  );
  return (
    <div
      aria-label={`Message template ${label}`}
      className={className}
      title={`${typeLabel} · ${label}`}
    >
      {content}
    </div>
  );
}

function SlackUserMessageOrigin({
  permalink,
}: {
  permalink: string | undefined;
}) {
  if (!permalink) {
    return null;
  }
  return (
    <a
      href={permalink}
      target="_blank"
      rel="noreferrer"
      aria-label="Open original message in Slack"
      className="mb-1.5 inline-flex h-7 max-w-[85%] items-center gap-1.5 self-end rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
    >
      <IconBrandSlack size={15} stroke={1.8} className="shrink-0" />
      <span className="shrink-0">Slack</span>
      <span className="shrink-0">·</span>
      <span className="min-w-0 truncate">Open message</span>
      <IconArrowUpRight size={12} stroke={1.5} className="shrink-0" />
    </a>
  );
}

const feishuIconImg = settingsIconAssetUrl("lark");

function FeishuUserMessageOrigin({
  chatOpenUrl,
}: {
  chatOpenUrl: string | undefined;
}) {
  if (!chatOpenUrl) {
    return null;
  }
  return (
    <a
      href={chatOpenUrl}
      target="_blank"
      rel="noreferrer"
      aria-label="Open original chat in Feishu"
      className="mb-1.5 inline-flex h-7 max-w-[85%] items-center gap-1.5 self-end rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
    >
      <img
        src={feishuIconImg}
        alt=""
        className="size-[15px] shrink-0 object-contain"
      />
      <span className="shrink-0">Feishu</span>
      <span className="shrink-0">·</span>
      <span className="min-w-0 truncate">Open chat</span>
      <IconArrowUpRight size={12} stroke={1.5} className="shrink-0" />
    </a>
  );
}

const STRUCTURED_REFERENCE_CHIP_CLASS =
  "inline-flex max-w-[240px] items-center gap-1 rounded-md border " +
  "border-foreground/15 bg-background/80 px-1.5 py-0.5 align-middle " +
  "text-xs font-medium";

function StructuredTemplateIcon({
  type,
}: {
  type: GenerationTemplateRequest["type"];
}) {
  if (type === "video") {
    return <IconVideo size={15} stroke={1.8} className="shrink-0" />;
  }
  if (type === "illustration") {
    return <IconPhoto size={15} stroke={1.8} className="shrink-0" />;
  }
  if (type === "workflow") {
    return <IconRoute size={15} stroke={1.8} className="shrink-0" />;
  }
  if (type === "website") {
    return <IconWorld size={15} stroke={1.8} className="shrink-0" />;
  }
  return <IconPresentation size={15} stroke={1.8} className="shrink-0" />;
}

function StructuredTemplateReference({
  part,
}: {
  part: Extract<UserMessagePart, { type: "template" }>;
}) {
  const typeLabel = generationTemplateTypeLabel(part.template);
  return (
    <span
      aria-label={`Message template ${part.titleSnapshot}`}
      className="inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-muted-foreground"
      title={`${typeLabel ?? part.template.type} · ${part.titleSnapshot}`}
    >
      <StructuredTemplateIcon type={part.template.type} />
      <span className="shrink-0">{typeLabel ?? part.template.type}</span>
      <span className="shrink-0">·</span>
      <span className="min-w-0 truncate">{part.titleSnapshot}</span>
    </span>
  );
}

function StructuredFileReference({
  part,
  attachment,
}: {
  part: Extract<UserMessagePart, { type: "file" }>;
  attachment: ResolvedAttachFile | undefined;
}) {
  if (attachment) {
    return (
      <span className="inline-flex align-middle">
        <FileAttachmentChip
          contentType={part.contentType}
          filename={part.filenameSnapshot}
          url={attachment.url}
        />
      </span>
    );
  }
  return (
    <span
      aria-label={`File ${part.filenameSnapshot}`}
      className={`${STRUCTURED_REFERENCE_CHIP_CLASS} h-7`}
      title={part.filenameSnapshot}
    >
      <FilePreviewIcon
        filename={part.filenameSnapshot}
        contentType={part.contentType}
        size="sm"
        className="shrink-0"
        testId="structured-message-file-icon"
      />
      <span className="min-w-0 truncate">{part.filenameSnapshot}</span>
    </span>
  );
}

function StructuredChatThreadReference({
  threadId,
  title,
}: {
  threadId: string;
  title: string;
}) {
  return (
    <Link
      pathname={ROUTES.chat}
      options={{ pathParams: { threadId } }}
      aria-label={`Open chat ${title}`}
      className={`${STRUCTURED_REFERENCE_CHIP_CLASS} text-primary transition-colors hover:bg-foreground/10`}
      title={title}
    >
      <IconMessageCircle size={14} stroke={1.8} className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  );
}

function StructuredFeedbackNote({
  note,
}: {
  note: readonly FeedbackNotePart[];
}) {
  const partOccurrences = new Map<string, number>();
  return (
    <div>
      {note.map((part) => {
        const identity = JSON.stringify(part);
        const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
        partOccurrences.set(identity, occurrence);
        const key = `${identity}:${String(occurrence)}`;
        if (part.type === "chat_thread") {
          return (
            <StructuredChatThreadReference
              key={key}
              threadId={part.threadId}
              title={part.titleSnapshot}
            />
          );
        }
        return <span key={key}>{part.text}</span>;
      })}
    </div>
  );
}

type StructuredFeedbackPart = Extract<UserMessagePart, { type: "feedback" }>;

function equalFeedbackSources(
  left: StructuredFeedbackPart["source"],
  right: StructuredFeedbackPart["source"],
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.type === right.type &&
    left.id === right.id &&
    left.status === right.status &&
    left.sentId === right.sentId
  );
}

function structuredFeedbackHeading(
  parts: readonly StructuredFeedbackPart[],
): string {
  const source = parts[0]?.source;
  if (!source) {
    return parts.length === 1
      ? "Feedback on this part of your reply:"
      : `Feedback on ${parts.length} parts of your reply:`;
  }
  const description =
    source.status === "draft"
      ? `an email draft (mail draft ID: ${source.id})`
      : `a sent email (mail ID: ${source.id}${source.sentId ? `, sent ID: ${source.sentId}` : ""})`;
  return parts.length === 1
    ? `Feedback on this part of ${description}:`
    : `Feedback on ${parts.length} parts of ${description}:`;
}

function StructuredFeedbackGroup({
  parts,
}: {
  parts: readonly StructuredFeedbackPart[];
}) {
  const partOccurrences = new Map<string, number>();
  let firstPart = true;
  return (
    <div data-structured-feedback-group="" className="space-y-3">
      <div>{structuredFeedbackHeading(parts)}</div>
      {parts.map((part) => {
        const identity = JSON.stringify(part);
        const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
        partOccurrences.set(identity, occurrence);
        const showDivider = !firstPart;
        firstPart = false;
        return (
          <div key={`${identity}:${String(occurrence)}`} className="space-y-3">
            {showDivider ? (
              <div
                data-structured-feedback-divider=""
                className="border-t border-border"
              />
            ) : null}
            <blockquote
              data-structured-feedback-quote=""
              className="border-l-2 border-border pl-3 text-muted-foreground"
            >
              {part.quote}
            </blockquote>
            <StructuredFeedbackNote note={part.note} />
          </div>
        );
      })}
    </div>
  );
}

type StructuredStandalonePart = Exclude<UserMessagePart, { type: "feedback" }>;

function StructuredUserMessagePart({
  part,
  attachments,
}: {
  part: StructuredStandalonePart;
  attachments: readonly ResolvedAttachFile[];
}): ReactNode {
  if (part.type === "text") {
    return <span>{part.text}</span>;
  }
  if (part.type === "chat_thread") {
    return (
      <StructuredChatThreadReference
        threadId={part.threadId}
        title={part.titleSnapshot}
      />
    );
  }
  if (part.type === "template") {
    return <StructuredTemplateReference part={part} />;
  }
  if (part.type === "file") {
    const attachment = attachments.find((candidate) => {
      return candidate.id === part.fileId;
    });
    return <StructuredFileReference part={part} attachment={attachment} />;
  }
  void (part satisfies never);
  return null;
}

function StructuredUserMessage({
  document,
  attachments,
  elevatedFileIds,
}: {
  document: UserMessageDocument;
  attachments: readonly ResolvedAttachFile[];
  elevatedFileIds: ReadonlySet<string>;
}) {
  const partOccurrences = new Map<string, number>();
  const bodyParts = document.parts.filter((part) => {
    return !isElevatedStructuredPart(part, elevatedFileIds);
  });
  if (bodyParts.length === 0) {
    return null;
  }
  const renderedParts: ReactNode[] = [];
  let index = 0;
  while (index < bodyParts.length) {
    const part = bodyParts[index];
    if (!part) {
      break;
    }
    if (part.type === "feedback") {
      const feedbackParts: StructuredFeedbackPart[] = [part];
      let nextIndex = index + 1;
      while (nextIndex < bodyParts.length) {
        const candidate = bodyParts[nextIndex];
        if (
          candidate?.type !== "feedback" ||
          !equalFeedbackSources(part.source, candidate.source)
        ) {
          break;
        }
        feedbackParts.push(candidate);
        nextIndex += 1;
      }
      renderedParts.push(
        <StructuredFeedbackGroup
          key={`feedback:${String(index)}`}
          parts={feedbackParts}
        />,
      );
      index = nextIndex;
      continue;
    }
    const identity = JSON.stringify(part);
    const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
    partOccurrences.set(identity, occurrence);
    renderedParts.push(
      <StructuredUserMessagePart
        key={`${identity}:${String(occurrence)}`}
        part={part}
        attachments={attachments}
      />,
    );
    index += 1;
  }
  return (
    <div data-structured-user-message="" className="whitespace-pre-wrap">
      {renderedParts}
    </div>
  );
}

function isElevatedStructuredPart(
  part: UserMessagePart,
  elevatedFileIds: ReadonlySet<string>,
): boolean {
  return (
    part.type === "template" ||
    (part.type === "file" && elevatedFileIds.has(part.fileId))
  );
}

function StructuredUserMessageContent({
  document,
  attachments,
  referenceAttachments,
  onImageClick,
}: {
  document: UserMessageDocument;
  attachments: ReturnType<typeof resolveAttachments>;
  referenceAttachments: readonly ResolvedAttachFile[];
  onImageClick: (url: string) => void;
}) {
  const imageAttachments = attachments.filter((attachment) => {
    return attachment.id !== null && attachment.isImage;
  });
  const imageAttachmentIds = new Set(
    imageAttachments.flatMap((attachment) => {
      return attachment.id ? [attachment.id] : [];
    }),
  );
  const templateParts = document.parts.filter((part) => {
    return part.type === "template";
  });
  const hasBody = document.parts.some((part) => {
    return !isElevatedStructuredPart(part, imageAttachmentIds);
  });

  return (
    <>
      {templateParts.length > 0 ? (
        <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {templateParts.map((part) => {
            return (
              <StructuredTemplateReference
                key={`${part.template.type}:${part.titleSnapshot}`}
                part={part}
              />
            );
          })}
        </div>
      ) : null}
      <UserMessageAttachments
        attachments={imageAttachments}
        onImageClick={onImageClick}
      />
      {hasBody ? (
        <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden">
          <div className="px-4 py-3">
            <StructuredUserMessage
              document={document}
              attachments={referenceAttachments}
              elevatedFileIds={imageAttachmentIds}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function WorkflowUserMessage({
  message,
}: {
  message: EnrichedChatMessage & ChatInputMessage;
}) {
  const workflowSnapshot = message.workflowSnapshot;
  if (!workflowSnapshot) {
    return null;
  }
  const workflowTitle = workflowSnapshotTitle(workflowSnapshot);
  const workflowBody = workflowMessageBody(message);
  const bubbleClassName =
    "zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden whitespace-pre-wrap transition-colors duration-150";
  const body = (
    <div className={bubbleClassName}>
      <div className="px-4 py-3">{workflowBody}</div>
    </div>
  );
  const workflowId = workflowSnapshot.id;
  const linked = workflowId !== undefined;

  return (
    <div data-role="user" className="group">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex w-full flex-col items-end">
          <div
            aria-label={`Workflow ${workflowTitle}`}
            className="mb-1.5 flex max-w-[85%] items-center gap-1.5 self-end text-xs font-medium text-muted-foreground"
            title={workflowTitle}
          >
            <IconRoute size={15} stroke={1.8} className="shrink-0" />
            <span className="min-w-0 truncate">{workflowTitle}</span>
          </div>
          {linked ? (
            <Link
              pathname={ROUTES.workflowDetailAutomations}
              options={{
                pathParams: {
                  workflowId,
                },
              }}
              className="contents"
              aria-label={`Open workflow ${workflowSnapshotTitle(
                workflowSnapshot,
              )}`}
            >
              {body}
            </Link>
          ) : (
            body
          )}
        </div>
      </div>
    </div>
  );
}

function GoalUserMessage({
  message,
  bodyBlocks,
  openLightbox,
}: {
  message: EnrichedChatMessage & ChatInputMessage;
  bodyBlocks: BodyRenderBlock[];
  openLightbox: (url: string) => void;
}) {
  const objectiveBrief = message.goalSnapshot?.objectiveBrief?.trim();
  return (
    <div data-role="user" className="group">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex w-full flex-col items-end">
          <div
            aria-label="Goal"
            className="mb-1.5 flex max-w-[85%] items-center gap-1.5 self-end text-xs font-medium text-muted-foreground"
          >
            <IconTarget size={15} stroke={1.8} className="shrink-0" />
            <span>Goal</span>
          </div>
          {objectiveBrief ? (
            <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden ring-1 ring-emerald-900/10">
              <div className="px-4 py-3 whitespace-pre-wrap">
                {objectiveBrief}
              </div>
            </div>
          ) : bodyBlocks.length > 0 ? (
            <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden ring-1 ring-emerald-900/10">
              <div className="px-4 py-3">
                <BodyContentBlocks
                  blocks={bodyBlocks}
                  openLightbox={openLightbox}
                  hardBreaks
                  escapeMarkdownHtml
                  markdownMediaPreview={false}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
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
  const featureSwitches = useGet(featureSwitch$);
  const structuredPromptEnabled =
    featureSwitches[FeatureSwitchKey.StructuredPrompt] ?? false;
  const inputMessage = asInputChatEvent(message);
  const structuredPrompt = visibleStructuredPrompt(
    inputMessage,
    structuredPromptEnabled,
  );
  const content = message.content ?? "";
  // Two attachment sources coexist: the structured `attachFiles` field
  // (current flow) and legacy `[Attached file: ...](url)` inline lines left
  // over from messages sent before #10243 split the flows. Use the structured
  // source when it's present and fall back to inline parsing otherwise.
  const { cleanContent, parsed } = parseInlineAttachments(content);
  const attachFiles = inputMessage?.attachFiles;
  const legacyCopyText =
    attachFiles &&
    attachFiles.length > 0 &&
    cleanContent.trim() === ATTACH_ONLY_PLACEHOLDER
      ? ""
      : cleanContent;
  const copyText = structuredPrompt
    ? (messageDocumentToPrompt(structuredPrompt) ?? "")
    : legacyCopyText;
  const bodyBlocks = message.blocks;
  const pageSignal = useGet(pageSignal$);
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = openImageLightbox;
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === message.id;
  const copyMessage = useSet(thread.copyMessage$);
  const findArtifact = thread.artifactSignalsForUrl;
  const allAttachments = resolveAttachments(message, parsed, findArtifact);
  const legacyClipboardAttachments = clipboardAttachmentsFromMessage(
    message,
    parsed,
  );
  const clipboardAttachments = structuredPrompt
    ? clipboardAttachmentsFromStructuredPrompt(
        structuredPrompt,
        legacyClipboardAttachments,
      )
    : legacyClipboardAttachments;
  const canCopy =
    structuredPrompt !== undefined ||
    copyText.trim().length > 0 ||
    clipboardAttachments.length > 0;

  const handleCopy = () => {
    if (!canCopy) {
      return;
    }
    detach(
      copyMessage(
        message.id,
        {
          text: copyText,
          attachments: clipboardAttachments,
          ...(structuredPrompt ? { structuredPrompt } : {}),
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  if (isWorkflowUserMessage(message)) {
    return <WorkflowUserMessage message={message} />;
  }

  if (isGoalUserMessage(message)) {
    return (
      <GoalUserMessage
        message={message}
        bodyBlocks={bodyBlocks}
        openLightbox={openLightbox}
      />
    );
  }

  return (
    <div data-role="user" className="group">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          <SlackUserMessageOrigin permalink={message.slackMessagePermalink} />
          <FeishuUserMessageOrigin chatOpenUrl={message.feishuChatOpenUrl} />
          {structuredPrompt ? (
            <StructuredUserMessageContent
              document={structuredPrompt}
              attachments={allAttachments}
              referenceAttachments={attachFiles ?? []}
              onImageClick={openLightbox}
            />
          ) : (
            <>
              <UserMessageGenerationTemplate
                generationTemplate={inputMessage?.generationTemplate}
              />
              <UserMessageAttachments
                attachments={allAttachments}
                onImageClick={openLightbox}
              />
              {bodyBlocks.length > 0 && (
                <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden">
                  <div className="px-4 py-3">
                    <BodyContentBlocks
                      blocks={bodyBlocks}
                      openLightbox={openLightbox}
                      hardBreaks
                      escapeMarkdownHtml
                      markdownMediaPreview={false}
                    />
                  </div>
                </div>
              )}
            </>
          )}
          <UserMessageActions
            canCopy={canCopy}
            copied={copied}
            onCopy={handleCopy}
          />
        </div>
      </div>
    </div>
  );
}

function PagedAssistantGroup({
  group,
  thread,
  runGroupFolds,
  completedWorkFold,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
  runGroupFolds?: readonly RunGroupFoldControl[];
  completedWorkFold?: {
    groups: readonly GroupedChatMessageGroup[];
    hiddenGroups: readonly GroupedChatMessageGroup[];
    expanded: boolean;
    onToggle: () => void;
  };
}) {
  const hasRenderableMessage = group.messages.some((message) => {
    return isRenderableAssistantMessage(message);
  });
  const hasRunGroupFolds = (runGroupFolds?.length ?? 0) > 0;
  const showCompletedWorkFold = completedWorkFold && !hasRunGroupFolds;
  if (!hasRenderableMessage && !completedWorkFold && !hasRunGroupFolds) {
    return null;
  }

  const groupElementId = `chat-message-group-${group.beginMessageId}`;
  const fullContent = group.messages
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");
  let renderedAssistantMessageCount = 0;
  const renderAssistantMessageItem = (message: EnrichedChatMessage) => {
    const isRenderable = isRenderableAssistantMessage(message);
    const compactTop = isRenderable && renderedAssistantMessageCount > 0;
    if (isRenderable) {
      renderedAssistantMessageCount += 1;
    }
    return (
      <PagedAssistantMessageItem
        key={message.id}
        message={message}
        compactTop={compactTop}
        thread={thread}
      />
    );
  };

  return (
    <div
      id={groupElementId}
      data-role="assistant"
      className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="relative flex flex-col gap-2">
          {runGroupFolds?.map((fold) => {
            return (
              <RunGroupFoldRow key={fold.fold.key} control={fold} embedded />
            );
          })}
          {showCompletedWorkFold && (
            <CompletedWorkFoldRow
              groups={completedWorkFold.groups}
              expanded={completedWorkFold.expanded}
              onToggle={completedWorkFold.onToggle}
            />
          )}
          {showCompletedWorkFold && completedWorkFold.expanded
            ? completedWorkFold.hiddenGroups.map((hiddenGroup) => {
                return (
                  <div key={hiddenGroup.beginMessageId} className="contents">
                    {hiddenGroup.messages.map((msg) => {
                      return renderAssistantMessageItem(msg);
                    })}
                  </div>
                );
              })
            : null}
          {group.messages.map((msg) => {
            return renderAssistantMessageItem(msg);
          })}
        </div>
      </div>
      <PagedGroupActions group={group} content={fullContent} thread={thread} />
    </div>
  );
}

function PagedAssistantMessageItem({
  message,
  compactTop = false,
  thread,
}: {
  message: EnrichedChatMessage;
  compactTop?: boolean;
  thread: ChatThreadSignals;
}) {
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = (url: string) => {
    openImageLightbox(url);
  };
  const attachments = resolveAttachments(
    message,
    [],
    thread.artifactSignalsForUrl,
  );

  const error = chatEventError(message);
  if (error) {
    return (
      <div
        className={cn(
          "zero-chat-bubble-assistant px-0 text-[0.9375rem] leading-[1.7] min-w-0 [overflow-wrap:anywhere]",
          compactTop ? "@[900px]:pt-0" : "@[900px]:pt-2.5",
        )}
      >
        <AssistantErrorContent error={error} />
      </div>
    );
  }

  if (message.content || message.blocks.length > 0 || attachments.length > 0) {
    const { blocks } = message;
    return (
      <div
        className={cn(
          "zero-chat-bubble-assistant px-0 text-[0.9375rem] leading-[1.7] min-w-0 [overflow-wrap:anywhere]",
          compactTop ? "@[900px]:pt-0" : "@[900px]:pt-2.5",
        )}
      >
        {blocks.length > 0 ? (
          <BodyContentBlocks
            blocks={blocks}
            openLightbox={openLightbox}
            hardBreaks={false}
          />
        ) : null}
        <UserMessageAttachments
          attachments={attachments}
          onImageClick={openLightbox}
          align="start"
        />
      </div>
    );
  }

  return null;
}

function formatCredits(value: number): string {
  return value.toLocaleString("en-US");
}

interface RunUsageDisplayRow {
  readonly key: string;
  readonly label: string;
  readonly credits: number;
}

function isUsageModelBackedKind(kind: string): boolean {
  return kind === "model" || kind === "image" || kind === "video";
}

function isUsageCategoryPart(part: string): boolean {
  return part.startsWith("tokens.") || part.startsWith("output_");
}

function parseUsageKind(kind: string): {
  readonly kind: string;
  readonly provider?: string;
} {
  const parts = kind.split("/");
  const parsedKind = parts[0];
  if (isUsageModelBackedKind(parsedKind) && parts.length >= 2) {
    const categoryIndex = parts.findIndex((part, index) => {
      return index > 1 && isUsageCategoryPart(part);
    });
    const providerParts =
      categoryIndex > 1 ? parts.slice(1, categoryIndex) : parts.slice(1);
    const provider = providerParts.join("/");
    if (provider) {
      return { kind: parsedKind, provider };
    }
  }

  return { kind };
}

function buildRunUsageDisplayRows(
  usage: ChatMessageUsagePayload,
): readonly RunUsageDisplayRow[] {
  const rows = new Map<string, RunUsageDisplayRow>();

  for (const kindBreakdown of usage.breakdown) {
    const parsed = parseUsageKind(kindBreakdown.kind);
    for (const providerBreakdown of kindBreakdown.providers) {
      const provider = parsed.provider ?? providerBreakdown.provider;
      const key = `${parsed.kind}:${provider}`;
      const existing = rows.get(key);
      const credits = Math.max(0, providerBreakdown.credits);
      rows.set(key, {
        key,
        label:
          existing?.label ?? getCreditUsageDisplayName(parsed.kind, provider),
        credits: (existing?.credits ?? 0) + credits,
      });
    }
  }

  return Array.from(rows.values());
}

function UsageChip({
  usage,
  title,
  ariaLabel,
  contentAlign = "start",
  open,
  setOpen,
}: {
  usage: ChatMessageUsagePayload;
  title: string;
  ariaLabel: string;
  contentAlign?: "start" | "center" | "end";
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const total = formatCredits(usage.totalCredits);
  const displayRows = buildRunUsageDisplayRows(usage);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground/70 hover:bg-accent hover:text-foreground transition-colors duration-150"
          aria-label={`${ariaLabel} ${total}`}
        >
          <IconCoins size={17} stroke={1.5} />
          <span>{total}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align={contentAlign} className="w-72 p-3">
        <div className="flex items-center justify-between gap-3 text-sm font-medium">
          <span>{title}</span>
          <span>{total}</span>
        </div>
        <div className="mt-3 flex flex-col gap-1.5">
          {displayRows.map((row) => {
            return (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="min-w-0 truncate text-muted-foreground">
                  {row.label}
                </span>
                <span className="shrink-0 text-foreground">
                  {formatCredits(row.credits)}
                </span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function RunUsageChip({
  runId,
  usage,
}: {
  runId: string;
  usage: ChatMessageUsagePayload;
}) {
  const openRunId = useGet(runUsagePopoverOpenRunId$);
  const setOpenRunId = useSet(setRunUsagePopoverOpenRunId$);

  return (
    <UsageChip
      usage={usage}
      title="Credit usage"
      ariaLabel="Credit usage"
      open={openRunId === runId}
      setOpen={(open) => {
        setOpenRunId(open ? runId : null);
      }}
    />
  );
}

function PagedGroupPrimaryActions({
  firstRunId,
  hasContent,
  usage,
  copied,
  onCopy,
}: {
  firstRunId: string | undefined;
  hasContent: boolean;
  usage: ChatMessageUsagePayload | undefined;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-1" data-testid="chat-message-actions">
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
      {usage && firstRunId && <RunUsageChip runId={firstRunId} usage={usage} />}
    </div>
  );
}

function PagedGroupActions({
  group,
  content,
  thread,
}: {
  group: GroupedChatMessageGroup;
  content: string;
  thread: ChatThreadSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === group.beginMessageId;
  const copyMessage = useSet(thread.copyMessage$);

  const firstRunId = group.messages.find((m) => {
    return m.runId;
  })?.runId;
  const usage = group.usage;
  const hasContent = content.length > 0;

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

  return (
    <div className="@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]">
      <div className="hidden @[900px]:block" />
      <div className="flex items-center justify-between pt-2 pb-1 gap-2 -ml-1">
        <PagedGroupPrimaryActions
          firstRunId={firstRunId}
          hasContent={hasContent}
          usage={usage}
          copied={copied}
          onCopy={handleCopy}
        />
      </div>
    </div>
  );
}
