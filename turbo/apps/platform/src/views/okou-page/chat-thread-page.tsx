import type {
  CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  UIEvent as ReactUIEvent,
} from "react";
import {
  useGet,
  useLoadable,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import type { TFunction } from "i18next";
import { equalArrays } from "../../lib/equality.ts";
import { useTranslation } from "react-i18next";
import { formatChatTimestamp } from "../../i18n/format.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { hideAppSkeletonOnContentReadyRef$ } from "../../signals/app-skeleton.ts";
import {
  runUsagePopoverOpenRunId$,
  setRunUsagePopoverOpenRunId$,
} from "../../signals/chat-page/run-usage-popover.ts";
import {
  AlertCircle,
  Coffee,
  Flag,
  Hand,
  Heart,
  Leaf,
  Lightbulb,
  Plane,
  Smile,
  Trophy,
  Image,
  ChartLine,
  Globe,
  Video,
  Copy,
  Check,
  SwatchBook,
  ArrowDown,
  ArrowUpRight,
  ChevronRight,
  Link as LinkIcon,
  Coins,
  Loader2,
  Play,
  MessageCircle,
  Mic,
  SmilePlus,
  Package,
  Route,
  Search,
  Target,
  X,
  Clock,
  Hourglass,
  Share2,
  type LucideIcon,
} from "lucide-react";
import {
  cn,
  getShortcutLabel,
  getShortcutParts,
  Button,
  Checkbox,
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
  BrandSlack,
  ElapsedTime,
} from "@okouai/ui";
import { RUN_ERROR_GUIDANCE } from "@okouai/api-contracts/contracts/errors";
import type {
  ChatEventUsagePayload,
  ChatRecommendedFollowup,
  GenerationTemplateRequest,
  UserMessageDocument,
  UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import { isChatEventContentTextType } from "@okouai/api-contracts/contracts/chat-events";
import {
  messageDocumentToDisplayText,
  messageDocumentToPrompt,
} from "../../signals/okou-page/user-message-document-codec.ts";
import { avatarTemplateSelection } from "../../signals/okou-page/avatar-template-selection.ts";
import type {
  ChatThreadWorkflowAutomation,
  WorkflowSchedule,
} from "@okouai/api-contracts/contracts/workflows";
import { getModelDisplayName } from "@okouai/core/model-display-name";
import { emptyChatImg, thinkingSpinnerImg } from "./platform-assets.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import { Markdown, MarkdownEventBody } from "../components/markdown.tsx";
import { hasChatEventBodyContent } from "../../signals/chat-page/chat-event-body-blocks.ts";
import { i18n } from "../../i18n/index.ts";
import { runChatActionCallback$ } from "../../signals/chat-page/action-callback.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  CHAT_INLINE_IMAGE_PREVIEW_CLASS,
  CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS,
  ChatImagePreviewLink,
  ChatVideoPreviewButton,
} from "./chat-body-cards.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatConversationLocator } from "./chat-conversation-locator.tsx";
import {
  customConnectorMcpEnabled$,
  featureSwitch$,
} from "../../signals/external/feature-switch.ts";
import { isStandalonePwa } from "../../lib/keyboard-dismiss-gesture.ts";
import {
  captureChatWorkHistoryExpanded,
  captureRecommendedFollowupSelected,
  captureRecommendedFollowupsShown,
} from "../../lib/posthog.ts";
import { getCreditUsageDisplayName } from "../../lib/credit-usage-display.ts";
import {
  FileAttachmentChip,
  PreviewableAudioAttachmentChip,
  PreviewableFileAttachmentChip,
} from "./attachment-chips.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { classifyChatAttachment } from "../../signals/chat-page/parse-body-blocks.ts";
import type { ArtifactSignals } from "../../signals/chat-page/artifact-card-signals.ts";
import {
  activeChatConnectorAction$,
  closeChatConnectorActionConnectDialog$,
} from "../../signals/chat-page/connector-action-block.ts";
import {
  buildCompletedWorkFolding,
  chatEventDisplayError,
  completedWorkExpandedKeys$,
  completedWorkExpandedKeysForScrollTarget,
  completedWorkFoldForGroup,
  isRenderableAssistantEvent,
  toggleCompletedWorkExpanded$,
  type CompletedWorkFold,
  type CompletedWorkFolding,
} from "../../signals/chat-page/completed-work-folding.ts";
import {
  buildRunWorkFolding,
  runWorkExpandedKeys$,
  runWorkExpandedKeysForScrollTarget,
  runWorkSectionForGroup,
  toggleRunWorkExpanded$,
  type RunWorkFolding,
  type RunWorkSection,
} from "../../signals/chat-page/run-work-folding.ts";
import {
  buildRunGroupFolding,
  runGroupExpansionOverrides$,
  toggleRunGroupExpanded$,
  type RunGroupFold,
  type RunGroupFolding,
} from "../../signals/chat-page/run-group-folding.ts";
import {
  activeGoalDialogGoal$,
  activeGoalDialogThreadId$,
  closeChatThreadGoalDialog$,
} from "../../signals/chat-page/chat-goal.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { CustomConnectorConnectDialog } from "./components/settings/custom-connector-connect-dialog.tsx";
import {
  defaultBuiltinConnectorAccountOptions,
  defaultCustomConnectorAccountOptions,
} from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { customConnectors$ } from "../../signals/okou-page/settings/custom-connectors.ts";
import {
  openImageLightbox$ as openAttachmentImageLightbox$,
  openVideoLightbox$ as openAttachmentVideoLightbox$,
} from "../../signals/okou-page/attachment-chips.ts";
import {
  writeToClipboard,
  type ChatClipboardAttachment,
} from "../../signals/okou-page/clipboard.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import type {
  HeaderAutomationSignals,
  HeaderWorkflowAutomationEntry,
} from "../../signals/chat-page/header-automation-menu.ts";
import {
  activeThreadSidebar$,
  openThreadAutomations$,
  openThreadBrowserSession$,
} from "../../signals/chat-page/thread-sidebar-coordinator.ts";
import type { ThreadSidebarSignals } from "../../signals/chat-page/thread-sidebar.ts";
import {
  ThreadSidebarSlot,
  useOpenThreadArtifacts,
} from "./thread-sidebar.tsx";
import { ChatThreadSidebarShell } from "./chat-thread-sidebar-shell.tsx";
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
import {
  closeChatThreadEmojiMenu$,
  emojiMenuThreadId$,
  emojiMenuTitle$,
  openChatThreadEmojiMenu$,
} from "../../signals/okou-page/sidebar-state.ts";
import { Link } from "../router/link.tsx";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  atTimeInTimezone,
  cronWallTimeInTimezone,
} from "../../signals/okou-page/cron.ts";
import {
  buildGmailLabelAppliedEventConfig,
  buildGmailNewMessageEventConfig,
  formatWorkflowIntervalSeconds,
  GMAIL_TEXT_FIELDS,
  getWorkflowIntervalSecondOptions,
  gmailMatcherDefaultValue,
} from "../workflows-page/workflow-shared.tsx";
import {
  WorkflowAutomationCard,
  type WorkflowAutomationCardRow,
} from "../workflows-page/workflow-automation-card.tsx";
import {
  renameChatThread$,
  type EnrichedChatEvent,
  type ChatEventGroup,
  type UserMessageFeedbackNoteRenderPart,
  type UserMessageRenderDocument,
  type UserMessageRenderPart,
} from "../../signals/chat-page/chat-event.ts";
import type {
  ChatInputEvent,
  ChatEvent,
} from "../../signals/chat-page/chat-event-types.ts";
import type { ChatRunModelSelection } from "../../signals/chat-page/chat-event-state.ts";
import type { AgentReferenceSignals } from "../../signals/chat-page/agent-reference-signals.ts";
import type { AssistantErrorRecovery } from "../../signals/chat-page/assistant-error-recovery.ts";
import { userMessageFileAttachments } from "../../signals/chat-page/user-message-files.ts";
import type {
  ChatPanelSignals,
  RecommendedFollowupSource,
  ThinkingIndicatorMode,
} from "../../signals/chat-page/chat-panel-signals.ts";
import {
  applyChatThreadEmoji,
  removeChatThreadEmoji,
  CHAT_THREAD_EMOJI_OPTIONS,
} from "../../signals/chat-page/chat-thread-title.ts";
import {
  chatThreadEmojiActiveCategory$,
  chatThreadEmojiGroups$,
  chatThreadEmojiPendingJump$,
  chatThreadEmojiPreview$,
  chatThreadEmojiQuery$,
  filterChatThreadEmojiGroups,
  setChatThreadEmojiActiveCategory$,
  setChatThreadEmojiPendingJump$,
  setChatThreadEmojiPreview$,
  setChatThreadEmojiQuery$,
  type ChatThreadEmojiItem,
} from "../../signals/chat-page/chat-thread-emoji.ts";
import { openRenameChatThreadDialogForThreadId$ } from "../../signals/chat-page/chat-thread-rename.ts";
import { ChatComposer } from "./chat-composer.tsx";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";
import { ChatFeedbackSelection } from "./chat-feedback-selection.tsx";
import { formatSubscriptionUsageReset } from "./subscription-usage-format.ts";
import { AgentAvatarImg, AvatarFromUrl } from "./sidebar-shared.tsx";
import { setBillingSubPage$ } from "../../signals/okou-page/settings/workspace-settings-state.ts";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  billingStatusAsync$,
  creditPurchaseOrigin$,
  type CreditCheckoutSelection,
  startCheckout$,
  startCreditCheckout$,
} from "../../signals/okou-page/billing.ts";
import { orgPlanCapabilitiesFromBilling } from "../../signals/okou-page/org-plan-capabilities.ts";
import {
  currentLeftPane$,
  currentRightPane$,
} from "../../signals/chat-page/chat-thread-panes.ts";
import type { ChatThreadPaneState } from "../../signals/chat-page/chat-thread-pane-state.ts";
import {
  focusChatThreadContainer$,
  setChatKeyboardScrollRoot$,
} from "../../signals/chat-page/chat-keyboard.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import {
  ChatAssistantMessageBody,
  ChatUserMessageBubble,
  CHAT_THREAD_ASSISTANT_AVATAR_FRAME_CLASS,
  CHAT_THREAD_ASSISTANT_AVATAR_IMAGE_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS,
  CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS,
  CHAT_THREAD_CONTENT_MAIN_CLASS,
  CHAT_THREAD_MESSAGE_LIST_CLASS,
  CHAT_THREAD_MESSAGE_STACK_PULL_CLASS,
  CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS,
  CHAT_THREAD_USER_MESSAGE_ROW_CLASS,
} from "./chat-message-surface.tsx";

type RecommendedFollowup = ChatRecommendedFollowup;

type UserMessageNonContentPart = Extract<
  UserMessagePart,
  { readonly type: "source" | "automation" | "goal" }
>;

type UserMessageAnnotationRenderPart = Extract<
  UserMessageRenderPart,
  { readonly type: "source" | "automation" | "goal" }
>;

function isUserMessageNonContentPart(
  part: UserMessagePart,
): part is UserMessageNonContentPart {
  return (
    part.type === "source" || part.type === "automation" || part.type === "goal"
  );
}

type UserMessageHiddenPart = Extract<
  UserMessagePart,
  {
    readonly type: "source" | "automation" | "goal" | "model";
  }
>;

function isUserMessageHiddenPart(
  part: UserMessagePart,
): part is UserMessageHiddenPart {
  return isUserMessageNonContentPart(part) || part.type === "model";
}

function isInputChatEvent(event: ChatEvent): event is ChatInputEvent {
  return (
    event.eventType === "input.prompt" ||
    event.eventType === "input.automation" ||
    event.eventType === "input.goal" ||
    event.eventType === "input.rejected"
  );
}

function asInputChatEvent(event: ChatEvent): ChatInputEvent | undefined {
  return isInputChatEvent(event) ? event : undefined;
}

function modelSelectionFromUserMessage(
  document: UserMessageDocument | undefined,
): ChatRunModelSelection | undefined {
  const modelPart = document?.parts.find((part) => {
    return part.type === "model";
  });
  return modelPart?.type === "model"
    ? {
        selectedModel: modelPart.selectedModel,
        ...(modelPart.serviceTier === undefined
          ? {}
          : { serviceTier: modelPart.serviceTier }),
      }
    : undefined;
}

function modelChangeRunKey(
  inputEvent: ChatInputEvent,
  modelSelection: ChatRunModelSelection | undefined,
): string | undefined {
  if (inputEvent.runId !== undefined) {
    return `run:${inputEvent.runId}`;
  }
  if (modelSelection !== undefined) {
    return `event:${inputEvent.id}`;
  }
  return undefined;
}

type RunModelChange =
  | {
      readonly kind: "model";
      readonly selection: ChatRunModelSelection;
    }
  | {
      readonly kind: "fast-mode";
      readonly enabled: boolean;
    };

function fastModeEnabled(selection: ChatRunModelSelection): boolean {
  return selection.serviceTier === "priority";
}

function runModelDisplayName(
  t: TFunction<"common">,
  selection: ChatRunModelSelection,
): string {
  const model = getModelDisplayName(selection.selectedModel);
  return fastModeEnabled(selection)
    ? t(
        ($) => {
          return $.chat.run.fastModelName;
        },
        { model },
      )
    : model;
}

function modelChangesByEventId(
  groups: readonly ChatEventGroup[],
): ReadonlyMap<string, RunModelChange> {
  const changes = new Map<string, RunModelChange>();
  let previousRunKey: string | undefined;
  let previousSelection: ChatRunModelSelection | undefined;
  let hasPreviousRun = false;

  for (const group of groups) {
    for (const event of group.events) {
      const inputEvent = asInputChatEvent(event);
      if (inputEvent === undefined) {
        continue;
      }
      const selection = modelSelectionFromUserMessage(inputEvent.userMessage);
      const runKey = modelChangeRunKey(inputEvent, selection);
      if (runKey === undefined || runKey === previousRunKey) {
        continue;
      }
      if (
        hasPreviousRun &&
        previousSelection !== undefined &&
        selection !== undefined
      ) {
        if (selection.selectedModel !== previousSelection.selectedModel) {
          changes.set(event.id, { kind: "model", selection });
        } else if (
          fastModeEnabled(selection) !== fastModeEnabled(previousSelection)
        ) {
          changes.set(event.id, {
            kind: "fast-mode",
            enabled: fastModeEnabled(selection),
          });
        }
      }
      previousRunKey = runKey;
      previousSelection = selection;
      hasPreviousRun = true;
    }
  }

  return changes;
}

function userMessageNonContentPart(
  document: UserMessageDocument | undefined,
): UserMessageNonContentPart | undefined {
  return document?.parts.find(isUserMessageNonContentPart);
}

function userMessageAnnotationRenderPart(
  document: UserMessageRenderDocument | undefined,
): UserMessageAnnotationRenderPart | undefined {
  return document?.parts.find(
    (renderPart): renderPart is UserMessageAnnotationRenderPart => {
      return (
        renderPart.type === "source" ||
        renderPart.type === "automation" ||
        renderPart.type === "goal"
      );
    },
  );
}

function eventNonContentPart(
  event: EnrichedChatEvent,
): UserMessageNonContentPart | undefined {
  return userMessageNonContentPart(
    isInputChatEvent(event) ? event.userMessage : undefined,
  );
}

function ArtifactsButton({ thread }: { thread: ChatPanelSignals }) {
  return <ArtifactsButtonInner thread={thread} />;
}

function ArtifactsButtonInner({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const sidebarTarget = useGet(thread.sidebar.target$);
  const reloadArtifacts = useSet(thread.reloadArtifacts$);
  const openThreadArtifacts = useOpenThreadArtifacts(thread);
  const open = sidebarTarget?.type === "artifacts";

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={() => {
              reloadArtifacts();
              openThreadArtifacts();
            }}
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className={cn(
              "shrink-0 duration-150",
              open && "bg-primary/10 text-brand-text hover:text-brand-text",
            )}
            aria-label={t(($) => {
              return $.chat.thread.openArtifacts;
            })}
            aria-pressed={open}
          >
            <Package size={18} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t(($) => {
            return $.chat.thread.openArtifacts;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
// Loads automations and only renders once this thread has at least one linked
// automation.
export function AutomationMenuButton({
  thread,
  ariaLabel,
}: {
  thread: ChatPanelSignals;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const reloadAutomations = useSet(thread.headerAutomations.reload$);
  const openAutomationSidebar = useSet(openThreadAutomations$);
  const sidebarTarget = useGet(thread.sidebar.target$);
  const workflowAutomations$ = thread.headerAutomations.automations$;
  const workflowAutomationsLoadable = useLastLoadable(workflowAutomations$);
  const lastResolvedAutomations = useLastResolved(workflowAutomations$);
  const workflowAutomations =
    workflowAutomationsLoadable.state === "hasData"
      ? workflowAutomationsLoadable.data
      : (lastResolvedAutomations ?? []);
  const open = sidebarTarget?.type === "automations";

  // Show the opener when the thread has a workflow automation.
  // Goals live in the composer, so a goal-only thread has nothing here.
  if (workflowAutomations.length === 0) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className={cn(
              "shrink-0 duration-150",
              open && "bg-primary/10 text-brand-text hover:text-brand-text",
            )}
            aria-label={
              ariaLabel ??
              t(($) => {
                return $.chat.automations.title;
              })
            }
            aria-pressed={open}
            onClick={() => {
              reloadAutomations();
              openAutomationSidebar(thread);
            }}
          >
            <Clock size={18} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t(($) => {
            return $.chat.automations.open;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function BrowserMenuButton({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const sidebarTarget = useGet(thread.sidebar.target$);
  const openBrowserSidebar = useSet(openThreadBrowserSession$);

  const open = sidebarTarget?.type === "browser";
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="icon-sm"
            iconSize="md"
            className={cn(
              "shrink-0 duration-150",
              open && "bg-primary/10 text-brand-text hover:text-brand-text",
            )}
            aria-label={t(($) => {
              return $.chat.thread.openBrowser;
            })}
            aria-pressed={open}
            onClick={() => {
              openBrowserSidebar(thread.threadId);
            }}
          >
            <Globe size={18} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t(($) => {
            return $.chat.thread.openBrowser;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const CHAT_THREAD_HEADER_CLASS =
  "hidden h-14 shrink-0 items-center justify-between bg-transparent px-6 sm:flex";

function ChatThreadHeader({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const threadTitle = useGet(thread.threadTitle$)?.trim() ?? "";
  const threadTitleEmoji = useGet(thread.threadTitleEmoji$);
  const threadTitleText = useGet(thread.threadTitleText$);
  const openRenameChatThreadDialog = useSet(
    openRenameChatThreadDialogForThreadId$,
  );
  const pageSignal = useGet(pageSignal$);
  const sharingPhase = useGet(thread.sharing.phase$);
  const selectedCount = useGet(thread.sharing.selectedCount$);
  const startSharing = useSet(thread.sharing.start$);
  const closeSharing = useSet(thread.sharing.close$);
  const sharingEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.SharedThreadSharing] ?? false;
  function openRenameDialog(event: ReactMouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    detach(
      openRenameChatThreadDialog(thread.threadId, pageSignal),
      Reason.DomCallback,
    );
  }

  if (sharingPhase !== "idle") {
    return (
      <header className={CHAT_THREAD_HEADER_CLASS}>
        <span className="text-sm font-medium text-foreground">
          {t(
            ($) => {
              return $.chat.sharing.selectedCount;
            },
            { count: selectedCount },
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            detach(
              closeSharing(pageSignal),
              Reason.DomCallback,
              "close shared thread selection",
            );
          }}
        >
          {t(($) => {
            return $.chat.sharing.cancel;
          })}
        </Button>
      </header>
    );
  }

  return (
    <header className={CHAT_THREAD_HEADER_CLASS}>
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
        {sharingEnabled ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  onClick={() => {
                    detach(
                      startSharing(pageSignal),
                      Reason.DomCallback,
                      "start shared thread selection",
                    );
                  }}
                  variant="quiet"
                  size="icon-sm"
                  iconSize="md"
                  className="shrink-0 duration-150"
                  aria-label={t(($) => {
                    return $.chat.sharing.start;
                  })}
                >
                  <Share2 size={18} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t(($) => {
                  return $.chat.sharing.start;
                })}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <AutomationMenuButton thread={thread} />
        <BrowserMenuButton thread={thread} />
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
  const { t } = useTranslation();
  const { open, openChatThreadEmojiMenu, closeMenu, selectEmoji, clearEmoji } =
    useChatThreadEmojiMenuActions({ threadId, title });
  const setEmojiQuery = useSet(setChatThreadEmojiQuery$);
  const setEmojiActiveCategory = useSet(setChatThreadEmojiActiveCategory$);
  const setEmojiPendingJump = useSet(setChatThreadEmojiPendingJump$);
  const setEmojiPreview = useSet(setChatThreadEmojiPreview$);

  return (
    <TooltipProvider delayDuration={200}>
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setEmojiQuery("");
            setEmojiActiveCategory(null);
            setEmojiPendingJump(null);
            setEmojiPreview(null);
            openChatThreadEmojiMenu({ threadId, title });
          } else {
            closeMenu();
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                aria-label={t(($) => {
                  return $.chat.thread.changeIcon;
                })}
                variant="quiet"
                size="icon-xs"
                iconSize="md"
                className="shrink-0"
              >
                {emoji ? (
                  <span
                    aria-hidden="true"
                    className="zero-emoji text-base leading-none"
                  >
                    {emoji}
                  </span>
                ) : (
                  <SmilePlus size={18} aria-hidden="true" />
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t(($) => {
              return $.chat.thread.icon;
            })}
          </TooltipContent>
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

function useFrequentlyUsedEmoji(): ChatThreadEmojiItem[] {
  const { t } = useTranslation();
  const labels = [
    t(($) => {
      return $.chat.thread.emoji.done;
    }),
    t(($) => {
      return $.chat.thread.emoji.urgent;
    }),
    t(($) => {
      return $.chat.thread.emoji.no;
    }),
    t(($) => {
      return $.chat.thread.emoji.risk;
    }),
    t(($) => {
      return $.chat.thread.emoji.idea;
    }),
    t(($) => {
      return $.chat.thread.emoji.question;
    }),
    t(($) => {
      return $.chat.thread.emoji.waiting;
    }),
    t(($) => {
      return $.chat.thread.emoji.watching;
    }),
    t(($) => {
      return $.chat.thread.emoji.shipped;
    }),
  ];
  return CHAT_THREAD_EMOJI_OPTIONS.map((option, index) => {
    return { emoji: option.emoji, name: labels[index] ?? option.emoji };
  });
}

// unicode-emoji-json ships the CLDR group names, so key the rail icons off the
// same strings the sections are titled with.
function chatThreadEmojiCategoryIcon(group: string): LucideIcon {
  switch (group) {
    case "People & Body": {
      return Hand;
    }
    case "Animals & Nature": {
      return Leaf;
    }
    case "Food & Drink": {
      return Coffee;
    }
    case "Travel & Places": {
      return Plane;
    }
    case "Activities": {
      return Trophy;
    }
    case "Objects": {
      return Lightbulb;
    }
    case "Symbols": {
      return Heart;
    }
    case "Flags": {
      return Flag;
    }
    default: {
      return Smile;
    }
  }
}

const CHAT_THREAD_EMOJI_FREQUENT_CATEGORY = "frequently-used";

interface ChatThreadEmojiCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  items: ChatThreadEmojiItem[];
  showShortcutDigits: boolean;
  // The emoji dataset names an emoji the way a shortcode does; the frequently
  // used row names it the way this product does ("Done", "Urgent"), which is
  // translated and must not be dressed up as a shortcode.
  shortcodeNames: boolean;
}

function chatThreadEmojiDisplayName(
  name: string,
  shortcodeNames: boolean,
): string {
  return shortcodeNames ? `:${name.replace(/\s+/g, "_")}:` : name;
}

function chatThreadEmojiSectionId(key: string): string {
  return `chat-thread-emoji-section-${key}`;
}

// The category whose title is pinned right now: the last section that has
// already reached the top of the feed.
function pinnedChatThreadEmojiCategory(feed: HTMLElement): string | null {
  const sections = Array.from(
    feed.querySelectorAll<HTMLElement>("[data-chat-thread-emoji-section]"),
  );
  let pinned: string | null = null;
  for (const section of sections) {
    if (section.offsetTop > feed.scrollTop + 1) {
      break;
    }
    pinned = section.dataset.chatThreadEmojiSection ?? null;
  }
  return pinned;
}

// Where the feed lands when it jumps to a section. A short final category
// cannot scroll all the way to its own offset, so clamp to the last reachable
// position: the jump and the arrival check have to agree on the same number.
function chatThreadEmojiScrollTarget(
  feed: HTMLElement,
  section: HTMLElement,
): number {
  return Math.min(section.offsetTop, feed.scrollHeight - feed.clientHeight);
}

// Returns whether the feed will actually move. A jump that scrolls nowhere
// emits no scroll event, so the caller must not wait for one.
function scrollChatThreadEmojiCategoryIntoView(key: string): boolean {
  const section = document.getElementById(chatThreadEmojiSectionId(key));
  const feed = section?.closest<HTMLElement>("[data-chat-thread-emoji-feed]");
  if (!section || !feed || typeof feed.scrollTo !== "function") {
    return false;
  }
  const top = chatThreadEmojiScrollTarget(feed, section);
  if (Math.abs(top - feed.scrollTop) <= 1) {
    return false;
  }
  feed.scrollTo({ top, behavior: "smooth" });
  return true;
}

function chatThreadEmojiCategories(
  frequentLabel: string,
  frequentItems: ChatThreadEmojiItem[],
  groups: { name: string; emojis: ChatThreadEmojiItem[] }[] | null,
): ChatThreadEmojiCategory[] {
  return [
    {
      key: CHAT_THREAD_EMOJI_FREQUENT_CATEGORY,
      label: frequentLabel,
      icon: Clock,
      items: frequentItems,
      showShortcutDigits: true,
      shortcodeNames: false,
    },
    ...(groups ?? []).map((group) => {
      return {
        key: group.name,
        label: group.name,
        icon: chatThreadEmojiCategoryIcon(group.name),
        items: group.emojis,
        showShortcutDigits: false,
        shortcodeNames: true,
      };
    }),
  ];
}

function ChatThreadEmojiCategoryRail({
  categories,
  onSelect,
}: {
  categories: ChatThreadEmojiCategory[];
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  // Held here rather than in the picker so that following the feed re-renders
  // the rail alone, not the ~1,900 emoji buttons below it.
  const activeCategory = useGet(chatThreadEmojiActiveCategory$);
  const selectedCategory =
    activeCategory ?? CHAT_THREAD_EMOJI_FREQUENT_CATEGORY;

  // A tablist takes one tab stop, and the arrow keys move between the tabs
  // inside it.
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) {
      return;
    }
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
    );
    const current = tabs.findIndex((tab) => {
      return tab === document.activeElement;
    });
    if (current === -1) {
      return;
    }
    event.preventDefault();
    const next = (current + step + tabs.length) % tabs.length;
    tabs[next]?.focus();
    const nextCategory = categories[next];
    if (nextCategory) {
      onSelect(nextCategory.key);
    }
  }

  return (
    <div
      role="tablist"
      aria-label={t(($) => {
        return $.chat.thread.emojiCategories;
      })}
      // 7px top and bottom keeps the buttons clear of the popover edge and of
      // the divider; the active bar then sits inside the bottom gap.
      className="flex gap-0.5 border-b border-border px-2 py-[7px]"
      onKeyDown={handleKeyDown}
    >
      {categories.map((category) => {
        const CategoryIcon = category.icon;
        const selected = category.key === selectedCategory;
        return (
          <button
            key={category.key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={chatThreadEmojiSectionId(category.key)}
            aria-label={category.label}
            title={category.label}
            tabIndex={selected ? 0 : -1}
            className={cn(
              "relative flex h-8 flex-1 items-center justify-center rounded-lg transition-colors hover:bg-state-hover hover:text-foreground",
              selected ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => {
              onSelect(category.key);
            }}
          >
            <CategoryIcon size={16} aria-hidden="true" />
            {selected && (
              <span
                aria-hidden="true"
                // -8px == the row's 7px bottom padding plus its 1px border, so
                // the bar seats on the divider instead of floating above it.
                className="absolute -bottom-2 h-0.5 w-4 rounded-t-sm bg-primary"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function ChatThreadEmojiPicker({
  hasEmoji,
  onSelect,
  onRemove,
}: {
  hasEmoji: boolean;
  onSelect: (emoji: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const query = useGet(chatThreadEmojiQuery$);
  const setQuery = useSet(setChatThreadEmojiQuery$);
  const groups = useLastResolved(chatThreadEmojiGroups$) ?? null;
  const frequentlyUsedEmoji = useFrequentlyUsedEmoji();
  const setActiveCategory = useSet(setChatThreadEmojiActiveCategory$);
  const setPendingJump = useSet(setChatThreadEmojiPendingJump$);

  const isSearching = query.trim().length > 0;
  const searchResults =
    isSearching && groups ? filterChatThreadEmojiGroups(groups, query) : [];

  const categories = chatThreadEmojiCategories(
    t(($) => {
      return $.chat.thread.frequentlyUsed;
    }),
    frequentlyUsedEmoji,
    groups,
  );
  function jumpToCategory(key: string): void {
    if (isSearching) {
      setQuery("");
    }
    setActiveCategory(key);
    // The sections may only mount once the query clears, so scroll on the next
    // frame rather than against the pre-clear layout. Only hold the highlight
    // when the feed really moves — otherwise no scroll event would arrive to
    // release the hold and the rail would stop following the feed for good.
    window.requestAnimationFrame(() => {
      setPendingJump(scrollChatThreadEmojiCategoryIntoView(key) ? key : null);
    });
  }

  return (
    <div className="flex flex-col">
      <ChatThreadEmojiCategoryRail
        categories={categories}
        onSelect={jumpToCategory}
      />
      <div
        // The gap below the field belongs to this row, because a search hides
        // the sections and puts a bare result grid under it. 12px here plus
        // the title's own pt-1 puts the first title the same 16px below the
        // field as every later title sits below the grid above it.
        className="flex items-center gap-2 px-2 pb-3 pt-2"
      >
        <div className="relative flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            aria-label={t(($) => {
              return $.chat.thread.searchEmoji;
            })}
            placeholder={t(($) => {
              return $.chat.thread.searchEmoji;
            })}
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
            className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
            onClick={onRemove}
          >
            {t(($) => {
              return $.chat.actions.remove;
            })}
          </button>
        )}
      </div>
      <ChatThreadEmojiFeed
        categories={categories}
        searchResults={isSearching ? searchResults : null}
        onSelect={onSelect}
      />
      <ChatThreadEmojiPreview />
    </div>
  );
}

// Names whichever emoji the pointer or keyboard is on, so the grid stays a
// grid of glyphs and the reader still gets a label for the one in question.
function ChatThreadEmojiPreview() {
  const { t } = useTranslation();
  const preview = useGet(chatThreadEmojiPreview$);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-2">
      {preview ? (
        <>
          <span aria-hidden="true" className="zero-emoji text-lg leading-none">
            {preview.emoji}
          </span>
          <span className="truncate text-xs font-medium text-muted-foreground">
            {preview.name}
          </span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground/70">
          {t(($) => {
            return $.chat.thread.pickEmoji;
          })}
        </span>
      )}
    </div>
  );
}

function ChatThreadEmojiFeed({
  categories,
  searchResults,
  onSelect,
}: {
  categories: ChatThreadEmojiCategory[];
  searchResults: ChatThreadEmojiItem[] | null;
  onSelect: (emoji: string) => void;
}) {
  const { t } = useTranslation();
  const setActiveCategory = useSet(setChatThreadEmojiActiveCategory$);
  const pendingJump = useGet(chatThreadEmojiPendingJump$);
  const setPendingJump = useSet(setChatThreadEmojiPendingJump$);
  const setPreview = useSet(setChatThreadEmojiPreview$);

  // One delegated listener on the feed rather than a pair on each of the ~1,900
  // buttons. Pointer and keyboard both report through it.
  function previewEmojiUnder(target: EventTarget): void {
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest<HTMLElement>("[data-chat-thread-emoji]");
    const emoji = button?.dataset.chatThreadEmoji;
    const name = button?.dataset.chatThreadEmojiName;
    setPreview(emoji && name ? { emoji, name } : null);
  }

  function handleScroll(event: ReactUIEvent<HTMLDivElement>): void {
    const feed = event.currentTarget;
    if (pendingJump !== null) {
      const target = feed.querySelector<HTMLElement>(
        `[data-chat-thread-emoji-section="${pendingJump}"]`,
      );
      // Release the hold once the jump lands, and also when its section is no
      // longer around to land on, so the hold can never outlive the jump.
      if (
        !target ||
        Math.abs(chatThreadEmojiScrollTarget(feed, target) - feed.scrollTop) <=
          1
      ) {
        setPendingJump(null);
      }
      return;
    }
    setActiveCategory(pinnedChatThreadEmojiCategory(feed));
  }

  // Scrolling by hand aborts an in-flight smooth scroll, so the jump will never
  // reach its target: hand the feed back the highlight immediately.
  function releasePendingJump(): void {
    if (pendingJump !== null) {
      setPendingJump(null);
    }
  }

  return (
    <div
      data-chat-thread-emoji-feed=""
      // relative so each section's offsetTop is measured against the feed.
      className="relative max-h-72 overflow-y-auto px-2 pb-2"
      onScroll={handleScroll}
      onWheel={releasePendingJump}
      onTouchStart={releasePendingJump}
      onPointerDown={releasePendingJump}
      onMouseOver={(event) => {
        previewEmojiUnder(event.target);
      }}
      onFocus={(event) => {
        previewEmojiUnder(event.target);
      }}
      onMouseLeave={() => {
        setPreview(null);
      }}
    >
      {searchResults !== null ? (
        searchResults.length > 0 ? (
          <ChatThreadEmojiGrid items={searchResults} onSelect={onSelect} />
        ) : (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.thread.noEmojiFound;
            })}
          </p>
        )
      ) : (
        categories.map((category) => {
          return (
            <ChatThreadEmojiSection
              key={category.key}
              categoryKey={category.key}
              label={category.label}
              items={category.items}
              onSelect={onSelect}
              showShortcutDigits={category.showShortcutDigits}
              shortcodeNames={category.shortcodeNames}
            />
          );
        })
      )}
    </div>
  );
}

function ChatThreadEmojiSection({
  categoryKey,
  label,
  items,
  onSelect,
  showShortcutDigits = false,
  shortcodeNames = true,
}: {
  categoryKey: string;
  label: string;
  items: ChatThreadEmojiItem[];
  onSelect: (emoji: string) => void;
  showShortcutDigits?: boolean;
  shortcodeNames?: boolean;
}) {
  const { t } = useTranslation();
  // Ctrl+Shift is a shared prefix for every digit shortcut, so surface it once
  // as a quiet hint next to the label rather than repeating it on each emoji.
  // getShortcutParts keeps the modifiers OS-aware (⌃⇧ on Mac, Ctrl+Shift else).
  const shortcutHint = showShortcutDigits
    ? `${formatModifierPrefix(getShortcutParts("ctrl+shift"))} + ${t(($) => {
        return $.chat.shortcuts.number;
      })}`
    : null;
  return (
    <div
      id={chatThreadEmojiSectionId(categoryKey)}
      data-chat-thread-emoji-section={categoryKey}
      // The pinned title's fade has to sit below its text, so the space that
      // separates it from the previous grid cannot come from the sticky box
      // itself. Carry it here instead, at twice the 8px left under the label,
      // so the title reads as a heading for its own grid and not as a caption
      // for the one above it. The first section has no grid above it — the
      // search row already spaces it off the field.
      className="mt-3 first:mt-0"
    >
      <div
        // Fade to transparent at the lower edge so emoji dissolve as they
        // scroll under the pinned title instead of colliding with it. The
        // fade has to live below the text, so pb-2 doubles as the gap to the
        // grid; from-75% keeps the whole label — descenders included — on the
        // solid part of that 28px box rather than over the fading part.
        className="sticky top-0 z-10 flex items-baseline justify-between gap-2 bg-gradient-to-b from-popover from-75% to-transparent pb-2 pt-1"
      >
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
        shortcodeNames={shortcodeNames}
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
  shortcodeNames = true,
}: {
  items: ChatThreadEmojiItem[];
  onSelect: (emoji: string) => void;
  showShortcutDigits?: boolean;
  shortcodeNames?: boolean;
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
            data-chat-thread-emoji={item.emoji}
            data-chat-thread-emoji-name={chatThreadEmojiDisplayName(
              item.name,
              shortcodeNames,
            )}
            title={shortcutLabel}
            // The focus ring is inset because the feed scrolls: an offset ring
            // on the outer columns and on the first and last rows would be
            // clipped by the feed's own overflow box.
            className="relative flex aspect-square items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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

function formatHeaderWorkflowAutomationRun(value: string | null): string {
  if (!value) {
    return i18n.t(($) => {
      return $.chat.automations.noRuns;
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return i18n.t(($) => {
      return $.chat.automations.noRuns;
    });
  }
  return date.toLocaleString(i18n.resolvedLanguage, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatHeaderWorkflowAutomationNextRun(value: string | null): string {
  if (!value) {
    return i18n.t(($) => {
      return $.chat.automations.noUpcomingRun;
    });
  }
  return formatHeaderWorkflowAutomationRun(value);
}

function formatHeaderClockTime(hour: number, minute: number): string {
  return new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2020, 0, 1, hour, minute));
}

function formatHeaderIntervalSeconds(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return i18n.t(
      ($) => {
        return $.chat.automations.everyHour;
      },
      { count: hours },
    );
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return i18n.t(
      ($) => {
        return $.chat.automations.everyMinute;
      },
      { count: minutes },
    );
  }
  return i18n.t(
    ($) => {
      return $.chat.automations.everySecond;
    },
    { count: seconds },
  );
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
    return i18n.t(
      ($) => {
        return $.chat.automations.cronWithTimezone;
      },
      {
        expression: cronExpression,
        timezone: sourceTimezone,
      },
    );
  }
  const converted = cronWallTimeInTimezone(
    hour,
    minute,
    sourceTimezone,
    displayTimezone,
  );
  const time = formatHeaderClockTime(converted.hour, converted.minute);
  if (dayOfMonth !== "*") {
    return i18n.t(
      ($) => {
        return $.chat.automations.monthlyAt;
      },
      {
        day: dayOfMonth,
        time,
      },
    );
  }
  if (dayOfWeek === "1-5") {
    return i18n.t(
      ($) => {
        return $.chat.automations.weekdayAt;
      },
      { time },
    );
  }
  if (dayOfWeek !== "*") {
    const days = dayOfWeek
      .split(",")
      .map((day) => {
        const weekday = Number(day);
        return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6
          ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
              weekday: "long",
            }).format(new Date(2020, 0, 5 + weekday))
          : undefined;
      })
      .filter(Boolean)
      .join(", ");
    return days
      ? i18n.t(
          ($) => {
            return $.chat.automations.weeklyOnAt;
          },
          { days, time },
        )
      : i18n.t(
          ($) => {
            return $.chat.automations.weeklyAt;
          },
          { time },
        );
  }
  return i18n.t(
    ($) => {
      return $.chat.automations.dailyAt;
    },
    { time },
  );
}

function headerWorkflowAutomationRule(
  automation: HeaderWorkflowAutomationEntry,
): string {
  const source = automation.automation;
  if (source.kind !== "schedule") {
    return automation.summary;
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
    return i18n.t(
      ($) => {
        return $.chat.automations.onceAt;
      },
      {
        date,
        time: formatHeaderClockTime(hour, minute),
      },
    );
  }
  return headerCronRuleLabel(
    schedule.cronExpression,
    schedule.timezone,
    automation.timezone,
  );
}

type HeaderGmailNewMessageAutomation = Extract<
  ChatThreadWorkflowAutomation,
  { readonly eventType: "gmail-new-message" }
>;
type HeaderGmailTextField = keyof NonNullable<
  HeaderGmailNewMessageAutomation["eventConfig"]["match"]
>;
type HeaderGmailTextMatcher = NonNullable<
  NonNullable<
    HeaderGmailNewMessageAutomation["eventConfig"]["match"]
  >[HeaderGmailTextField]
>;

function quotedAutomationValue(value: string): string {
  return `"${value}"`;
}

function headerGmailFieldLabel(field: HeaderGmailTextField): string {
  switch (field) {
    case "from": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.from;
      });
    }
    case "subject": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.subject;
      });
    }
    case "body": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.body;
      });
    }
    case "to": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.to;
      });
    }
    case "cc": {
      return i18n.t(($) => {
        return $.chat.automations.gmail.cc;
      });
    }
  }
}

function headerGmailMatcherParts(
  field: HeaderGmailTextField,
  matcher: HeaderGmailTextMatcher,
): string[] {
  const fieldLabel = headerGmailFieldLabel(field);
  const parts: string[] = [];
  if (matcher.contains) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.contains;
        },
        {
          field: fieldLabel,
          value: quotedAutomationValue(matcher.contains),
        },
      ),
    );
  }
  if (matcher.containsAny) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.containsAny;
        },
        {
          field: fieldLabel,
          values: matcher.containsAny.map(quotedAutomationValue).join(", "),
        },
      ),
    );
  }
  if (matcher.doesNotContain) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.doesNotContain;
        },
        {
          field: fieldLabel,
          value: quotedAutomationValue(matcher.doesNotContain),
        },
      ),
    );
  }
  if (matcher.doesNotContainAny) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.doesNotContainAny;
        },
        {
          field: fieldLabel,
          values: matcher.doesNotContainAny
            .map(quotedAutomationValue)
            .join(", "),
        },
      ),
    );
  }
  return parts;
}

function headerGmailMatchSummary(
  config: HeaderGmailNewMessageAutomation["eventConfig"],
): string {
  const parts: string[] = config.threadId
    ? [
        i18n.t(
          ($) => {
            return $.chat.automations.matchSummary.threadIdIs;
          },
          {
            value: quotedAutomationValue(config.threadId),
          },
        ),
      ]
    : [];
  if (config.match) {
    for (const { field } of GMAIL_TEXT_FIELDS) {
      const matcher = config.match[field];
      if (matcher) {
        parts.push(...headerGmailMatcherParts(field, matcher));
      }
    }
  }
  return parts.length > 0
    ? parts.join("; ")
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.allInboundMessages;
      });
}

function headerAutomationFilterSummary(
  values: readonly string[] | undefined,
  fallback: string,
): string {
  return values?.join(", ") ?? fallback;
}

function headerNotionParentPageSummary(
  title: string | null | undefined,
): string {
  return title
    ? i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.parentPage;
        },
        {
          value: quotedAutomationValue(title),
        },
      )
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.configuredParentPage;
      });
}

function headerNotionDatabaseSummary(title: string | null | undefined): string {
  return title
    ? i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.database;
        },
        {
          value: quotedAutomationValue(title),
        },
      )
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.configuredDatabase;
      });
}

function headerNotionPageSummary(title: string | null | undefined): string {
  return title
    ? i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.page;
        },
        {
          value: quotedAutomationValue(title),
        },
      )
    : i18n.t(($) => {
        return $.chat.automations.matchSummary.configuredPage;
      });
}

function headerWorkflowAutomationMatchSummary(
  automation: ChatThreadWorkflowAutomation,
): string | null {
  if (automation.kind !== "event") {
    return null;
  }
  switch (automation.eventType) {
    case "gmail-label-applied": {
      return i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.label;
        },
        {
          value: quotedAutomationValue(automation.eventConfig.labelName),
        },
      );
    }
    case "github-pull-request": {
      return `${automation.eventConfig.repository} · ${automation.eventConfig.action}`;
    }
    case "gmail-new-message": {
      return headerGmailMatchSummary(automation.eventConfig);
    }
    case "github-workflow-run-completed":
    case "github-workflow-job-completed": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.conclusions,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyResult;
        }),
      );
    }
    case "github-pull-request-review-submitted": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.reviewStates,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyReview;
        }),
      );
    }
    case "github-deployment-status-created": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.states,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyDeploymentState;
        }),
      );
    }
    case "github-issue-comment-created": {
      return headerAutomationFilterSummary(
        automation.eventConfig.filters.commentPrefixes,
        i18n.t(($) => {
          return $.chat.automations.matchSummary.anyComment;
        }),
      );
    }
    case "google-calendar-event-created":
    case "google-calendar-event-updated":
    case "google-calendar-event-cancelled": {
      return i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.calendar;
        },
        {
          value: quotedAutomationValue(automation.eventConfig.calendarId),
        },
      );
    }
    case "google-meet-transcript-generated": {
      return i18n.t(($) => {
        return $.chat.automations.matchSummary.meetingsYouOrganize;
      });
    }
    case "notion-child-page-created": {
      return headerNotionParentPageSummary(
        automation.eventConfig.parentPage.title,
      );
    }
    case "notion-database-item-created": {
      return headerNotionDatabaseSummary(
        automation.eventConfig.dataSource.title,
      );
    }
    case "notion-page-content-updated": {
      if (automation.eventConfig.scope.type === "page") {
        return headerNotionPageSummary(automation.eventConfig.scope.page.title);
      }
      return headerNotionDatabaseSummary(
        automation.eventConfig.scope.dataSource.title,
      );
    }
    default: {
      return null;
    }
  }
}

function headerWorkflowAutomationRows(
  automation: HeaderWorkflowAutomationEntry,
): readonly WorkflowAutomationCardRow[] {
  const rows: WorkflowAutomationCardRow[] = [
    {
      label: i18n.t(($) => {
        return $.chat.automations.status;
      }),
      value: automation.enabled
        ? i18n.t(($) => {
            return $.chat.automations.active;
          })
        : i18n.t(($) => {
            return $.chat.automations.disabled;
          }),
    },
    {
      label:
        automation.automation.kind === "schedule"
          ? i18n.t(($) => {
              return $.chat.automations.schedule;
            })
          : i18n.t(($) => {
              return $.chat.automations.automation;
            }),
      value: headerWorkflowAutomationRule(automation),
    },
    {
      label: i18n.t(($) => {
        return $.chat.automations.lastRun;
      }),
      value: formatHeaderWorkflowAutomationRun(automation.automation.lastRunAt),
    },
  ];
  if (automation.automation.kind === "schedule") {
    rows.push({
      label: i18n.t(($) => {
        return $.chat.automations.nextRun;
      }),
      value: formatHeaderWorkflowAutomationNextRun(
        automation.automation.nextRunAt,
      ),
    });
  }
  const matchSummary = headerWorkflowAutomationMatchSummary(
    automation.automation,
  );
  if (matchSummary) {
    rows.splice(1, 0, {
      label: i18n.t(($) => {
        return $.chat.automations.match;
      }),
      value: matchSummary,
    });
  }
  return rows;
}

function HeaderWorkflowAutomationCard({
  automation,
  headerAutomations,
  threadSidebar,
}: {
  automation: HeaderWorkflowAutomationEntry;
  headerAutomations: HeaderAutomationSignals;
  threadSidebar: ThreadSidebarSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const editingAutomationId = useGet(threadSidebar.editingAutomationId$);
  const setEditingAutomationId = useSet(threadSidebar.setEditingAutomationId$);
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
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
        >
          {t(($) => {
            return $.chat.actions.view;
          })}
          <ArrowUpRight size={12} />
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
                {t(($) => {
                  return $.chat.actions.edit;
                })}
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
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Play size={13} />
              )}
              {running
                ? t(($) => {
                    return $.chat.automations.starting;
                  })
                : t(($) => {
                    return $.chat.automations.runNow;
                  })}
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
  const { t } = useTranslation();
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
          <DialogTitle>
            {t(($) => {
              return $.chat.automations.edit;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.automations.editDescription;
            })}
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
): WorkflowSchedule | null {
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
  const { t } = useTranslation();
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
          {t(($) => {
            return $.chat.automations.runAt;
          })}
          <Input
            name="atTime"
            aria-label={t(($) => {
              return $.chat.automations.runAt;
            })}
            type="datetime-local"
            defaultValue={localDateTimeInputValue(schedule.atTime)}
            disabled={saving}
          />
          <span>
            {t(
              ($) => {
                return $.chat.automations.displaysIn;
              },
              {
                timezone: displayTimezone,
              },
            )}
          </span>
        </label>
      ) : null}
      {schedule.type === "cron" ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.automations.cronExpression;
          })}
          <Input
            name="cronExpression"
            aria-label={t(($) => {
              return $.chat.automations.cronExpression;
            })}
            defaultValue={schedule.cronExpression}
            disabled={saving}
          />
          <span>
            {t(
              ($) => {
                return $.chat.automations.runsIn;
              },
              {
                timezone: schedule.timezone,
              },
            )}
          </span>
        </label>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onDone}
        >
          {t(($) => {
            return $.chat.actions.cancel;
          })}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {t(($) => {
            return $.chat.automations.save;
          })}
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
  const { t } = useTranslation();
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {t(($) => {
        return $.chat.automations.every;
      })}
      <Select
        name="intervalSeconds"
        defaultValue={String(defaultIntervalSeconds)}
        disabled={disabled}
      >
        <SelectTrigger
          className="h-9 w-full"
          aria-label={t(($) => {
            return $.chat.automations.every;
          })}
        >
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

function HeaderGmailThreadIdFields({
  threadId,
  disabled,
}: {
  readonly threadId: string | null | undefined;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  if (!threadId) {
    return null;
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      <Input
        aria-label={t(($) => {
          return $.chat.automations.gmail.threadIdField;
        })}
        value={t(($) => {
          return $.chat.automations.gmail.threadId;
        })}
        readOnly
        disabled
      />
      <Input
        aria-label={t(($) => {
          return $.chat.automations.gmail.threadIdOperator;
        })}
        value={t(($) => {
          return $.chat.automations.gmail.is;
        })}
        readOnly
        disabled
      />
      <Input
        name="threadId"
        aria-label={t(($) => {
          return $.chat.automations.gmail.threadIdValue;
        })}
        defaultValue={threadId}
        disabled={disabled}
        required
      />
    </div>
  );
}

function HeaderGmailTextMatcherFields({
  eventConfig,
  disabled,
}: {
  readonly eventConfig: HeaderGmailNewMessageAutomation["eventConfig"];
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {GMAIL_TEXT_FIELDS.map(({ field }) => {
        const label = headerGmailFieldLabel(field);
        return (
          <div key={field} className="grid grid-cols-3 gap-2">
            <Input
              name={`${field}Contains`}
              aria-label={t(
                ($) => {
                  return $.chat.automations.gmail.contains;
                },
                { field: label },
              )}
              defaultValue={gmailMatcherDefaultValue(
                eventConfig,
                field,
                "contains",
              )}
              disabled={disabled}
              placeholder={t(
                ($) => {
                  return $.chat.automations.gmail.contains;
                },
                { field: label },
              )}
            />
            <Input
              name={`${field}ContainsAny`}
              aria-label={t(
                ($) => {
                  return $.chat.automations.gmail.containsAny;
                },
                { field: label },
              )}
              defaultValue={gmailMatcherDefaultValue(
                eventConfig,
                field,
                "containsAny",
              )}
              disabled={disabled}
              placeholder={t(
                ($) => {
                  return $.chat.automations.gmail.containsAny;
                },
                { field: label },
              )}
            />
            <Input
              name={`${field}DoesNotContain`}
              aria-label={t(
                ($) => {
                  return $.chat.automations.gmail.doesNotContain;
                },
                { field: label },
              )}
              defaultValue={gmailMatcherDefaultValue(
                eventConfig,
                field,
                "doesNotContain",
              )}
              disabled={disabled}
              placeholder={t(
                ($) => {
                  return $.chat.automations.gmail.doesNotContain;
                },
                { field: label },
              )}
            />
          </div>
        );
      })}
    </div>
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
  const { t } = useTranslation();
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
      <HeaderGmailThreadIdFields
        threadId={automation.eventConfig.threadId}
        disabled={saving}
      />
      <HeaderGmailTextMatcherFields
        eventConfig={automation.eventConfig}
        disabled={saving}
      />
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onDone}
        >
          {t(($) => {
            return $.chat.actions.cancel;
          })}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {t(($) => {
            return $.chat.automations.save;
          })}
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
  const { t } = useTranslation();
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
        {t(($) => {
          return $.chat.automations.gmail.labelName;
        })}
        <Input
          name="labelName"
          aria-label={t(($) => {
            return $.chat.automations.gmail.labelName;
          })}
          required
          defaultValue={automation.eventConfig.labelName}
          disabled={saving}
          placeholder={t(($) => {
            return $.chat.automations.gmail.labelPlaceholder;
          })}
        />
      </label>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onDone}
        >
          {t(($) => {
            return $.chat.actions.cancel;
          })}
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {t(($) => {
            return $.chat.automations.save;
          })}
        </Button>
      </DialogFooter>
    </form>
  );
}
function HeaderAutomationSidebar({
  thread,
  onClose,
}: {
  thread: ChatPanelSignals;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const workflowAutomations$ = thread.headerAutomations.automations$;
  const workflowAutomationsLoadable = useLastLoadable(workflowAutomations$);
  const lastResolvedAutomations = useLastResolved(workflowAutomations$);
  const workflowAutomations =
    workflowAutomationsLoadable.state === "hasData"
      ? workflowAutomationsLoadable.data
      : (lastResolvedAutomations ?? []);
  const isEmpty = workflowAutomations.length === 0;
  const loading = isEmpty && workflowAutomationsLoadable.state === "loading";

  return (
    <aside
      aria-label={t(($) => {
        return $.chat.automations.title;
      })}
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
      data-testid="automation-sidebar"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">
            {t(($) => {
              return $.chat.automations.title;
            })}
          </div>
        </div>
        <Button
          showTooltip
          type="button"
          onClick={onClose}
          aria-label={t(($) => {
            return $.chat.automations.close;
          })}
          variant="quiet"
          size="icon-sm"
        >
          <X size={16} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="grid gap-3">
            <Skeleton className="h-36 rounded-lg" />
            <Skeleton className="h-36 rounded-lg" />
          </div>
        ) : isEmpty ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.automations.empty;
            })}
          </div>
        ) : (
          <div className="grid gap-3">
            {workflowAutomations.map((automation) => {
              return (
                <HeaderWorkflowAutomationCard
                  key={automation.id}
                  automation={automation}
                  headerAutomations={thread.headerAutomations}
                  threadSidebar={thread.sidebar}
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
// SessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

function ChatThreadAppSkeletonHandoff({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const initialEventsReady = useGet(thread.initialEventsReady$);
  const hideAppSkeletonOnContentReadyRef = useSet(
    hideAppSkeletonOnContentReadyRef$,
  );
  if (!initialEventsReady) {
    return null;
  }
  return <span ref={hideAppSkeletonOnContentReadyRef} hidden />;
}

function ChatThread({
  isMain,
  thread,
}: {
  isMain?: boolean;
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const setContainerRef = useSet(
    isMain ? thread.setMainContainerRef$ : thread.setContainerRef$,
  );

  return (
    <section
      aria-label={t(($) => {
        return $.chat.thread.ariaLabel;
      })}
      className="flex min-w-0 basis-0 flex-1 flex-col min-h-0 bg-transparent focus:outline-none"
      data-chat-thread-container-id={thread.threadId}
      ref={setContainerRef}
      tabIndex={-1}
    >
      <ChatThreadContent thread={thread} />
      {isMain ? <ChatThreadAppSkeletonHandoff thread={thread} /> : null}
    </section>
  );
}

function MissingChatThread({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return $.chat.thread.ariaLabel;
      })}
      className="flex min-w-0 basis-0 flex-1 flex-col min-h-0 bg-transparent focus:outline-none"
      data-chat-thread-container-id={threadId}
      tabIndex={-1}
    >
      <ChatThreadNotFound />
    </section>
  );
}

function ChatThreadPane({
  isMain,
  pane,
}: {
  isMain?: boolean;
  pane: Exclude<ChatThreadPaneState, null>;
}) {
  return pane.kind === "thread" ? (
    <ChatThread isMain={isMain} thread={pane.thread} />
  ) : (
    <MissingChatThread threadId={pane.threadId} />
  );
}

function ChatThreadArea({
  leftPane,
  rightPane,
}: {
  leftPane: ChatThreadPaneState;
  rightPane: ChatThreadPaneState;
}) {
  const setKeyboardScrollRoot = useSet(setChatKeyboardScrollRoot$);

  return (
    <div
      ref={setKeyboardScrollRoot}
      className="flex w-full flex-1 min-w-0 min-h-0 bg-transparent"
    >
      {leftPane && <ChatThreadPane isMain pane={leftPane} />}
      {rightPane && (
        <>
          <div className="w-px shrink-0 bg-border/60" aria-hidden="true" />
          <ChatThreadPane pane={rightPane} />
        </>
      )}
    </div>
  );
}

function ThreadAutomationsSidebarSlot({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const close = useSet(thread.sidebar.close$);
  return <HeaderAutomationSidebar thread={thread} onClose={close} />;
}

export function ChatThreadPage() {
  const activeThreadSidebar = useGet(activeThreadSidebar$);
  const leftPane = useGet(currentLeftPane$);
  const rightPane = useGet(currentRightPane$);
  return (
    <>
      <ChatThreadSidebarShell
        animateEntry={activeThreadSidebar?.animateEntry ?? true}
        open={activeThreadSidebar !== null}
        sidebar={
          activeThreadSidebar ? (
            activeThreadSidebar.target.type === "automations" ? (
              <ThreadAutomationsSidebarSlot
                thread={activeThreadSidebar.thread}
              />
            ) : (
              <ThreadSidebarSlot
                thread={activeThreadSidebar.thread}
                target={activeThreadSidebar.target}
              />
            )
          ) : null
        }
      >
        <ChatThreadArea leftPane={leftPane} rightPane={rightPane} />
      </ChatThreadSidebarShell>
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
      : i18n.t(($) => {
          return $.chat.errors.loadMessages;
        });
  }
  return null;
}

const CHAT_RENDER_LOAD_MORE_TOP_THRESHOLD_PX = 100;

function renderedChatEventKeys(
  groups: readonly ChatEventGroup[],
): readonly string[] {
  return groups.flatMap((group) => {
    return group.events.map((event) => {
      return `${event.id}:${event.isQueued ? "queued" : "active"}`;
    });
  });
}

function chatGroupsContainEvent(
  groups: readonly ChatEventGroup[],
  eventId: string | undefined,
): boolean {
  return groups.some((group) => {
    return group.events.some((event) => {
      return event.id === eventId;
    });
  });
}

function ChatThreadScrollCommitMarker({
  thread,
  renderedGroups,
}: {
  thread: ChatPanelSignals;
  renderedGroups: ChatEventGroup[] | undefined;
}) {
  const readyScrollRequestLoadable = useLoadable(
    thread.readyScrollAfterRenderRequest$,
  );
  const commitScroll = useSet(thread.scrollCommitOnRef$);
  if (
    renderedGroups === undefined ||
    readyScrollRequestLoadable.state !== "hasData" ||
    readyScrollRequestLoadable.data === null
  ) {
    return null;
  }

  const readyScrollRequest = readyScrollRequestLoadable.data;
  if (
    !equalArrays(
      readyScrollRequest.renderedEventKeys,
      renderedChatEventKeys(renderedGroups),
    )
  ) {
    return null;
  }

  const { activeGroups, queuedGroups } =
    splitQueuedEventsForThinkingIndicator(renderedGroups);
  const { request } = readyScrollRequest;
  const targetEventId = request.position?.targetEventId;
  const activeTargetRendered = chatGroupsContainEvent(
    activeGroups,
    targetEventId,
  );
  const targetMovedToQueue = chatGroupsContainEvent(
    queuedGroups,
    targetEventId,
  );
  const activeEventsRendered = activeGroups.some((group) => {
    return group.events.length > 0;
  });
  if (
    !activeEventsRendered ||
    (request.position !== null && !activeTargetRendered && !targetMovedToQueue)
  ) {
    return null;
  }

  const commitToTail = request.position === null || targetMovedToQueue;
  return (
    <span
      key={request.revision}
      ref={commitScroll}
      data-chat-scroll-commit-revision={request.revision}
      data-chat-scroll-commit-to-tail={commitToTail ? "" : undefined}
      aria-hidden
      className="hidden"
    />
  );
}

function ChatThreadRenderedEventGroups({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const resolvedRenderedGroups = useLastResolved(
    thread.visibleRenderedChatGroups$,
    { equalityFn: equalArrays },
  );
  const renderedGroups = resolvedRenderedGroups ?? [];
  const { activeGroups: renderedActiveGroups } =
    splitQueuedEventsForThinkingIndicator(renderedGroups);
  const modelChanges = modelChangesByEventId(renderedActiveGroups);
  const scrollTargetEventId =
    useGet(thread.threadScrollPosition$)?.targetEventId ?? null;
  const runWorkFoldingEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatRunWorkFolding] ?? false;
  const runGroupExpansionOverrides = useGet(runGroupExpansionOverrides$);
  const toggleRunGroupExpanded = useSet(toggleRunGroupExpanded$);
  const runGroupFolding = buildRunGroupFolding(
    renderedActiveGroups,
    runGroupExpansionOverrides,
    scrollTargetEventId,
    { preserveGoalRunsForWorkFolding: runWorkFoldingEnabled },
  );
  const runGroupVisibleGroups =
    runGroupFolding?.visibleGroups ?? renderedActiveGroups;
  const completedWorkFolding = runWorkFoldingEnabled
    ? null
    : buildCompletedWorkFolding(runGroupVisibleGroups);
  const completedWorkExpandedKeys = useGet(completedWorkExpandedKeys$);
  const effectiveCompletedWorkExpandedKeys =
    completedWorkExpandedKeysForScrollTarget(
      completedWorkFolding,
      completedWorkExpandedKeys,
      scrollTargetEventId,
    );
  const toggleCompletedWorkExpanded = useSet(toggleCompletedWorkExpanded$);
  const runWorkFolding = runWorkFoldingEnabled
    ? buildRunWorkFolding(runGroupVisibleGroups, new Set(modelChanges.keys()))
    : null;
  const runWorkExpandedKeys = useGet(runWorkExpandedKeys$);
  const effectiveRunWorkExpandedKeys = runWorkExpandedKeysForScrollTarget(
    runWorkFolding,
    runWorkExpandedKeys,
    scrollTargetEventId,
  );
  const toggleRunWorkExpanded = useSet(toggleRunWorkExpanded$);
  const visibleGroups = runWorkFoldingEnabled
    ? (runWorkFolding?.visibleGroups ?? runGroupVisibleGroups)
    : (completedWorkFolding?.visibleGroups ?? runGroupVisibleGroups);
  const thinkingIndicatorMode =
    useLastResolved(thread.thinkingIndicatorMode$) ?? null;
  const runGroupFoldPlacements = resolveRunGroupFoldPlacements({
    groups: visibleGroups,
    runGroupFolding,
    onToggleRunGroup: toggleRunGroupExpanded,
    thinkingIndicatorCanHostFold:
      thinkingIndicatorMode === "waiting" ||
      thinkingIndicatorMode === "waiting-queued",
  });

  return (
    <>
      <ChatThreadEventGroups
        thread={thread}
        groups={visibleGroups}
        modelChanges={modelChanges}
        runGroupFoldPlacements={runGroupFoldPlacements}
        runWorkFoldingEnabled={runWorkFoldingEnabled}
        completedWorkFolding={completedWorkFolding}
        completedWorkExpandedKeys={effectiveCompletedWorkExpandedKeys}
        onToggleCompletedWork={toggleCompletedWorkExpanded}
        runWorkFolding={runWorkFolding}
        runWorkExpandedKeys={effectiveRunWorkExpandedKeys}
        onToggleRunWork={toggleRunWorkExpanded}
      />
      <ChatThreadScrollCommitMarker
        thread={thread}
        renderedGroups={resolvedRenderedGroups}
      />
      <ChatThreadThinkingIndicator
        thread={thread}
        mode={thinkingIndicatorMode}
        runGroupFolds={runGroupFoldPlacements.thinkingIndicatorRunGroupFolds}
      />
    </>
  );
}

function ChatThreadSessionError({ thread }: { thread: ChatPanelSignals }) {
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
        <AlertCircle size={16} />
        <p className="text-sm">{sessionError}</p>
      </div>
    </div>
  );
}

function ChatThreadEmptyState({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const initialEventsReady = useGet(thread.initialEventsReady$);
  const hasEvents = useLastResolved(thread.hasEvents$);
  if (!initialEventsReady || hasEvents !== false) {
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
        {t(($) => {
          return $.chat.thread.empty;
        })}
      </p>
    </div>
  );
}

function ChatThreadEventsMain({ thread }: { thread: ChatPanelSignals }) {
  const renderedGroupsReady =
    useLastResolved(thread.visibleRenderedChatGroupsReady$) ?? false;
  const scrollContentOnRef = useSet(thread.scrollContentOnRef$);
  const sharingPhase = useGet(thread.sharing.phase$);

  return (
    <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
      <div
        ref={scrollContentOnRef}
        data-message-container
        className={cn(
          CHAT_THREAD_MESSAGE_LIST_CLASS,
          sharingPhase !== "idle" && "pr-10 lg:pr-0",
        )}
        style={{ visibility: renderedGroupsReady ? "visible" : "hidden" }}
      >
        <ChatThreadSessionError thread={thread} />
        <ChatThreadEmptyState thread={thread} />
        <ChatThreadRenderedEventGroups thread={thread} />
        <ChatThreadNextRunModelNotice thread={thread} />
      </div>
    </main>
  );
}

function ChatThreadThinkingIndicator({
  thread,
  mode,
  runGroupFolds,
}: {
  thread: ChatPanelSignals;
  mode: ThinkingIndicatorMode;
  runGroupFolds: readonly RunGroupFoldControl[];
}) {
  return (
    <ThinkingIndicator
      thread={thread}
      mode={mode}
      runGroupFolds={runGroupFolds}
    />
  );
}

function ChatThreadNextRunModelNotice({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const selectedSelection = useLastResolved(
    thread.composer.model.modelSelection$,
  );
  const runningSelection = useLastResolved(
    thread.composer.model.runningModelSelection$,
  );
  if (
    selectedSelection === undefined ||
    selectedSelection === null ||
    runningSelection === undefined ||
    runningSelection === null
  ) {
    return null;
  }

  const selectedRunSelection: ChatRunModelSelection = {
    selectedModel: selectedSelection.selectedModel,
    ...(selectedSelection.codexServiceTier === "fast"
      ? { serviceTier: "priority" as const }
      : {}),
  };
  let label: string;
  if (selectedRunSelection.selectedModel !== runningSelection.selectedModel) {
    label = t(
      ($) => {
        return $.chat.run.selectedModelAppliesAfterCurrentRun;
      },
      { model: runModelDisplayName(t, selectedRunSelection) },
    );
  } else if (
    fastModeEnabled(selectedRunSelection) !== fastModeEnabled(runningSelection)
  ) {
    label = fastModeEnabled(selectedRunSelection)
      ? t(($) => {
          return $.chat.run.fastModeWillBeOn;
        })
      : t(($) => {
          return $.chat.run.fastModeWillBeOff;
        });
  } else {
    return null;
  }
  return <RunSectionDividerRow label={label} announce />;
}

// An assistant group whose events are all bookkeeping — a run's terminal event,
// usage — puts nothing on screen, so it must not break a stack of user
// messages that visually sit right on top of each other.
function groupRendersContent(
  group: ChatEventGroup,
  embeddedFolds: readonly RunGroupFoldControl[],
  completedWorkFold: CompletedWorkFold | null,
  runWorkSection: RunWorkSection | null,
): boolean {
  if (
    embeddedFolds.length > 0 ||
    completedWorkFold !== null ||
    runWorkSection !== null
  ) {
    return true;
  }
  if (group.role === "user") {
    return group.events.some(rendersUserBubble);
  }
  return group.events.some(isRenderableAssistantEvent);
}

// A user group can be on screen for its fold alone, with every message in it
// rendering as a card or as nothing, and there is no bubble to stack against.
function groupHasUserBubble(group: ChatEventGroup): boolean {
  return group.events.some(rendersUserBubble);
}

function ChatThreadEventGroups({
  thread,
  groups,
  modelChanges,
  runGroupFoldPlacements,
  runWorkFoldingEnabled,
  completedWorkFolding,
  completedWorkExpandedKeys,
  onToggleCompletedWork,
  runWorkFolding,
  runWorkExpandedKeys,
  onToggleRunWork,
}: {
  thread: ChatPanelSignals;
  groups: readonly ChatEventGroup[];
  modelChanges: ReadonlyMap<string, RunModelChange>;
  runGroupFoldPlacements: RunGroupFoldPlacements;
  runWorkFoldingEnabled: boolean;
  completedWorkFolding: CompletedWorkFolding | null;
  completedWorkExpandedKeys: ReadonlySet<string>;
  onToggleCompletedWork: (key: string) => void;
  runWorkFolding: RunWorkFolding | null;
  runWorkExpandedKeys: ReadonlySet<string>;
  onToggleRunWork: (key: string) => void;
}) {
  const { embeddedRunGroupFolds, externalRunGroupFolds } =
    runGroupFoldPlacements;
  // A run that ends re-forms the groups around it, so the messages the user
  // sent back to back can land in separate groups with nothing rendered in
  // between. Tracking the last group that actually put something on screen
  // keeps the stack from springing open the moment a run finishes.
  let previousVisibleGroup: ChatEventGroup | undefined;

  return (
    <>
      {groups.map((group) => {
        const runGroupFolds =
          externalRunGroupFolds.get(group.beginEventId) ?? [];
        const embeddedFolds =
          embeddedRunGroupFolds.get(group.beginEventId) ?? [];
        const completedWorkFold = runWorkFoldingEnabled
          ? null
          : completedWorkFoldForGroup(completedWorkFolding, group);
        const runWorkSection = runWorkFoldingEnabled
          ? runWorkSectionForGroup(runWorkFolding, group)
          : null;
        const stackFirstOnPrevious =
          runGroupFolds.length === 0 &&
          previousVisibleGroup !== undefined &&
          previousVisibleGroup.role === "user" &&
          groupHasUserBubble(previousVisibleGroup);
        if (
          groupRendersContent(
            group,
            embeddedFolds,
            completedWorkFold,
            runWorkSection,
          )
        ) {
          previousVisibleGroup = group;
        }
        const completedWorkExpanded =
          completedWorkFold !== null &&
          completedWorkExpandedKeys.has(completedWorkFold.key);
        const runWorkExpanded =
          runWorkSection !== null &&
          runWorkExpandedKeys.has(runWorkSection.key);
        return (
          <div key={group.beginEventId} className="contents">
            {runGroupFolds.map((runGroupFold) => {
              return (
                <RunGroupFoldRow
                  key={runGroupFold.fold.key}
                  control={runGroupFold}
                />
              );
            })}
            <SelectablePagedGroupRow
              group={group}
              thread={thread}
              modelChanges={modelChanges}
              stackFirstOnPrevious={stackFirstOnPrevious}
              runGroupFolds={embeddedFolds}
              completedWorkFold={
                completedWorkFold !== null
                  ? {
                      groups: completedWorkFold.labelGroups,
                      hiddenGroups: completedWorkFold.hiddenGroups,
                      expanded: completedWorkExpanded,
                      onToggle: () => {
                        if (!completedWorkExpanded) {
                          captureChatWorkHistoryExpanded({
                            workStatus: "completed",
                          });
                        }
                        onToggleCompletedWork(completedWorkFold.key);
                      },
                    }
                  : undefined
              }
              runWorkSection={
                runWorkSection !== null
                  ? {
                      anchorEventId: runWorkSection.anchorEventId,
                      startTime: runWorkSection.startTime,
                      endTime: runWorkSection.endTime,
                      hiddenGroups: runWorkSection.hiddenGroups,
                      hiddenGroupsAfterAnchor:
                        runWorkSection.hiddenGroupsAfterAnchor,
                      expanded: runWorkExpanded,
                      onToggle: () => {
                        if (!runWorkExpanded) {
                          captureChatWorkHistoryExpanded({
                            workStatus:
                              runWorkSection.endTime === undefined
                                ? "active"
                                : "completed",
                          });
                        }
                        onToggleRunWork(runWorkSection.key);
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

interface RunGroupFoldPlacements {
  embeddedRunGroupFolds: Map<string, RunGroupFoldControl[]>;
  externalRunGroupFolds: Map<string, RunGroupFoldControl[]>;
  thinkingIndicatorRunGroupFolds: RunGroupFoldControl[];
}

function resolveRunGroupFoldPlacements({
  groups,
  runGroupFolding,
  onToggleRunGroup,
  thinkingIndicatorCanHostFold,
}: {
  groups: readonly ChatEventGroup[];
  runGroupFolding: RunGroupFolding | null;
  onToggleRunGroup: (key: string, expanded: boolean) => void;
  thinkingIndicatorCanHostFold: boolean;
}): RunGroupFoldPlacements {
  const embeddedRunGroupFolds = new Map<string, RunGroupFoldControl[]>();
  const externalRunGroupFolds = new Map<string, RunGroupFoldControl[]>();
  const thinkingIndicatorRunGroupFolds: RunGroupFoldControl[] = [];

  if (runGroupFolding === null) {
    return {
      embeddedRunGroupFolds,
      externalRunGroupFolds,
      thinkingIndicatorRunGroupFolds,
    };
  }

  for (const [index, group] of groups.entries()) {
    const folds = runGroupFolding.foldsByNextGroupId.get(group.beginEventId);
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
      if (
        !control.expanded &&
        isGoalGroupFold(fold) &&
        thinkingIndicatorCanHostFold &&
        waitingIndicatorCanHostCollapsedRunGroupFold(groups, index)
      ) {
        thinkingIndicatorRunGroupFolds.push(control);
        continue;
      }
      const embeddedGroupId = control.expanded
        ? undefined
        : inlineGroupIdForCollapsedRunGroupFold(groups, index);
      const target = embeddedGroupId
        ? embeddedRunGroupFolds
        : externalRunGroupFolds;
      const targetGroupId = embeddedGroupId ?? group.beginEventId;
      const existing = target.get(targetGroupId);
      if (existing) {
        existing.push(control);
      } else {
        target.set(targetGroupId, [control]);
      }
    }
  }

  return {
    embeddedRunGroupFolds,
    externalRunGroupFolds,
    thinkingIndicatorRunGroupFolds,
  };
}

function waitingIndicatorCanHostCollapsedRunGroupFold(
  groups: readonly ChatEventGroup[],
  index: number,
): boolean {
  const group = groups[index];
  if (!group || group.role !== "user") {
    return false;
  }
  const runId = firstRunIdForEvents(group.events);
  if (runId === undefined) {
    return false;
  }
  for (const candidate of groups.slice(index + 1)) {
    const candidateRunId = firstRunIdForEvents(candidate.events);
    if (candidateRunId !== undefined && candidateRunId !== runId) {
      return false;
    }
    if (
      candidateRunId === runId &&
      candidate.role === "assistant" &&
      candidate.events.some(isRenderableAssistantEvent)
    ) {
      return false;
    }
  }
  return true;
}

function inlineGroupIdForCollapsedRunGroupFold(
  groups: readonly ChatEventGroup[],
  index: number,
): string | undefined {
  const group = groups[index];
  if (!group || group.role !== "user") {
    return undefined;
  }
  if (firstRunIdForEvents(group.events) === undefined) {
    return undefined;
  }
  return (
    assistantGroupIdForCollapsedRunGroupFold(groups, index) ??
    group.beginEventId
  );
}

function assistantGroupIdForCollapsedRunGroupFold(
  groups: readonly ChatEventGroup[],
  index: number,
): string | undefined {
  const group = groups[index];
  if (!group || group.role !== "user") {
    return undefined;
  }
  const runId = firstRunIdForEvents(group.events);
  if (runId === undefined) {
    return undefined;
  }

  for (let nextIndex = index + 1; nextIndex < groups.length; nextIndex++) {
    const candidate = groups[nextIndex]!;
    const candidateRunId = firstRunIdForEvents(candidate.events);
    if (candidateRunId !== runId) {
      return undefined;
    }
    if (candidate.role === "assistant") {
      return candidate.beginEventId;
    }
  }

  return undefined;
}

function firstRunIdForEvents(
  events: readonly EnrichedChatEvent[],
): string | undefined {
  return events.find((event) => {
    return event.runId !== undefined;
  })?.runId;
}

function parseEventTime(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatCompactDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return i18n.t(
      ($) => {
        return $.chat.run.duration.secondsShort;
      },
      {
        count: totalSeconds,
      },
    );
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return i18n.t(
      ($) => {
        return $.chat.run.duration.minutesShort;
      },
      {
        count: totalMinutes,
      },
    );
  }
  const totalHours = Math.round(totalMinutes / 60);
  return i18n.t(
    ($) => {
      return $.chat.run.duration.hoursShort;
    },
    { count: totalHours },
  );
}

function durationLabelForGroups(
  groups: readonly ChatEventGroup[],
): string | null {
  const timestamps = groups.flatMap((group) => {
    return group.events.flatMap((event) => {
      const timestamp = parseEventTime(event.createdAt);
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

function completedWorkLabel(groups: readonly ChatEventGroup[]): string {
  const duration = durationLabelForGroups(groups);
  return duration
    ? i18n.t(
        ($) => {
          return $.chat.run.workedFor;
        },
        { duration },
      )
    : i18n.t(($) => {
        return $.chat.run.worked;
      });
}

const RUN_SECTION_LABEL_CLASS =
  "min-w-0 max-w-full shrink-0 break-words font-serif text-[13px] italic text-muted-foreground/50";
const RUN_SECTION_ROW_CLASS =
  "-mt-5 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start";

function RunSectionDivider({
  label,
  labelPosition = "left",
}: {
  label: string;
  labelPosition?: "left" | "right";
}) {
  return (
    <div
      className={cn(
        "flex min-h-5 items-center gap-2",
        labelPosition === "right" && "flex-row-reverse",
      )}
    >
      <p
        className={cn(
          RUN_SECTION_LABEL_CLASS,
          labelPosition === "right" && "text-right",
        )}
      >
        {label}
      </p>
      <div role="separator" className="h-px flex-1 bg-border/40" />
    </div>
  );
}

function RunSectionDividerRow({
  label,
  announce = false,
}: {
  label: string;
  announce?: boolean;
}) {
  return (
    <div
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
      className={RUN_SECTION_ROW_CLASS}
    >
      <div className="hidden @[900px]:block" />
      <div className="min-w-0">
        <RunSectionDivider label={label} labelPosition="right" />
      </div>
    </div>
  );
}

function ModelChangeDividerRow({ change }: { change: RunModelChange }) {
  const { t } = useTranslation();
  return <RunSectionDividerRow label={modelChangeLabel(t, change)} />;
}

function modelChangeLabel(
  t: TFunction<"common">,
  change: RunModelChange,
): string {
  return change.kind === "model"
    ? t(
        ($) => {
          return $.chat.run.modelChangedTo;
        },
        { model: runModelDisplayName(t, change.selection) },
      )
    : change.enabled
      ? t(($) => {
          return $.chat.run.fastModeOn;
        })
      : t(($) => {
          return $.chat.run.fastModeOff;
        });
}

function FoldedModelChangeDivider({ change }: { change: RunModelChange }) {
  const { t } = useTranslation();
  return (
    <RunSectionDivider
      label={modelChangeLabel(t, change)}
      labelPosition="right"
    />
  );
}

function CompletedWorkFoldRow({
  groups,
  expanded,
  onToggle,
}: {
  groups: readonly ChatEventGroup[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = completedWorkLabel(groups);
  return (
    <div data-chat-completed-work-fold className="-mx-2 @[900px]:-mb-[15px]">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={
          expanded
            ? t(($) => {
                return $.chat.run.collapseWorkHistory;
              })
            : t(($) => {
                return $.chat.run.expandWorkHistory;
              })
        }
        onClick={onToggle}
        className="mt-1.5 inline-flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:bg-state-hover"
      >
        <Hourglass aria-hidden size={14} className="shrink-0" />
        <span className="text-[13px]">{label}</span>
        <ChevronRight
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

function RunWorkSectionRow({
  startTime,
  endTime,
  collapsible,
  expanded,
  onToggle,
}: {
  startTime: number;
  endTime?: number;
  collapsible: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const content = (
    <>
      <Hourglass aria-hidden size={14} className="shrink-0" />
      <ElapsedTime
        startTime={startTime}
        endTime={endTime}
        className="text-[13px]"
      >
        {(elapsedTime) => {
          const duration = formatCompactDuration(
            Math.max(1, Math.round(elapsedTime / 1000)),
          );
          return endTime === undefined
            ? t(
                ($) => {
                  return $.chat.run.workingFor;
                },
                { duration },
              )
            : t(
                ($) => {
                  return $.chat.run.workedFor;
                },
                { duration },
              );
        }}
      </ElapsedTime>
      {collapsible ? (
        <ChevronRight
          aria-hidden
          size={14}
          className={cn(
            "shrink-0 text-muted-foreground/70 transition-transform",
            expanded && "rotate-90",
          )}
        />
      ) : null}
    </>
  );
  const className =
    "mt-1.5 inline-flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground";
  return (
    <div data-chat-run-work className="-mx-2 @[900px]:-mb-[15px]">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t(($) => {
                  return $.chat.run.collapseWorkHistory;
                })
              : t(($) => {
                  return $.chat.run.expandWorkHistory;
                })
          }
          onClick={onToggle}
          className={cn(className, "transition-colors hover:bg-state-hover")}
        >
          {content}
        </button>
      ) : (
        <div className={className}>{content}</div>
      )}
    </div>
  );
}

function normalizedInlineLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function runGroupFoldEvents(fold: RunGroupFold): EnrichedChatEvent[] {
  return fold.labelGroups.flatMap((group) => {
    return group.events;
  });
}

function runGroupFoldSourceLabel(fold: RunGroupFold): string {
  const events = runGroupFoldEvents(fold);
  const workflowLabel = runGroupFoldWorkflowLabel(fold);
  if (workflowLabel) {
    return workflowLabel;
  }
  for (const event of events) {
    if (!isInputChatEvent(event)) {
      continue;
    }
    const content = messageDocumentToDisplayText(event.userMessage);
    if (content?.trim()) {
      return normalizedInlineLabel(content);
    }
  }
  return i18n.t(($) => {
    return $.chat.run.automatedRun;
  });
}

function runGroupFoldWorkflowLabel(fold: RunGroupFold): string | null {
  for (const event of runGroupFoldEvents(fold)) {
    const part = eventNonContentPart(event);
    const label =
      part?.type === "automation"
        ? part.automationBrief?.trim() || part.workflowName.trim()
        : null;
    if (label) {
      return normalizedInlineLabel(label);
    }
  }
  return null;
}

function runGroupFoldGoalLabel(fold: RunGroupFold): string {
  const goalInputEvent = runGroupFoldEvents(fold).find(isGoalUserMessage);
  const part = goalInputEvent ? eventNonContentPart(goalInputEvent) : undefined;
  const content = part?.type === "goal" ? part.goalBrief.trim() : null;
  return content
    ? normalizedInlineLabel(content)
    : i18n
        .t(($) => {
          return $.chat.queue.goal;
        })
        .toLocaleLowerCase(i18n.resolvedLanguage);
}

function isRejectedGoalUserMessage(event: EnrichedChatEvent): boolean {
  return (
    event.eventType === "input.rejected" &&
    eventNonContentPart(event)?.type === "goal"
  );
}

function isGoalUserMessage(
  event: EnrichedChatEvent,
): event is EnrichedChatEvent & ChatInputEvent {
  return (
    isInputChatEvent(event) &&
    !isRejectedGoalUserMessage(event) &&
    eventNonContentPart(event)?.type === "goal"
  );
}

function isGoalGroupFold(fold: RunGroupFold): boolean {
  return fold.labelGroups.some((group) => {
    return group.events.some(isGoalUserMessage);
  });
}

function verboseDurationLabelForRunGroupFold(
  fold: RunGroupFold,
): string | null {
  const timestamps = fold.labelGroups.flatMap((group) => {
    return group.events.flatMap((event) => {
      if (event.runGroupId !== fold.runGroupId) {
        return [];
      }
      const timestamp = parseEventTime(event.createdAt);
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
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.run.duration.hour;
        },
        {
          count: hours,
        },
      ),
    );
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(
      i18n.t(
        ($) => {
          return $.chat.run.duration.minute;
        },
        {
          count: minutes,
        },
      ),
    );
  }
  return parts.join(" ");
}

function runGroupFoldLabel(fold: RunGroupFold): string {
  if (isGoalGroupFold(fold)) {
    const duration = verboseDurationLabelForRunGroupFold(fold);
    const label = runGroupFoldGoalLabel(fold);
    return duration
      ? i18n.t(
          ($) => {
            return $.chat.run.durationFor;
          },
          { duration, label },
        )
      : i18n.t(
          ($) => {
            return $.chat.run.goalFor;
          },
          { label },
        );
  }
  const sourceLabel = runGroupFoldSourceLabel(fold);
  return i18n.t(
    ($) => {
      return $.chat.run.groupedRunsFor;
    },
    {
      count: fold.hiddenRunCount,
      source: sourceLabel,
    },
  );
}

function RunGroupFoldRow({
  control,
  embedded = false,
}: {
  control: RunGroupFoldControl;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const { fold, expanded, onToggle } = control;
  const label = runGroupFoldLabel(fold);
  const isGoal = isGoalGroupFold(fold);
  const Icon = isGoal ? Target : Package;
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
            ? t(($) => {
                return $.chat.run.collapseGroupedHistory;
              })
            : t(($) => {
                return $.chat.run.expandGroupedHistory;
              })
        }
        onClick={onToggle}
        className={cn(
          "inline-flex min-h-9 max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-muted-foreground transition-colors hover:bg-state-hover",
          embedded && "mt-1.5",
        )}
      >
        <Icon aria-hidden size={14} className="shrink-0" />
        <span className="min-w-0 truncate whitespace-nowrap text-[13px]">
          {label}
        </span>
        <ChevronRight
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

function ChatThreadSkeletonOverlay({ thread }: { thread: ChatPanelSignals }) {
  const initialEventsReady = useGet(thread.initialEventsReady$);
  if (initialEventsReady) {
    return null;
  }

  return (
    <div
      data-chat-skeleton
      className="absolute inset-0 z-10 overflow-hidden pointer-events-none bg-background"
    >
      <main className={CHAT_THREAD_CONTENT_MAIN_CLASS}>
        <div
          className={cn(
            "zero-chat-skeleton-reveal",
            CHAT_THREAD_MESSAGE_LIST_CLASS,
          )}
        >
          <ChatSkeleton />
        </div>
      </main>
    </div>
  );
}

function ChatThreadEventsPane({ thread }: { thread: ChatPanelSignals }) {
  const scrollContainerOnRef = useSet(thread.scrollContainerOnRef$);
  const loadMoreRenderedChatGroups = useSet(thread.loadMoreRenderedChatGroups$);
  const pageSignal = useGet(pageSignal$);
  const standalonePwa = isStandalonePwa();

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
        ref={scrollContainerOnRef}
        data-scroll-container
        tabIndex={-1}
        onScroll={handleScroll}
        className={cn(
          "absolute inset-0 overflow-y-auto focus:outline-none [overflow-anchor:none] [scrollbar-gutter:stable]",
          standalonePwa && "overscroll-contain",
        )}
      >
        <ChatThreadEventsMain thread={thread} />
      </div>
      <ChatThreadSkeletonOverlay thread={thread} />
      <ScrollToBottomButton thread={thread} />
      <ChatConversationLocator thread={thread} />
    </div>
  );
}

function ChatThreadNotFound() {
  const { t } = useTranslation();
  return (
    <main
      data-chat-thread-not-found
      className="flex min-h-0 flex-1 items-center justify-center px-6 py-16 text-center"
    >
      <h1 className="text-lg font-semibold text-foreground">
        {t(($) => {
          return $.chat.thread.notFound;
        })}
      </h1>
    </main>
  );
}

function ChatThreadContent({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const threadMeta = useGet(thread.threadMeta$);
  if (!threadMeta) {
    return <ChatThreadNotFound />;
  }

  return (
    <>
      <ChatThreadHeader thread={thread} />

      <div className="relative min-h-0 flex-1">
        <div className="flex h-full min-w-0 flex-col">
          <ChatThreadEventsPane thread={thread} />
          <ChatThreadBottomBar thread={thread} />
        </div>
      </div>

      <ChatFeedbackSelection
        feedback={thread.feedback}
        sourceAgentId={threadMeta.agentId}
        sourceThreadTitle={
          threadMeta.title ??
          t(($) => {
            return $.chat.newChat;
          })
        }
      />
    </>
  );
}

function ChatThreadBottomBar({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const selectedCount = useGet(thread.sharing.selectedCount$);
  const sharedThreadId = useGet(thread.sharing.createdSharedThreadId$);
  const close = useSet(thread.sharing.close$);
  const pageSignal = useGet(pageSignal$);
  const [createLoadable, createSharedThread] = useLoadableSet(
    thread.sharing.create$,
  );
  if (phase === "idle") {
    return <ChatThreadComposer thread={thread} />;
  }

  const creating = createLoadable.state === "loading";
  const shareUrl = sharedThreadId
    ? `${window.location.origin}/share/threads/${sharedThreadId}`
    : null;
  return (
    <footer className="relative shrink-0 border-t border-border/60 bg-background px-4 py-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-2">
        {shareUrl ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              readOnly
              value={shareUrl}
              aria-label={t(($) => {
                return $.chat.sharing.shareLink;
              })}
              className="min-w-0 flex-1"
            />
            <div className="flex shrink-0 items-center gap-2">
              <Button
                onClick={() => {
                  detach(
                    (async () => {
                      const copied = await writeToClipboard(shareUrl);
                      if (copied) {
                        toast.success(
                          t(($) => {
                            return $.chat.sharing.linkCopied;
                          }),
                        );
                        return;
                      }
                      toast.error(
                        t(($) => {
                          return $.chat.sharing.copyFailed;
                        }),
                      );
                    })(),
                    Reason.DomCallback,
                    "copy shared thread link",
                  );
                }}
              >
                <Copy size={16} />
                {t(($) => {
                  return $.chat.sharing.copyLink;
                })}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  detach(
                    close(pageSignal),
                    Reason.DomCallback,
                    "close shared thread selection",
                  );
                }}
              >
                {t(($) => {
                  return $.chat.sharing.close;
                })}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t(
                  ($) => {
                    return $.chat.sharing.selectedCount;
                  },
                  { count: selectedCount },
                )}
              </p>
              {createLoadable.state === "hasError" ? (
                <p className="mt-0.5 text-xs text-destructive">
                  {t(($) => {
                    return $.chat.sharing.createFailed;
                  })}
                </p>
              ) : null}
            </div>
            <Button
              disabled={selectedCount === 0 || creating}
              onClick={() => {
                detach(
                  createSharedThread(pageSignal),
                  Reason.DomCallback,
                  "create shared thread",
                );
              }}
            >
              {creating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Share2 size={16} />
              )}
              {t(($) => {
                return $.chat.sharing.create;
              })}
            </Button>
          </div>
        )}
      </div>
    </footer>
  );
}

function ScrollToBottomButton({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const awayFromBottom = useGet(thread.awayFromBottom$);
  const scrollToBottom = useSet(thread.scrollToBottom$);
  const pageSignal = useGet(pageSignal$);
  const renderedGroupsReadyLoadable = useLastLoadable(
    thread.visibleRenderedChatGroupsReady$,
  );
  const sessionError = resolveSessionError(renderedGroupsReadyLoadable);
  const skeletonVisible = renderedGroupsReadyLoadable.state === "loading";

  if (!awayFromBottom || skeletonVisible || sessionError) {
    return null;
  }

  return (
    <IconTooltipButton
      type="button"
      data-scroll-to-bottom
      aria-label={t(($) => {
        return $.chat.thread.scrollToBottom;
      })}
      onClick={() => {
        detach(scrollToBottom(pageSignal), Reason.DomCallback);
      }}
      className="absolute bottom-4 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-background-hover hover:text-foreground"
    >
      <ArrowDown size={18} />
    </IconTooltipButton>
  );
}

function RecommendedFollowupIcon({
  followup,
}: {
  followup: RecommendedFollowup;
}) {
  if (followup.kind !== "generate") {
    return <MessageCircle size={14} />;
  }

  if (followup.generationType === "image") {
    return <Image size={14} />;
  }
  if (followup.generationType === "video") {
    return <Video size={14} />;
  }
  if (followup.generationType === "presentation") {
    return <ChartLine size={14} />;
  }
  if (followup.generationType === "website") {
    return <LinkIcon size={14} />;
  }
  return <Package size={14} />;
}

function recommendedFollowupShownKey(
  source: RecommendedFollowupSource,
): string {
  return [
    source.eventId,
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
  if (element.dataset.followupsShownKey === shownKey) {
    return;
  }
  element.dataset.followupsShownKey = shownKey;

  captureRecommendedFollowupsShown({
    messageId: source.eventId,
    followups: source.followups,
  });
}

function RecommendedFollowupList({
  thread,
  source,
}: {
  thread: ChatPanelSignals;
  source: RecommendedFollowupSource;
}) {
  const { t } = useTranslation();
  const responsiveFollowupCards =
    useGet(featureSwitch$)[FeatureSwitchKey.ResponsiveFollowupCards] ?? false;
  // Card rail only on actual mobile/touch text-entry devices, mirroring the
  // composer auto-focus heuristic. A desktop window dragged narrow must still
  // render the flat list, so container width is not the deciding factor.
  const showFollowupCards =
    responsiveFollowupCards && isMobileTextInputDevice();
  const selectOrAppendComposerText = useSet(
    thread.composer.editor.selectOrAppendText$,
  );
  const handleRecommendedFollowupsRef = (element: HTMLDivElement | null) => {
    reportRecommendedFollowupsShown(element, source);
  };

  const handleSelect = (
    followup: RecommendedFollowup,
    followupIndex: number,
  ) => {
    captureRecommendedFollowupSelected({
      messageId: source.eventId,
      followupIndex,
      followupCount: source.followups.length,
      followup,
    });
    selectOrAppendComposerText(followup.prompt);
  };

  return (
    <div
      ref={handleRecommendedFollowupsRef}
      role="group"
      aria-label={t(($) => {
        return $.chat.run.keepGoing;
      })}
      className={cn(
        // The flat list pulls out by the row buttons' own px-2 so its text
        // aligns with the message column. Cards carry no such inner offset,
        // so the rail must stay flush with the column and the composer.
        showFollowupCards
          ? "flex items-stretch gap-3 overflow-x-auto overscroll-x-contain pb-1 snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "-mx-2",
      )}
    >
      {source.followups.map((followup, followupIndex) => {
        return (
          <button
            key={followup.prompt}
            type="button"
            title={followup.prompt}
            className={cn(
              "group flex text-left transition-colors",
              showFollowupCards
                ? "min-h-24 flex-[0_0_min(22rem,calc(100cqw-4rem))] self-stretch snap-center items-start rounded-[var(--zero-card-radius)] border border-border/70 bg-card p-4 shadow-sm hover:bg-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                : "min-h-10 w-full items-center gap-2 rounded-lg px-2 py-2 hover:bg-state-hover",
            )}
            onClick={() => {
              handleSelect(followup, followupIndex);
            }}
          >
            <span
              className={cn(
                "shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground",
                showFollowupCards && "hidden",
              )}
            >
              <RecommendedFollowupIcon followup={followup} />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words text-[0.9375rem] font-medium leading-6 group-hover:text-foreground",
                showFollowupCards ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {followup.prompt}
            </span>
            <ArrowUpRight
              size={14}
              className={cn(
                "shrink-0 text-muted-foreground/60 opacity-0 transition-all group-hover:text-foreground group-hover:opacity-100",
                showFollowupCards && "hidden",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

function splitQueuedEventsForThinkingIndicator(groups: ChatEventGroup[]): {
  activeGroups: ChatEventGroup[];
  queuedGroups: ChatEventGroup[];
} {
  const activeGroups: ChatEventGroup[] = [];
  const queuedEvents: EnrichedChatEvent[] = [];

  for (const group of groups) {
    if (group.role !== "user") {
      activeGroups.push(group);
      continue;
    }

    const activeEvents: EnrichedChatEvent[] = [];
    for (const event of group.events) {
      if (event.isQueued) {
        queuedEvents.push(event);
      } else {
        activeEvents.push(event);
      }
    }

    if (activeEvents.length > 0) {
      activeGroups.push({
        ...group,
        beginEventId: activeEvents[0]!.id,
        events: activeEvents,
      });
    }
  }

  return {
    activeGroups,
    queuedGroups:
      queuedEvents.length > 0
        ? [
            {
              beginEventId: queuedEvents[0]!.id,
              role: "user",
              events: queuedEvents,
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Composer wrapper — reads chat signals from thread prop
// ---------------------------------------------------------------------------

function ActiveGoalObjectiveDialog({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const dialogThreadId = useGet(activeGoalDialogThreadId$);
  const goalLoadable = useLoadable(activeGoalDialogGoal$);
  const closeDialog = useSet(closeChatThreadGoalDialog$);
  const open = dialogThreadId === threadId;
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
          <DialogTitle className="text-base">
            {t(($) => {
              return $.chat.queue.goal;
            })}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {t(($) => {
              return $.chat.queue.goalDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(60vh,520px)] overflow-y-auto rounded-lg bg-muted/40 px-3 py-3 text-sm text-foreground sm:px-4">
          {goalLoadable.state === "loading" ? (
            <div className="flex min-h-28 items-center justify-center gap-2 text-muted-foreground">
              <Loader2 size={16} className="animate-spin" aria-hidden="true" />
              <span>
                {t(($) => {
                  return $.chat.queue.loadingGoal;
                })}
              </span>
            </div>
          ) : goalLoadable.state === "hasError" ? (
            <div className="flex min-h-28 flex-col justify-center gap-1 text-muted-foreground">
              <p className="font-medium text-foreground">
                {t(($) => {
                  return $.chat.queue.goalLoadFailed;
                })}
              </p>
              <p className="text-xs">
                {t(($) => {
                  return $.chat.queue.goalRetry;
                })}
              </p>
            </div>
          ) : goal ? (
            <Markdown
              source={goal.objective}
              escapeHtml
              style={{ fontSize: "inherit", lineHeight: "inherit" }}
            />
          ) : (
            <div className="flex min-h-28 items-center text-muted-foreground">
              {t(($) => {
                return $.chat.queue.goalUnavailable;
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChatThreadComposer({ thread }: { thread: ChatPanelSignals }) {
  const standalonePwa = isStandalonePwa();

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 bg-[hsl(var(--background))]"
      style={{
        // Overlap the footer's breathing room with the root-owned safe area;
        // --sab is zero while the software keyboard is open.
        paddingBottom: "max(0.5rem - var(--sab), 0px)",
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-[21px] bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div
        className={cn(
          "overflow-y-auto [scrollbar-gutter:stable] pb-2 pl-4 pr-4 pt-3 sm:pl-6 sm:pr-6",
          standalonePwa && "overscroll-contain",
        )}
      >
        <div className="mx-auto max-w-[900px]">
          <ChatComposer signals={thread.composer} />
          <ActiveGoalObjectiveDialog threadId={thread.threadId} />
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

function ChatEventSkeletonPair({ compact = false }: { compact?: boolean }) {
  return (
    <>
      {/* User bubble skeleton */}
      <div
        data-chat-event-skeleton="user"
        aria-hidden
        className="flex justify-end"
      >
        <Skeleton
          className={cn("h-10 rounded-xl", compact ? "w-[45%]" : "w-[60%]")}
        />
      </div>
      {/* Assistant bubble skeleton */}
      <div
        data-chat-event-skeleton="assistant"
        aria-hidden
        className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start"
      >
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton
            className={cn("h-4 rounded-lg", compact ? "w-[85%]" : "w-[90%]")}
          />
          <Skeleton
            className={cn("h-4 rounded-lg", compact ? "w-[60%]" : "w-[75%]")}
          />
          {!compact && <Skeleton className="h-4 w-[40%] rounded-lg" />}
        </div>
      </div>
    </>
  );
}

function ChatSkeleton() {
  return (
    <>
      <ChatEventSkeletonPair />
      <ChatEventSkeletonPair compact />
    </>
  );
}

// ---------------------------------------------------------------------------
// Thinking indicator — shown the entire time a run is active
// ---------------------------------------------------------------------------

interface ServerThinkingLabel {
  readonly displayedText: string;
  readonly fadingOut: boolean;
  readonly fullText: string;
  readonly id: string;
  readonly setRef: (
    el: HTMLParagraphElement | null,
  ) => (() => void) | undefined;
}

function ShimmerText({
  ariaLabel,
  children,
  className,
  setRef,
  visualChildren = children,
}: {
  readonly ariaLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly setRef?: ServerThinkingLabel["setRef"];
  readonly visualChildren?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "zero-shimmer-text-shell h-5 min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[0.8125rem] leading-5",
        className,
      )}
    >
      <p
        ref={setRef}
        className="zero-shimmer-text h-5 w-full truncate"
        aria-label={ariaLabel}
      >
        {children}
      </p>
      <span className="zero-shimmer-window" aria-hidden>
        <span className="zero-shimmer-highlight">{visualChildren}</span>
      </span>
      <span
        className="zero-shimmer-window zero-shimmer-window-secondary"
        aria-hidden
      >
        <span className="zero-shimmer-highlight">{visualChildren}</span>
      </span>
    </div>
  );
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
  const { t } = useTranslation();
  const openQueueDrawer = useSet(openQueueDrawer$);

  if (isQueued) {
    const waitingIn = t(($) => {
      return $.chat.run.waitingIn;
    });
    const queueEllipsis = t(($) => {
      return $.chat.run.queueEllipsis;
    });
    return (
      <ShimmerText
        visualChildren={
          <>
            {waitingIn}{" "}
            <span className="underline underline-offset-2">
              {queueEllipsis}
            </span>
          </>
        }
      >
        {waitingIn}{" "}
        <button
          type="button"
          onClick={() => {
            openQueueDrawer();
          }}
          className="cursor-pointer underline underline-offset-2"
        >
          {queueEllipsis}
        </button>
      </ShimmerText>
    );
  }

  if (serverThinkingLabel) {
    return (
      <ShimmerText
        key={serverThinkingLabel.id}
        setRef={serverThinkingLabel.setRef}
        className={cn(
          "transition-opacity duration-200",
          serverThinkingLabel.fadingOut ? "opacity-0" : "opacity-100",
        )}
        ariaLabel={serverThinkingLabel.fullText}
      >
        {serverThinkingLabel.displayedText || "\u00a0"}
      </ShimmerText>
    );
  }

  return <ShimmerText>{thinkingLabel}</ShimmerText>;
}

function ThinkingLoader({
  blockStyle,
  spinnerEnabled,
}: {
  blockStyle: CSSProperties;
  spinnerEnabled: boolean;
}) {
  if (spinnerEnabled) {
    return (
      <span
        aria-hidden
        data-thinking-loader="spinner"
        className="zero-thinking-spinner-frame inline-flex size-[11.5px] shrink-0 items-center justify-center"
      >
        <img
          src={thinkingSpinnerImg}
          alt=""
          className="zero-thinking-spinner size-3.5 max-w-none shrink-0 animate-spin motion-reduce:animate-none"
        />
      </span>
    );
  }

  return (
    <span
      data-thinking-loader="blocks"
      className="zero-blocks shrink-0"
      style={blockStyle}
    >
      <span />
      <span />
      <span />
    </span>
  );
}

function InlineThinkingRow({
  blockStyle,
  isQueued,
  spinnerEnabled,
  thinkingLabel,
  serverThinkingLabel,
}: {
  blockStyle: CSSProperties;
  isQueued: boolean;
  spinnerEnabled: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
}) {
  return (
    <div className="flex items-center gap-2 h-5">
      <ThinkingLoader blockStyle={blockStyle} spinnerEnabled={spinnerEnabled} />
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
  thread: ChatPanelSignals;
  source: RecommendedFollowupSource | null;
}) {
  const { t } = useTranslation();
  const runWorkFoldingEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.ChatRunWorkFolding] ?? false;
  const donePhrase =
    useLastResolved(thread.donePhrase$) ??
    t(($) => {
      return $.chat.run.done.default;
    });
  const runFinishedAt = useLastResolved(thread.latestRunFinishCreatedAt$);
  if (runWorkFoldingEnabled && source === null) {
    return null;
  }
  const label =
    source && runFinishedAt
      ? t(
          ($) => {
            return $.chat.run.keepGoingAt;
          },
          {
            timestamp: formatChatTimestamp(runFinishedAt),
          },
        )
      : source
        ? t(($) => {
            return $.chat.run.keepGoing;
          })
        : donePhrase;

  return (
    <div className="flex flex-col gap-2">
      <RunSectionDivider label={label} />
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
  spinnerEnabled,
  thinkingLabel,
  serverThinkingLabel,
  runGroupFolds,
}: {
  thread: ChatPanelSignals;
  blockStyle: CSSProperties;
  isQueued: boolean;
  spinnerEnabled: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
  runGroupFolds: readonly RunGroupFoldControl[];
}) {
  const thinkingIndicatorProps = isQueued
    ? {}
    : { "data-thinking-indicator": true };

  return (
    <div
      {...thinkingIndicatorProps}
      data-role="assistant"
      className="zero-thinking-enter flex flex-col gap-1"
    >
      <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS}>
        <AssistantBubbleAvatar thread={thread} />
        <div className="relative flex min-w-0 flex-col gap-2">
          {runGroupFolds.map((fold) => {
            return (
              <RunGroupFoldRow key={fold.fold.key} control={fold} embedded />
            );
          })}
          <div className="zero-chat-bubble-assistant min-w-0 overflow-hidden rounded-xl py-4 text-[0.9375rem] leading-[1.7]">
            <div className="flex h-5 min-w-0 items-center gap-2">
              <ThinkingLoader
                blockStyle={blockStyle}
                spinnerEnabled={spinnerEnabled}
              />
              <ThinkingLabel
                isQueued={isQueued}
                thinkingLabel={thinkingLabel}
                serverThinkingLabel={serverThinkingLabel}
              />
            </div>
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
  active,
  blockStyle,
  isQueued,
  spinnerEnabled,
  thinkingLabel,
  serverThinkingLabel,
  thread,
  recommendedFollowupSource,
}: {
  active: boolean;
  blockStyle: CSSProperties;
  isQueued: boolean;
  spinnerEnabled: boolean;
  thinkingLabel: string;
  serverThinkingLabel?: ServerThinkingLabel;
  thread: ChatPanelSignals;
  recommendedFollowupSource: RecommendedFollowupSource | null;
}) {
  const thinkingIndicatorProps =
    active && !isQueued ? { "data-thinking-indicator": true } : {};

  return (
    <div
      {...thinkingIndicatorProps}
      data-role="assistant-thinking"
      className={RUN_SECTION_ROW_CLASS}
    >
      <div className="hidden @[900px]:block" />
      <div className="min-w-0">
        {active ? (
          <InlineThinkingRow
            blockStyle={blockStyle}
            isQueued={isQueued}
            spinnerEnabled={spinnerEnabled}
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

function runStatusIndicatorActive(mode: ThinkingIndicatorMode): boolean {
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
      previous.eventId === next.eventId &&
      previous.followups === next.followups)
  );
}

function ThinkingIndicator({
  thread,
  mode,
  runGroupFolds,
}: {
  thread: ChatPanelSignals;
  mode: ThinkingIndicatorMode;
  runGroupFolds: readonly RunGroupFoldControl[];
}) {
  const featureSwitches = useGet(featureSwitch$);
  const runWorkFoldingEnabled =
    featureSwitches[FeatureSwitchKey.ChatRunWorkFolding] ?? false;
  const spinnerEnabled =
    featureSwitches[FeatureSwitchKey.ChatThinkingSpinner] ?? false;
  const [c1, c2, c3] = useGet(thread.blockColors$);
  const blockStyle = {
    "--zb-c1": c1,
    "--zb-c2": c2,
    "--zb-c3": c3,
  } as CSSProperties;
  const thinkingText = useLastResolved(thread.thinkingText$);
  const recommendedFollowupSource =
    useLastResolved(thread.recommendedFollowupSource$, {
      equalityFn: equalRecommendedFollowupSources,
    }) ?? null;
  const thinkingLabel = useGet(thread.thinkingPhrase$);
  const active = runStatusIndicatorActive(mode);
  const isQueued = thinkingIndicatorQueued(mode);
  const thinkingEventId = useLastResolved(thread.thinkingEventId$);
  const displayedThinkingText =
    useLastResolved(thread.displayedThinkingText$) ?? "";
  const thinkingTextFadingOut =
    useLastResolved(thread.thinkingTextFadingOut$) ?? false;
  const setThinkingIndicatorTextRef = useSet(
    thread.setThinkingIndicatorTextRef$,
  );
  const serverThinkingLabel =
    thinkingText && thinkingEventId && active && !isQueued
      ? {
          displayedText: displayedThinkingText,
          fadingOut: thinkingTextFadingOut,
          fullText: thinkingText,
          id: thinkingEventId,
          setRef: setThinkingIndicatorTextRef,
        }
      : undefined;

  if (
    mode === null ||
    (runWorkFoldingEnabled &&
      mode === "finished" &&
      recommendedFollowupSource === null)
  ) {
    return null;
  }

  // Shared inline row with fixed h-5 to prevent layout jump on transition
  if (thinkingIndicatorUsesStatusRow(mode)) {
    return (
      <AssistantThinkingStatusRow
        active={active}
        blockStyle={blockStyle}
        isQueued={isQueued}
        spinnerEnabled={spinnerEnabled}
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
      spinnerEnabled={spinnerEnabled}
      thinkingLabel={thinkingLabel}
      serverThinkingLabel={serverThinkingLabel}
      runGroupFolds={runGroupFolds}
    />
  );
}

function ChatConnectorActionConnectModal() {
  const active = useGet(activeChatConnectorAction$);

  if (!active) {
    return null;
  }

  return <ActiveChatConnectorActionConnectModal />;
}

function ActiveChatConnectorActionConnectModal() {
  const active = useGet(activeChatConnectorAction$);
  const mcpEnabled = useGet(customConnectorMcpEnabled$);
  const close = useSet(closeChatConnectorActionConnectDialog$);
  const runCallback = useSet(runChatActionCallback$);
  const pageSignal = useGet(pageSignal$);
  const customConnectors = useLastResolved(customConnectors$);

  if (!active) {
    return null;
  }

  const onSuccess = async () => {
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
  };

  if (active.kind === "custom") {
    const connector = customConnectors?.find((candidate) => {
      return (
        candidate.slug === active.connectorSlug &&
        (candidate.kind === "http" || mcpEnabled)
      );
    });
    const accountOptions = connector
      ? defaultCustomConnectorAccountOptions(connector)
      : null;
    return connector && accountOptions ? (
      <CustomConnectorConnectDialog
        connector={connector}
        agentId={active.agentId}
        accountOptions={accountOptions}
        onClose={close}
        onSuccess={onSuccess}
      />
    ) : null;
  }

  const accountOptions = defaultBuiltinConnectorAccountOptions(
    active.catalogItem,
  );
  if (!accountOptions) {
    return null;
  }
  const reconnectAuthMethod =
    accountOptions.account.intent === "reconnect"
      ? active.catalogItem.connection?.authMethod
      : undefined;

  return (
    <ConnectModal
      item={active.catalogItem}
      agentId={active.agentId}
      accountOptions={accountOptions}
      reconnectAuthMethod={reconnectAuthMethod}
      onClose={close}
      onSuccess={onSuccess}
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
  return dollars.toLocaleString(i18n.resolvedLanguage, {
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
  const { t } = useTranslation();
  return (
    <div className="max-w-md">
      <p className="text-[0.9375rem] font-medium text-emerald-700 dark:text-emerald-300">
        {t(($) => {
          return $.chat.billing.creditsAvailable;
        })}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.billing.creditsAdded;
        })}
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
    ? i18n.t(($) => {
        return $.chat.billing.outOfCredits;
      })
    : i18n.t(($) => {
        return $.chat.billing.upgradeToRun;
      });
  if (!params.roleResolved) {
    return {
      headline,
      helper: i18n.t(($) => {
        return $.chat.billing.checkingPermissions;
      }),
    };
  }
  if (!params.canManageBilling) {
    return {
      headline,
      helper: !params.canBuyCredits
        ? i18n.t(($) => {
            return $.chat.billing.askAdminUpgrade;
          })
        : i18n.t(($) => {
            return $.chat.billing.askAdminCredits;
          }),
    };
  }
  return {
    headline,
    helper: !params.canBuyCredits
      ? i18n.t(($) => {
          return $.chat.billing.upgradeToContinue;
        })
      : i18n.t(($) => {
          return $.chat.billing.addCreditsToContinue;
        }),
  };
}

function PaidCreditCheckoutActions({
  preparing,
  handleCreditClick,
}: {
  readonly preparing: boolean;
  readonly handleCreditClick: (
    selection: CreditCheckoutSelection,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
}) {
  const { t } = useTranslation();
  const handleCustomCreditClick = (
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => {
    const credits = customCreditsFromForm(event.currentTarget.form);
    if (credits === null) {
      toast.error(
        t(($) => {
          return $.chat.billing.customAmountError;
        }),
      );
      return;
    }
    handleCreditClick({ credits, customAmount: true }, event);
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {CREDIT_TOP_UP_OPTIONS.map((credits) => {
          return (
            <Button
              key={credits}
              type="button"
              onClick={(event) => {
                handleCreditClick({ credits }, event);
              }}
              disabled={preparing}
              variant="default"
              size="sm"
              className="disabled:opacity-60"
            >
              {formatCreditsUsd(credits)}
            </Button>
          );
        })}
        <details>
          <summary
            role="button"
            className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-state-hover marker:hidden disabled:opacity-60 [&::-webkit-details-marker]:hidden"
          >
            {t(($) => {
              return $.chat.billing.custom;
            })}
          </summary>
          <form className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
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
              aria-label={t(($) => {
                return $.chat.billing.customDollarAmount;
              })}
              className="h-8 w-24 px-2"
            />
            <Button
              type="button"
              onClick={handleCustomCreditClick}
              disabled={preparing}
              variant="default"
              size="sm"
              className="disabled:opacity-60"
            >
              {preparing
                ? t(($) => {
                    return $.billing.common.preparing;
                  })
                : t(($) => {
                    return $.chat.billing.buy;
                  })}
            </Button>
          </form>
        </details>
      </div>
    </div>
  );
}

function InsufficientCreditsCard() {
  const { t } = useTranslation();
  const billingLoadable = useLoadable(billingStatusAsync$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const [creditCheckoutLoadable, creditCheckout] =
    useLoadableSet(startCreditCheckout$);
  const openSettings = useSet(openSettingsDialogAt$);
  const setSubPage = useSet(setBillingSubPage$);
  const pageSignal = useGet(pageSignal$);
  const creditPurchaseOrigin = useGet(creditPurchaseOrigin$);

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
  const checkoutRedirecting = checkoutLoadable.state === "loading";
  const creditCheckoutPreparing =
    creditCheckoutLoadable.state === "loading" ||
    creditPurchaseOrigin === "chat";

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
    detach(
      creditCheckout(selection, newTab, "chat", pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <div className="zero-chat-card max-w-md px-3 py-3">
      <p className="text-[0.9375rem] font-medium text-foreground">{headline}</p>
      <p className="mt-1 text-sm text-muted-foreground">{helper}</p>
      {!canShowBillingAction ? null : shouldStartProCheckout ? (
        <Button
          type="button"
          onClick={handleUpgradeClick}
          disabled={checkoutRedirecting}
          variant="default"
          size="sm"
          className="mt-3 disabled:opacity-60"
        >
          {checkoutRedirecting
            ? t(($) => {
                return $.chat.billing.redirecting;
              })
            : t(($) => {
                return $.chat.billing.upgradeToPro;
              })}
        </Button>
      ) : (
        <PaidCreditCheckoutActions
          preparing={creditCheckoutPreparing}
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

function assistantRecoveryResetText(
  recovery: AssistantErrorRecovery,
): string | null {
  if (recovery.retryAt) {
    const formatted = formatSubscriptionUsageReset(recovery.retryAt);
    if (formatted && "fallbackText" in formatted) {
      return formatted.fallbackText;
    }
    return formatted?.absoluteResetText ?? null;
  }
  if (!recovery.retryLabel) {
    return null;
  }
  return i18n.t(
    ($) => {
      return $.chat.errors.recovery.resetsAt;
    },
    { time: recovery.retryLabel },
  );
}

function AssistantRecoveryActionSpinner({ loading }: { loading: boolean }) {
  return loading ? <Loader2 size={14} className="animate-spin" /> : null;
}

function AssistantRecoveryActions({
  recovery,
  thread,
}: {
  recovery: AssistantErrorRecovery;
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const modelSelection =
    useLastResolved(thread.composer.model.modelSelection$) ?? null;
  const setModelSelection = useSet(thread.composer.model.setModelSelection$);
  const [retryLoadable, retry] = useLoadableSet(thread.retryAssistantError$);
  const [resetLoadable, resetAndRetry] = useLoadableSet(
    thread.resetCodexSubscriptionAndRetry$,
  );
  const retrying = retryLoadable.state === "loading";
  const resetting = resetLoadable.state === "loading";
  const hasResetAction = recovery.actions.resetAndTryAgain !== null;
  const hasRetryAction = recovery.actions.tryAgain !== null;
  const hasModelSelectionAction = recovery.kind !== "execution-timeout";
  // `excludedModel` drops the failed model from the menu, so showing it as the
  // trigger label would offer a choice the user cannot make. Fall back to the
  // "Switch model" placeholder until they pick something else.
  const pickerValue =
    modelSelection && modelSelection.selectedModel === recovery.failedModel
      ? null
      : modelSelection;
  const handleModelSelection = (
    selection: ModelProviderSelection | null,
  ): void => {
    if (!selection) {
      return;
    }
    detach(setModelSelection(selection, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {hasResetAction && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="zero-btn-morandi"
          disabled={retrying || resetting}
          onClick={() => {
            detach(resetAndRetry(pageSignal), Reason.DomCallback);
          }}
        >
          <AssistantRecoveryActionSpinner loading={resetting} />
          {t(($) => {
            return $.chat.errors.recovery.resetAndTryAgain;
          })}
        </Button>
      )}
      {hasModelSelectionAction && (
        <ModelProviderPicker
          value={pickerValue}
          onChange={handleModelSelection}
          placeholder={t(($) => {
            return $.chat.errors.recovery.selectModel;
          })}
          triggerClassName="h-8 w-auto bg-background text-sm"
          compactTrigger
          resolveDefaultSelection={false}
          {...(recovery.failedModel
            ? { excludedModel: recovery.failedModel }
            : {})}
        />
      )}
      {hasRetryAction && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          // Filled neutral leads; the plain outline reads as the secondary
          // action when reset is also offered.
          className={hasResetAction ? undefined : "zero-btn-morandi"}
          disabled={retrying || resetting}
          onClick={() => {
            detach(retry(pageSignal), Reason.DomCallback);
          }}
        >
          <AssistantRecoveryActionSpinner loading={retrying} />
          {/* A timed-out run is resumed, not retried, and its copy says so. */}
          {recovery.kind === "execution-timeout"
            ? t(($) => {
                return $.chat.errors.recovery.continue;
              })
            : t(($) => {
                return $.chat.errors.recovery.tryAgain;
              })}
        </Button>
      )}
    </div>
  );
}

function AssistantErrorRecoveryCard({
  recovery,
  thread,
}: {
  recovery: AssistantErrorRecovery;
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const resetText = assistantRecoveryResetText(recovery);
  const title = (() => {
    if (recovery.kind === "execution-timeout") {
      return t(($) => {
        return $.chat.errors.recovery.timeoutTitle;
      });
    }
    if (recovery.kind === "model-unavailable") {
      return t(($) => {
        return $.chat.errors.recovery.unavailableTitle;
      });
    }
    if (recovery.kind === "model-capacity") {
      return t(($) => {
        return $.chat.errors.recovery.capacityTitle;
      });
    }
    const framework =
      recovery.framework === "codex"
        ? t(($) => {
            return $.chat.errors.recovery.codex;
          })
        : t(($) => {
            return $.chat.errors.recovery.claudeCode;
          });
    return t(
      ($) => {
        return $.chat.errors.recovery.usageTitle;
      },
      { framework },
    );
  })();
  const description =
    recovery.kind === "execution-timeout"
      ? t(($) => {
          return $.chat.errors.recovery.timeoutDescription;
        })
      : recovery.kind === "usage-limit"
        ? t(($) => {
            return $.chat.errors.recovery.usageDescription;
          })
        : recovery.kind === "model-unavailable"
          ? t(($) => {
              return $.chat.errors.recovery.unavailableDescription;
            })
          : t(($) => {
              return $.chat.errors.recovery.capacityDescription;
            });

  return (
    <div
      role="status"
      data-testid="assistant-error-recovery"
      className="zero-chat-card flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5 text-foreground"
    >
      <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-2.5">
        {recovery.kind === "usage-limit" ||
        recovery.kind === "execution-timeout" ? (
          <Clock size={16} className="shrink-0 text-brand-text" />
        ) : (
          <Coffee size={16} className="shrink-0 text-brand-text" />
        )}
        <span className="shrink-0 text-[0.9375rem] font-medium leading-6">
          {title}
        </span>
        {/* The row is the point on desktop; on a phone a half-truncated
            sentence is worse than none, and the title already carries it. */}
        <span className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground sm:block">
          {description}
        </span>
        {resetText && (
          <span className="hidden shrink-0 items-center gap-1.5 text-sm font-medium text-foreground sm:inline-flex">
            <Clock size={14} className="text-muted-foreground" />
            {resetText}
          </span>
        )}
      </div>
      <AssistantRecoveryActions recovery={recovery} thread={thread} />
    </div>
  );
}

function AssistantErrorFallback({ error }: { error: string }) {
  const { t } = useTranslation();
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
        <Hand size={14} className="shrink-0" />
        <span>
          {t(($) => {
            return $.chat.errors.runCancelled;
          })}
        </span>
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
        <AlertCircle size={16} className="shrink-0 mt-[3px] text-amber-500" />
        <span>
          {t(($) => {
            return $.chat.errors.noModelProviderPrefix;
          })}{" "}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
            onClick={() => {
              detach(openSettings("model", pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.errors.noModelProviderAction;
            })}
          </button>{" "}
          {t(($) => {
            return $.chat.errors.noModelProviderSuffix;
          })}
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
        <AlertCircle size={16} className="shrink-0 mt-[3px] text-amber-500" />
        <span>
          {t(($) => {
            return $.chat.errors.providerIncompatiblePrefix;
          })}{" "}
          <Link
            pathname="/"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
          >
            {t(($) => {
              return $.chat.errors.providerIncompatibleAction;
            })}
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
        <AlertCircle size={16} className="shrink-0 mt-[3px] text-amber-500" />
        <span>
          {t(($) => {
            return $.chat.errors.providerDeletedPrefix;
          })}{" "}
          <Link
            pathname="/"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
          >
            {t(($) => {
              return $.chat.errors.providerDeletedAction;
            })}
          </Link>{" "}
          {t(($) => {
            return $.chat.errors.providerDeletedSuffix;
          })}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 text-destructive">
      <AlertCircle size={16} className="shrink-0 mt-[3px]" />
      <Markdown
        source={error}
        style={{ fontSize: "inherit", lineHeight: "inherit" }}
      />
    </div>
  );
}

function AssistantErrorContent({
  error,
  eventId,
  thread,
}: {
  error: string;
  eventId: string;
  thread: ChatPanelSignals;
}) {
  const recovery = useLastResolved(thread.assistantErrorRecovery$);
  return recovery?.sourceEventId === eventId ? (
    <AssistantErrorRecoveryCard recovery={recovery} thread={thread} />
  ) : (
    <AssistantErrorFallback error={error} />
  );
}

function AssistantBubbleAvatar({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const agentId = thread.agentId;
  return (
    <Link
      pathname="/agents/:agentId"
      options={{ pathParams: { agentId } }}
      className={`${CHAT_THREAD_ASSISTANT_AVATAR_FRAME_CLASS} transition-colors duration-150 hover:bg-state-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`}
      aria-label={t(($) => {
        return $.chat.agentPage.viewAgentProfile;
      })}
    >
      <AgentAvatarImg
        name={agentId}
        alt=""
        className={CHAT_THREAD_ASSISTANT_AVATAR_IMAGE_CLASS}
      />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Paged event rendering — renders from visibleRenderedChatGroups$ (flat data,
// no signal-based run loops).
// ---------------------------------------------------------------------------

function PagedGroupRow({
  group,
  thread,
  modelChanges,
  stackFirstOnPrevious = false,
  runGroupFolds,
  completedWorkFold,
  runWorkSection,
}: {
  group: ChatEventGroup;
  thread: ChatPanelSignals;
  modelChanges: ReadonlyMap<string, RunModelChange>;
  stackFirstOnPrevious?: boolean;
  runGroupFolds?: readonly RunGroupFoldControl[];
  completedWorkFold?: CompletedWorkFoldControl;
  runWorkSection?: RunWorkSectionControl;
}) {
  if (group.role === "user") {
    return (
      <PagedUserGroup
        group={group}
        thread={thread}
        modelChanges={modelChanges}
        stackFirstOnPrevious={stackFirstOnPrevious}
        runGroupFolds={runGroupFolds}
      />
    );
  }
  return (
    <PagedAssistantGroup
      group={group}
      thread={thread}
      modelChanges={modelChanges}
      runGroupFolds={runGroupFolds}
      completedWorkFold={completedWorkFold}
      runWorkSection={runWorkSection}
    />
  );
}

function shareableEventFromChatEvent(
  event: EnrichedChatEvent,
): { readonly id: string; readonly text: string } | null {
  if (event.seqId === undefined) {
    return null;
  }
  if (event.eventType === "output.message") {
    return event.content && event.content.length > 0
      ? { id: event.id, text: event.content }
      : null;
  }
  if (
    event.eventType !== "input.prompt" &&
    event.eventType !== "input.automation"
  ) {
    return null;
  }
  const displayText = messageDocumentToDisplayText(event.userMessage)?.trim();
  if (displayText) {
    return { id: event.id, text: displayText };
  }
  const automation = eventNonContentPart(event);
  if (automation?.type !== "automation") {
    return null;
  }
  const automationText =
    automation.automationBrief?.trim() || automation.workflowName.trim();
  return automationText.length > 0
    ? { id: event.id, text: automationText }
    : null;
}

function clickTargetsExistingInteraction(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'a, button, input, textarea, select, [role="button"], [contenteditable="true"]',
    ) !== null
  );
}

function SelectablePagedGroupRow({
  group,
  thread,
  modelChanges,
  stackFirstOnPrevious,
  runGroupFolds,
  completedWorkFold,
  runWorkSection,
}: Parameters<typeof PagedGroupRow>[0]) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const selectedEventIds = useGet(thread.sharing.selectedEventIds$);
  const toggle = useSet(thread.sharing.toggle$);
  const visualGroupEvents = [
    ...(runWorkSection?.hiddenGroups.flatMap((hiddenGroup) => {
      return hiddenGroup.events;
    }) ?? []),
    ...group.events,
  ];
  const events = visualGroupEvents.flatMap((event) => {
    const shareable = shareableEventFromChatEvent(event);
    return shareable ? [shareable] : [];
  });
  if (phase === "idle" || events.length === 0) {
    return (
      <PagedGroupRow
        group={group}
        thread={thread}
        modelChanges={modelChanges}
        stackFirstOnPrevious={stackFirstOnPrevious}
        runGroupFolds={runGroupFolds}
        completedWorkFold={completedWorkFold}
        runWorkSection={runWorkSection}
      />
    );
  }
  const selectedCount = events.filter((event) => {
    return selectedEventIds.has(event.id);
  }).length;
  const allSelected = selectedCount === events.length;
  const checked =
    selectedCount === 0 ? false : allSelected ? true : "indeterminate";

  const toggleGroup = () => {
    if (phase !== "selecting") {
      return;
    }
    const result = toggle(group.beginEventId, events);
    if (result === "too-large") {
      toast.error(
        t(($) => {
          return $.chat.sharing.tooLarge;
        }),
      );
    }
  };

  return (
    <div
      data-chat-share-selectable-group
      className={cn(
        "relative -my-1 rounded-lg py-1 transition-colors",
        phase === "selecting" && "cursor-pointer hover:bg-state-hover",
      )}
      onClick={(event) => {
        if (!clickTargetsExistingInteraction(event.target)) {
          toggleGroup();
        }
      }}
    >
      <PagedGroupRow
        group={group}
        thread={thread}
        modelChanges={modelChanges}
        stackFirstOnPrevious={stackFirstOnPrevious}
        runGroupFolds={runGroupFolds}
        completedWorkFold={completedWorkFold}
        runWorkSection={runWorkSection}
      />
      <Checkbox
        checked={checked}
        disabled={phase !== "selecting"}
        aria-label={t(($) => {
          return allSelected
            ? $.chat.sharing.deselectGroup
            : $.chat.sharing.selectGroup;
        })}
        className="absolute -right-9 top-1/2 -translate-y-1/2 lg:-right-10"
        onClick={(event) => {
          event.stopPropagation();
        }}
        onCheckedChange={toggleGroup}
      />
    </div>
  );
}

function PagedUserGroup({
  group,
  thread,
  modelChanges,
  stackFirstOnPrevious = false,
  runGroupFolds,
}: {
  group: ChatEventGroup;
  thread: ChatPanelSignals;
  modelChanges: ReadonlyMap<string, RunModelChange>;
  stackFirstOnPrevious?: boolean;
  runGroupFolds?: readonly RunGroupFoldControl[];
}) {
  return (
    <>
      {group.events.map((event, index) => {
        const modelChange = modelChanges.get(event.id);
        const previousEvent = group.events[index - 1];
        // Anything the user sent back to back is one thing they said, so the
        // whole run closes up — including the message the run started from and
        // the first correction after it, which is the seam this rule used to
        // leave wide. Adjacency is the whole condition on purpose. Anything
        // that belongs between two messages — a model change, or a message that
        // renders as its own card rather than a bubble — ends the stack.
        const stackedOnPrevious =
          modelChange === undefined &&
          rendersUserBubble(event) &&
          (previousEvent !== undefined
            ? rendersUserBubble(previousEvent)
            : stackFirstOnPrevious);
        return (
          <div key={event.id} className="contents">
            {modelChange === undefined ? null : (
              <ModelChangeDividerRow change={modelChange} />
            )}
            <PagedUserMessage
              event={event}
              thread={thread}
              stackedOnPrevious={stackedOnPrevious}
            />
          </div>
        );
      })}
      {runGroupFolds?.map((fold) => {
        return <RunGroupFoldRow key={fold.fold.key} control={fold} />;
      })}
    </>
  );
}

// A user event does not always render as a bubble: a workflow run, a goal, and
// a rejected goal each render as their own card or as nothing at all.
function rendersUserBubble(event: EnrichedChatEvent): boolean {
  return (
    !isRejectedGoalUserMessage(event) &&
    !isWorkflowUserMessage(event) &&
    !isGoalUserMessage(event)
  );
}

function isWorkflowUserMessage(
  event: EnrichedChatEvent,
): event is EnrichedChatEvent & ChatInputEvent {
  return (
    isInputChatEvent(event) && eventNonContentPart(event)?.type === "automation"
  );
}

interface ResolvedMessageAttachment {
  readonly id: string | null;
  readonly filename: string;
  readonly url: string;
  readonly contentType: string | undefined;
  readonly isImage: boolean;
  readonly kind: ReturnType<typeof classifyChatAttachment>;
  readonly signals: ArtifactSignals;
}

type OpenMessageImagePreview = (url: string, filename?: string) => void;

function userMessageRenderAttachments(
  document: UserMessageRenderDocument | undefined,
): ResolvedMessageAttachment[] {
  return (document?.parts ?? []).flatMap((renderPart) => {
    if (renderPart.type !== "file") {
      return [];
    }
    const { part, signals } = renderPart;
    return [
      {
        id: part.fileId,
        filename: part.filenameSnapshot,
        url: signals.url,
        contentType: part.contentType,
        isImage:
          signals.kind === "image" || isImageFilename(part.filenameSnapshot),
        kind: signals.kind,
        signals,
      },
    ];
  });
}

function clipboardAttachmentsFromUserMessage(
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
    return attachment
      ? [
          {
            id: attachment.id,
            url: attachment.url,
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
          },
        ]
      : [];
  });
}

// Images and videos render as thumbnails, every other attachment as a chip.
// The two shapes never share a row, so they are grouped before rendering.
function isMediaAttachment(attachment: ResolvedMessageAttachment): boolean {
  return attachment.isImage || attachment.kind === "video";
}

function MessageAttachment({
  attachment: a,
  onImageClick,
}: {
  attachment: ResolvedMessageAttachment;
  onImageClick: OpenMessageImagePreview;
}) {
  const { t } = useTranslation();
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);

  if (a.isImage) {
    return (
      <ChatImagePreviewLink
        alt={a.filename}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: a.filename,
          },
        )}
        load={a.signals.previewImageLoad}
        imageClassName="block h-full w-full object-contain"
        linkClassName={CHAT_INLINE_IMAGE_PREVIEW_CLASS}
        onPreview={() => {
          onImageClick(a.url, a.filename);
        }}
        placeholderClassName="h-full w-full"
        resourceUrl$={a.signals.resourceUrl$}
        url={a.url}
      />
    );
  }
  if (a.kind === "video") {
    return (
      <ChatVideoPreviewButton
        posterLoad={a.signals.previewImageLoad}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: a.filename,
          },
        )}
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
        filename={a.filename}
        url={a.url}
        kind={a.kind}
        text$={a.signals.text$}
      />
    );
  }
  if (a.kind === "audio") {
    return (
      <PreviewableAudioAttachmentChip
        filename={a.filename}
        url={a.url}
        contentType={a.contentType}
      />
    );
  }
  return (
    <FileAttachmentChip
      filename={a.filename}
      url={a.url}
      contentType={a.contentType}
    />
  );
}

function UserMessageAttachmentRow({
  attachments,
  onImageClick,
  testId,
}: {
  attachments: ResolvedMessageAttachment[];
  onImageClick: OpenMessageImagePreview;
  testId: string;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap justify-end gap-2" data-testid={testId}>
      {attachments.map((a) => {
        return (
          <MessageAttachment
            key={a.id ?? a.url}
            attachment={a}
            onImageClick={onImageClick}
          />
        );
      })}
    </div>
  );
}

function UserMessageAttachments({
  attachments,
  onImageClick,
}: {
  attachments: ReturnType<typeof userMessageRenderAttachments>;
  onImageClick: OpenMessageImagePreview;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="mb-2 flex max-w-[85%] flex-col items-end gap-2 self-end">
      <UserMessageAttachmentRow
        attachments={attachments.filter(isMediaAttachment)}
        onImageClick={onImageClick}
        testId="message-media-attachments"
      />
      <UserMessageAttachmentRow
        attachments={attachments.filter((a) => {
          return !isMediaAttachment(a);
        })}
        onImageClick={onImageClick}
        testId="message-file-attachments"
      />
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
  const { t } = useTranslation();
  if (!canCopy) {
    return null;
  }
  return (
    <div className={CHAT_THREAD_USER_MESSAGE_ACTIONS_CLASS}>
      <IconTooltipButton
        type="button"
        onClick={onCopy}
        className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-state-hover transition-colors duration-150"
        aria-label={t(($) => {
          return $.chat.actions.copyMessage;
        })}
      >
        {copied ? <Check size={18} /> : <Copy size={18} />}
      </IconTooltipButton>
    </div>
  );
}

function generationTemplateTypeLabel(
  value: GenerationTemplateRequest | undefined,
): string | null {
  if (!value) {
    return null;
  }
  if (avatarTemplateSelection(value)) {
    return i18n.t(($) => {
      return $.artifacts.templates.avatar;
    });
  }
  if (value.type === "video") {
    return i18n.t(($) => {
      return $.chat.templates.categories.video;
    });
  }
  if (value.type === "illustration") {
    return i18n.t(($) => {
      return $.chat.templates.categories.illustration;
    });
  }
  if (value.type === "workflow") {
    return i18n.t(($) => {
      return $.chat.templates.categories.workflow;
    });
  }
  if (value.type === "website") {
    return i18n.t(($) => {
      return $.chat.templates.categories.website;
    });
  }
  return i18n.t(($) => {
    return $.chat.templates.categories.presentation;
  });
}

const annotationIconImgs = {
  feishu: settingsIconAssetUrl("lark"),
  teams: settingsIconAssetUrl("teams"),
  telegram: settingsIconAssetUrl("telegram"),
  github: settingsIconAssetUrl("github"),
  agentphone: settingsIconAssetUrl("imessage"),
} as const;

function MessageAnnotation({
  renderPart,
}: {
  renderPart: UserMessageAnnotationRenderPart;
}) {
  const { t } = useTranslation();
  const className =
    "mb-1.5 inline-flex h-7 max-w-[85%] items-center gap-1.5 self-end " +
    "rounded-md px-1.5 text-xs font-medium text-muted-foreground";
  if (renderPart.type === "automation") {
    const { part } = renderPart;
    return (
      <div
        aria-label={t(
          ($) => {
            return $.chat.workflows.named;
          },
          {
            title: part.workflowName,
          },
        )}
        className={className}
        title={part.workflowName}
      >
        <Route size={15} className="shrink-0" />
        <span className="min-w-0 truncate">{part.workflowName}</span>
      </div>
    );
  }
  if (renderPart.type === "goal") {
    return (
      <div
        aria-label={t(($) => {
          return $.chat.queue.goal;
        })}
        className={className}
      >
        <Target size={15} className="shrink-0" />
        <span>
          {t(($) => {
            return $.chat.queue.goal;
          })}
        </span>
      </div>
    );
  }
  return (
    <SourceMessageAnnotation renderPart={renderPart} className={className} />
  );
}

function SourceMessageAnnotation({
  renderPart,
  className,
}: {
  renderPart: Extract<UserMessageAnnotationRenderPart, { type: "source" }>;
  className: string;
}) {
  const { t } = useTranslation();
  if (renderPart.kind === "agent") {
    return (
      <AgentRunSourceMessageAnnotation
        part={renderPart.part}
        className={className}
        signals={renderPart.signals}
      />
    );
  }
  const { part } = renderPart;
  const sourceLabel =
    part.kind === "slack"
      ? t(($) => {
          return $.chat.origins.slack;
        })
      : part.kind === "feishu"
        ? t(($) => {
            return $.chat.origins.feishu;
          })
        : part.kind === "teams"
          ? t(($) => {
              return $.chat.origins.teams;
            })
          : part.kind === "telegram"
            ? t(($) => {
                return $.chat.origins.telegram;
              })
            : part.kind === "github"
              ? t(($) => {
                  return $.chat.origins.github;
                })
              : t(($) => {
                  return $.chat.origins.agentphone;
                });
  const openLabel =
    part.kind === "feishu"
      ? t(($) => {
          return $.chat.origins.openChat;
        })
      : t(($) => {
          return $.chat.origins.openMessage;
        });
  const ariaLabel =
    part.kind === "slack"
      ? t(($) => {
          return $.chat.origins.openSlackMessage;
        })
      : part.kind === "feishu"
        ? t(($) => {
            return $.chat.origins.openFeishuChat;
          })
        : part.kind === "teams"
          ? t(($) => {
              return $.chat.origins.openTeamsMessage;
            })
          : part.kind === "telegram"
            ? t(($) => {
                return $.chat.origins.openTelegramMessage;
              })
            : part.kind === "github"
              ? t(($) => {
                  return $.chat.origins.openGithubMessage;
                })
              : sourceLabel;
  const content = (
    <>
      {part.kind === "slack" ? (
        <BrandSlack size={15} className="shrink-0" />
      ) : (
        <img
          src={annotationIconImgs[part.kind]}
          alt=""
          className="size-[15px] shrink-0 object-contain"
        />
      )}
      <span className="shrink-0">{sourceLabel}</span>
      {part.href ? (
        <>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">{openLabel}</span>
          <ArrowUpRight size={12} className="shrink-0" />
        </>
      ) : null}
    </>
  );
  if (!part.href) {
    return <div className={className}>{content}</div>;
  }
  return (
    <a
      href={part.href}
      target="_blank"
      rel="noreferrer"
      aria-label={ariaLabel}
      className={`${className} transition-colors hover:bg-state-hover hover:text-foreground`}
    >
      {content}
    </a>
  );
}

function AgentRunSourceMessageAnnotation({
  part,
  className,
  signals,
}: {
  part: Extract<
    Extract<UserMessageNonContentPart, { type: "source" }>,
    { kind: "agent" }
  >;
  className: string;
  signals: AgentReferenceSignals;
}) {
  const { t } = useTranslation();
  const agent = useLastResolved(signals.agent$);
  return (
    <Link
      pathname={ROUTES.chat}
      options={{
        pathParams: { threadId: part.threadId },
        hash: `run-${part.runId}`,
      }}
      aria-label={t(
        ($) => {
          return $.chat.thread.openNamedChat;
        },
        { title: part.titleSnapshot },
      )}
      className={`${className} transition-colors hover:bg-state-hover hover:text-foreground`}
      title={part.titleSnapshot}
    >
      <AvatarFromUrl
        avatarUrl={agent?.avatarUrl}
        alt=""
        className="size-4 shrink-0 overflow-hidden rounded-full object-cover object-top"
        size={16}
      />
      <span className="min-w-0 truncate">{part.titleSnapshot}</span>
    </Link>
  );
}

// File chips carry their own border, so they need more breathing room from the
// surrounding sentence than a borderless inline mention does.
const INLINE_FILE_REFERENCE_SPACING_CLASS = "mx-1";
const STRUCTURED_INLINE_REFERENCE_CLASS =
  "relative -top-px mx-0.5 inline-flex h-7 max-w-[240px] items-center " +
  "gap-1.5 rounded-md bg-orange-500/10 px-2 align-middle text-[13px] " +
  "font-medium text-orange-600 dark:bg-orange-400/15 dark:text-orange-300";
const STRUCTURED_INLINE_INTERACTIVE_CLASS =
  "transition-colors hover:bg-orange-500/15 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-orange-500/30 " +
  "active:bg-orange-500/20 dark:hover:bg-orange-400/20 " +
  "dark:active:bg-orange-400/25";
const STRUCTURED_INLINE_LINK_REFERENCE_CLASS = `${STRUCTURED_INLINE_REFERENCE_CLASS} ${STRUCTURED_INLINE_INTERACTIVE_CLASS}`;

function UserMessageTemplateReference({
  part,
}: {
  part: Extract<UserMessagePart, { type: "template" }>;
}) {
  const typeLabel = generationTemplateTypeLabel(part.template);
  const label = `${typeLabel ?? part.template.type} · ${part.titleSnapshot}`;
  return (
    <span
      data-structured-template-reference=""
      className={STRUCTURED_INLINE_REFERENCE_CLASS}
      title={label}
    >
      <SwatchBook size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{part.titleSnapshot}</span>
    </span>
  );
}

function UserMessageFileReference({
  part,
  signals,
}: {
  part: Extract<UserMessagePart, { type: "file" }>;
  signals: ArtifactSignals;
}) {
  const { t } = useTranslation();
  const openVideoLightbox = useSet(openAttachmentVideoLightbox$);
  let reference: ReactNode;
  if (signals.kind === "video") {
    reference = (
      <ChatVideoPreviewButton
        posterLoad={signals.previewImageLoad}
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: part.filenameSnapshot,
          },
        )}
        buttonClassName={CHAT_INLINE_VIDEO_ATTACHMENT_PREVIEW_CLASS}
        filename={part.filenameSnapshot}
        onPreview={() => {
          openVideoLightbox({
            url: signals.url,
            filename: part.filenameSnapshot,
          });
        }}
        posterClassName="h-full w-full"
        url={signals.url}
        videoClassName="h-full w-full object-contain"
      />
    );
  } else if (
    signals.kind === "markdown" ||
    signals.kind === "text" ||
    signals.kind === "json" ||
    signals.kind === "csv" ||
    signals.kind === "pdf" ||
    signals.kind === "html"
  ) {
    reference = (
      <PreviewableFileAttachmentChip
        filename={part.filenameSnapshot}
        url={signals.url}
        kind={signals.kind}
      />
    );
  } else if (signals.kind === "audio") {
    reference = (
      <PreviewableAudioAttachmentChip
        filename={part.filenameSnapshot}
        url={signals.url}
        contentType={part.contentType}
      />
    );
  } else {
    reference = (
      <FileAttachmentChip
        contentType={part.contentType}
        filename={part.filenameSnapshot}
        url={signals.url}
      />
    );
  }
  return (
    <span
      className={`${INLINE_FILE_REFERENCE_SPACING_CLASS} inline-flex align-middle`}
    >
      {reference}
    </span>
  );
}

function UserMessageChatThreadReference({
  threadId,
  title,
}: {
  threadId: string;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <Link
      pathname={ROUTES.chat}
      options={{ pathParams: { threadId } }}
      aria-label={t(
        ($) => {
          return $.chat.thread.openNamedChat;
        },
        { title },
      )}
      className={STRUCTURED_INLINE_LINK_REFERENCE_CLASS}
      title={title}
    >
      <MessageCircle size={13} className="shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  );
}

function UserMessageAgentReference({
  agentId,
  name,
  signals,
}: {
  agentId: string;
  name: string;
  signals: AgentReferenceSignals;
}) {
  const { t } = useTranslation();
  const agent = useLastResolved(signals.agent$);
  return (
    <Link
      pathname={ROUTES.agentChat}
      options={{ pathParams: { agentId } }}
      aria-label={t(
        ($) => {
          return $.chat.thread.openNamedAgent;
        },
        { name },
      )}
      className={STRUCTURED_INLINE_LINK_REFERENCE_CLASS}
      title={name}
    >
      <AvatarFromUrl
        avatarUrl={agent?.avatarUrl}
        alt=""
        className="size-4 shrink-0 overflow-hidden rounded-full object-cover object-top"
        size={16}
      />
      <span className="min-w-0 truncate">{name}</span>
    </Link>
  );
}

function UserMessageFeedbackNote({
  note,
}: {
  note: readonly UserMessageFeedbackNoteRenderPart[];
}) {
  const partOccurrences = new Map<string, number>();
  return (
    <div>
      {note.map((renderPart) => {
        const identity = JSON.stringify(renderPart.part);
        const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
        partOccurrences.set(identity, occurrence);
        const key = `${identity}:${String(occurrence)}`;
        if (renderPart.type === "chat_thread") {
          return (
            <UserMessageChatThreadReference
              key={key}
              threadId={renderPart.part.threadId}
              title={renderPart.part.titleSnapshot}
            />
          );
        }
        if (renderPart.type === "agent") {
          return (
            <UserMessageAgentReference
              key={key}
              agentId={renderPart.part.agentId}
              name={renderPart.part.nameSnapshot}
              signals={renderPart.signals}
            />
          );
        }
        if (renderPart.type === "template") {
          return (
            <UserMessageTemplateReference key={key} part={renderPart.part} />
          );
        }
        return <span key={key}>{renderPart.part.text}</span>;
      })}
    </div>
  );
}

type UserMessageFeedbackRenderPart = Extract<
  UserMessageRenderPart,
  { type: "feedback" }
>;

function equalFeedbackSources(
  left: UserMessageFeedbackRenderPart["part"]["source"],
  right: UserMessageFeedbackRenderPart["part"]["source"],
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

function userMessageFeedbackHeading(
  parts: readonly UserMessageFeedbackRenderPart[],
): string {
  const source = parts[0]?.part.source;
  if (!source) {
    return parts.length === 1
      ? i18n.t(($) => {
          return $.chat.feedback.partHeading;
        })
      : i18n.t(
          ($) => {
            return $.chat.feedback.partsHeading;
          },
          {
            count: parts.length,
          },
        );
  }
  const description =
    source.status === "draft"
      ? i18n.t(
          ($) => {
            return $.chat.feedback.emailDraftDescription;
          },
          {
            id: source.id,
          },
        )
      : i18n.t(
          ($) => {
            return $.chat.feedback.sentEmailDescription;
          },
          {
            id: source.id,
            sentIdSuffix: source.sentId
              ? i18n.t(
                  ($) => {
                    return $.chat.feedback.sentIdSuffix;
                  },
                  {
                    sentId: source.sentId,
                  },
                )
              : "",
          },
        );
  return parts.length === 1
    ? i18n.t(
        ($) => {
          return $.chat.feedback.sourcePartHeading;
        },
        { description },
      )
    : i18n.t(
        ($) => {
          return $.chat.feedback.sourcePartsHeading;
        },
        {
          count: parts.length,
          description,
        },
      );
}

function UserMessageFeedbackGroup({
  parts,
}: {
  parts: readonly UserMessageFeedbackRenderPart[];
}) {
  const partOccurrences = new Map<string, number>();
  let firstPart = true;
  return (
    <div data-structured-feedback-group="" className="space-y-3">
      <div>{userMessageFeedbackHeading(parts)}</div>
      {parts.map((renderPart) => {
        const identity = JSON.stringify(renderPart.part);
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
              {renderPart.part.quote}
            </blockquote>
            <UserMessageFeedbackNote note={renderPart.note} />
          </div>
        );
      })}
    </div>
  );
}

type UserMessageContentRenderPart = Exclude<
  UserMessageRenderPart,
  {
    readonly type: "source" | "automation" | "goal" | "model";
  }
>;
type UserMessageStandaloneRenderPart = Exclude<
  UserMessageContentRenderPart,
  { readonly type: "feedback" }
>;

function UserMessagePartView({
  renderPart,
}: {
  renderPart: UserMessageStandaloneRenderPart;
}): ReactNode {
  if (renderPart.type === "text") {
    return <span>{renderPart.part.text}</span>;
  }
  if (renderPart.type === "chat_thread") {
    return (
      <UserMessageChatThreadReference
        threadId={renderPart.part.threadId}
        title={renderPart.part.titleSnapshot}
      />
    );
  }
  if (renderPart.type === "agent") {
    return (
      <UserMessageAgentReference
        agentId={renderPart.part.agentId}
        name={renderPart.part.nameSnapshot}
        signals={renderPart.signals}
      />
    );
  }
  if (renderPart.type === "voice") {
    return <UserMessageVoiceDraft part={renderPart.part} />;
  }
  if (renderPart.type === "template") {
    return <UserMessageTemplateReference part={renderPart.part} />;
  }
  if (renderPart.type === "file") {
    return (
      <UserMessageFileReference
        part={renderPart.part}
        signals={renderPart.signals}
      />
    );
  }
  void (renderPart satisfies never);
  return null;
}

function UserMessageVoiceDraft({
  part,
}: {
  part: Extract<UserMessagePart, { type: "voice" }>;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-sent-voice-draft=""
      className="my-1.5 rounded-lg border border-border/70 bg-muted/65 px-3 py-2.5 text-left text-muted-foreground"
    >
      <div className="flex items-center gap-2 text-xs font-semibold">
        <Mic size={15} aria-hidden="true" />
        {t(($) => {
          return $.chat.voice.draft;
        })}
      </div>
      {part.transcript ? (
        <div className="mt-2 whitespace-pre-wrap break-words text-sm leading-5 text-foreground/70">
          {part.transcript}
        </div>
      ) : null}
    </div>
  );
}

function UserMessageView({
  document,
  elevatedFileIds,
}: {
  document: UserMessageRenderDocument;
  elevatedFileIds: ReadonlySet<string>;
}) {
  const partOccurrences = new Map<string, number>();
  const bodyParts = document.parts.filter(
    (renderPart): renderPart is UserMessageContentRenderPart => {
      return (
        !isUserMessageHiddenPart(renderPart.part) &&
        !isElevatedUserMessagePart(renderPart, elevatedFileIds)
      );
    },
  );
  if (bodyParts.length === 0) {
    return null;
  }
  const renderedParts: ReactNode[] = [];
  let index = 0;
  while (index < bodyParts.length) {
    const renderPart = bodyParts[index];
    if (!renderPart) {
      break;
    }
    if (renderPart.type === "feedback") {
      const feedbackParts: UserMessageFeedbackRenderPart[] = [renderPart];
      let nextIndex = index + 1;
      while (nextIndex < bodyParts.length) {
        const candidate = bodyParts[nextIndex];
        if (
          candidate?.type !== "feedback" ||
          !equalFeedbackSources(renderPart.part.source, candidate.part.source)
        ) {
          break;
        }
        feedbackParts.push(candidate);
        nextIndex += 1;
      }
      renderedParts.push(
        <UserMessageFeedbackGroup
          key={`feedback:${String(index)}`}
          parts={feedbackParts}
        />,
      );
      index = nextIndex;
      continue;
    }
    const identity = JSON.stringify(renderPart.part);
    const occurrence = (partOccurrences.get(identity) ?? 0) + 1;
    partOccurrences.set(identity, occurrence);
    renderedParts.push(
      <UserMessagePartView
        key={`${identity}:${String(occurrence)}`}
        renderPart={renderPart}
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

function isElevatedUserMessagePart(
  renderPart: UserMessageRenderPart,
  elevatedFileIds: ReadonlySet<string>,
): boolean {
  return (
    renderPart.type === "file" && elevatedFileIds.has(renderPart.part.fileId)
  );
}

function UserMessageContent({
  document,
  attachments,
  onImageClick,
}: {
  document: UserMessageRenderDocument;
  attachments: ReturnType<typeof userMessageRenderAttachments>;
  onImageClick: OpenMessageImagePreview;
}) {
  // Attachments read as their own object, so they all sit above the bubble
  // instead of interrupting the sentence they were dropped into. Attachments
  // without an id cannot be matched to a document part, so they stay inline.
  const elevatedAttachments = attachments.filter((attachment) => {
    return attachment.id !== null;
  });
  const elevatedFileIds = new Set(
    elevatedAttachments.flatMap((attachment) => {
      return attachment.id ? [attachment.id] : [];
    }),
  );
  const hasBody = document.parts.some((renderPart) => {
    return (
      !isUserMessageHiddenPart(renderPart.part) &&
      !isElevatedUserMessagePart(renderPart, elevatedFileIds)
    );
  });

  return (
    <>
      <UserMessageAttachments
        attachments={elevatedAttachments}
        onImageClick={onImageClick}
      />
      {hasBody ? (
        <ChatUserMessageBubble>
          <div className="px-4 py-3">
            <UserMessageView
              document={document}
              elevatedFileIds={elevatedFileIds}
            />
          </div>
        </ChatUserMessageBubble>
      ) : null}
    </>
  );
}

function WorkflowUserMessage({
  event,
}: {
  event: EnrichedChatEvent & ChatInputEvent;
}) {
  const { t } = useTranslation();
  const renderPart = userMessageAnnotationRenderPart(
    event.userMessageRenderDocument,
  );
  if (renderPart?.type !== "automation") {
    return null;
  }
  const { part } = renderPart;
  const workflowTitle =
    part.workflowName.trim() ||
    t(($) => {
      return $.chat.templates.categories.workflow;
    });
  const workflowBody =
    messageDocumentToDisplayText(event.userMessage)?.trim() ||
    part.automationBrief?.trim();
  const bubbleClassName =
    "zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden whitespace-pre-wrap transition-colors duration-150";
  const body = workflowBody ? (
    <div className={bubbleClassName}>
      <div className="px-4 py-3">{workflowBody}</div>
    </div>
  ) : null;
  const workflowId = part.workflowId;
  const linked = workflowId !== undefined;

  return (
    <div
      data-role="user"
      data-chat-scroll-anchor-event-id={event.id}
      data-turn-created-at={event.createdAt}
      className="group"
    >
      <div className={CHAT_THREAD_USER_MESSAGE_ROW_CLASS}>
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex w-full flex-col items-end">
          <MessageAnnotation renderPart={renderPart} />
          {linked && body ? (
            <Link
              pathname={ROUTES.workflowDetailAutomations}
              options={{
                pathParams: {
                  workflowId,
                },
              }}
              className="contents"
              aria-label={t(
                ($) => {
                  return $.chat.workflows.open;
                },
                {
                  title: workflowTitle,
                },
              )}
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
  event,
}: {
  event: EnrichedChatEvent & ChatInputEvent;
}) {
  const renderPart = userMessageAnnotationRenderPart(
    event.userMessageRenderDocument,
  );
  if (renderPart?.type !== "goal") {
    return null;
  }
  const { part } = renderPart;
  const goalBrief = part.goalBrief.trim();
  return (
    <div
      data-role="user"
      data-chat-scroll-anchor-event-id={event.id}
      data-turn-created-at={event.createdAt}
      className="group"
    >
      <div className={CHAT_THREAD_USER_MESSAGE_ROW_CLASS}>
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex w-full flex-col items-end">
          <MessageAnnotation renderPart={renderPart} />
          {goalBrief ? (
            <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden ring-1 ring-emerald-900/10">
              <div className="px-4 py-3 whitespace-pre-wrap">{goalBrief}</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function resolvePagedUserMessageRendering({
  renderDocument,
}: {
  renderDocument: UserMessageRenderDocument | undefined;
}) {
  const canonicalUserMessage = renderDocument?.document;
  const userMessageAttachments = canonicalUserMessage
    ? userMessageFileAttachments(canonicalUserMessage)
    : undefined;
  const copyText = canonicalUserMessage
    ? (messageDocumentToPrompt(canonicalUserMessage) ?? "")
    : "";
  const clipboardAttachments = canonicalUserMessage
    ? clipboardAttachmentsFromUserMessage(
        canonicalUserMessage,
        userMessageAttachments ?? [],
      )
    : [];

  return {
    canonicalUserMessage,
    clipboardAttachments,
    copyText,
  };
}

function inputPromptRunAnchor(inputEvent: ChatInputEvent | undefined) {
  return inputEvent?.eventType === "input.prompt" && inputEvent.runId
    ? `run-${inputEvent.runId}`
    : undefined;
}

function messageImageLightboxTarget(
  threadId: string,
  url: string,
  filename: string | undefined,
) {
  return { threadId, url, ...(filename ? { filename } : {}) };
}

function PagedUserMessage({
  event,
  thread,
  stackedOnPrevious = false,
}: {
  event: EnrichedChatEvent;
  thread: ChatPanelSignals;
  stackedOnPrevious?: boolean;
}) {
  const inputEvent = asInputChatEvent(event);
  const renderDocument = event.userMessageRenderDocument;
  const { canonicalUserMessage, clipboardAttachments, copyText } =
    resolvePagedUserMessageRendering({
      renderDocument,
    });
  const pageSignal = useGet(pageSignal$);
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox: OpenMessageImagePreview = (url, filename) => {
    openImageLightbox(
      messageImageLightboxTarget(thread.threadId, url, filename),
    );
  };
  const copiedId = useGet(thread.copiedEventId$);
  const copied = copiedId === event.id;
  const copyEvent = useSet(thread.copyEvent$);
  const allAttachments = userMessageRenderAttachments(renderDocument);
  const canCopy =
    canonicalUserMessage !== undefined ||
    copyText.trim().length > 0 ||
    clipboardAttachments.length > 0;

  const handleCopy = () => {
    if (!canCopy) {
      return;
    }
    detach(
      copyEvent(
        event.id,
        {
          text: copyText,
          attachments: clipboardAttachments,
          ...(canonicalUserMessage
            ? { userMessage: canonicalUserMessage }
            : {}),
        },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  if (isRejectedGoalUserMessage(event)) {
    return null;
  }

  if (isWorkflowUserMessage(event)) {
    return <WorkflowUserMessage event={event} />;
  }

  if (isGoalUserMessage(event)) {
    return <GoalUserMessage event={event} />;
  }

  const nonContentRenderPart = userMessageAnnotationRenderPart(renderDocument);
  const annotationPart =
    nonContentRenderPart?.type === "source" ? nonContentRenderPart : undefined;
  return (
    <div
      id={inputPromptRunAnchor(inputEvent)}
      data-role="user"
      data-chat-scroll-anchor-event-id={event.id}
      data-turn-created-at={event.createdAt}
      className={cn(
        "group",
        stackedOnPrevious && CHAT_THREAD_MESSAGE_STACK_PULL_CLASS,
      )}
    >
      <div className={CHAT_THREAD_USER_MESSAGE_ROW_CLASS}>
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          {annotationPart ? (
            <MessageAnnotation renderPart={annotationPart} />
          ) : null}
          {renderDocument ? (
            <UserMessageContent
              document={renderDocument}
              attachments={allAttachments}
              onImageClick={openLightbox}
            />
          ) : null}
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

type CompletedWorkFoldControl = {
  readonly groups: readonly ChatEventGroup[];
  readonly hiddenGroups: readonly ChatEventGroup[];
  readonly expanded: boolean;
  readonly onToggle: () => void;
};

type RunWorkSectionControl = Omit<RunWorkSection, "key"> & {
  readonly expanded: boolean;
  readonly onToggle: () => void;
};

type PagedAssistantGroupProps = {
  readonly group: ChatEventGroup;
  readonly thread: ChatPanelSignals;
  readonly modelChanges: ReadonlyMap<string, RunModelChange>;
  readonly runGroupFolds?: readonly RunGroupFoldControl[];
  readonly completedWorkFold?: CompletedWorkFoldControl;
  readonly runWorkSection?: RunWorkSectionControl;
};

type PagedAssistantTimelineItem =
  | {
      readonly kind: "assistant";
      readonly event: EnrichedChatEvent;
    }
  | {
      readonly kind: "model-change";
      readonly eventId: string;
      readonly change: RunModelChange;
    }
  | {
      readonly kind: "completed-work";
      readonly control: CompletedWorkFoldControl;
    }
  | {
      readonly kind: "run-work";
      readonly control: RunWorkSectionControl;
    };

function assistantTimelineItems(
  events: readonly EnrichedChatEvent[],
): PagedAssistantTimelineItem[] {
  return events.filter(isRenderableAssistantEvent).map((event) => {
    return { kind: "assistant", event };
  });
}

function foldedRunWorkTimelineItems(
  groups: readonly ChatEventGroup[],
  modelChanges: ReadonlyMap<string, RunModelChange>,
): PagedAssistantTimelineItem[] {
  return groups.flatMap((group) => {
    return group.events.flatMap((event): PagedAssistantTimelineItem[] => {
      const change = modelChanges.get(event.id);
      if (change !== undefined) {
        return [{ kind: "model-change", eventId: event.id, change }];
      }
      return isRenderableAssistantEvent(event)
        ? [{ kind: "assistant", event }]
        : [];
    });
  });
}

function buildPagedAssistantTimeline({
  group,
  modelChanges,
  completedWorkFold,
  runWorkSection,
}: Pick<
  PagedAssistantGroupProps,
  "group" | "modelChanges" | "completedWorkFold" | "runWorkSection"
>): PagedAssistantTimelineItem[] {
  const items: PagedAssistantTimelineItem[] = [];
  if (completedWorkFold !== undefined) {
    items.push({ kind: "completed-work", control: completedWorkFold });
    if (completedWorkFold.expanded) {
      items.push(
        ...completedWorkFold.hiddenGroups.flatMap((hiddenGroup) => {
          return assistantTimelineItems(hiddenGroup.events);
        }),
      );
    }
  }
  if (runWorkSection === undefined) {
    items.push(...assistantTimelineItems(group.events));
    return items;
  }

  items.push({ kind: "run-work", control: runWorkSection });
  const anchorIndex = group.events.findIndex((event) => {
    return event.id === runWorkSection.anchorEventId;
  });
  const anchorEndIndex =
    anchorIndex === -1 ? group.events.length : anchorIndex + 1;
  if (runWorkSection.expanded) {
    items.push(
      ...foldedRunWorkTimelineItems(runWorkSection.hiddenGroups, modelChanges),
    );
  }
  items.push(...assistantTimelineItems(group.events.slice(0, anchorEndIndex)));
  if (runWorkSection.expanded) {
    items.push(
      ...foldedRunWorkTimelineItems(
        runWorkSection.hiddenGroupsAfterAnchor,
        modelChanges,
      ),
    );
  }
  items.push(...assistantTimelineItems(group.events.slice(anchorEndIndex)));
  return items;
}

function PagedAssistantTimeline({
  items,
  thread,
}: {
  items: readonly PagedAssistantTimelineItem[];
  thread: ChatPanelSignals;
}) {
  let renderedAssistantItemCount = 0;
  return items.map((item) => {
    if (item.kind === "model-change") {
      return (
        <FoldedModelChangeDivider key={item.eventId} change={item.change} />
      );
    }
    if (item.kind === "completed-work") {
      return (
        <CompletedWorkFoldRow
          key="completed-work:control"
          groups={item.control.groups}
          expanded={item.control.expanded}
          onToggle={item.control.onToggle}
        />
      );
    }
    if (item.kind === "run-work") {
      const collapsible =
        item.control.hiddenGroups.length > 0 ||
        item.control.hiddenGroupsAfterAnchor.length > 0;
      return (
        <RunWorkSectionRow
          key={`run-work:control:${item.control.anchorEventId}`}
          startTime={item.control.startTime}
          endTime={item.control.endTime}
          collapsible={collapsible}
          expanded={item.control.expanded}
          onToggle={item.control.onToggle}
        />
      );
    }
    const compactTop = renderedAssistantItemCount > 0;
    renderedAssistantItemCount += 1;
    return (
      <PagedAssistantEventItem
        key={item.event.id}
        event={item.event}
        compactTop={compactTop}
        thread={thread}
      />
    );
  });
}

function PagedAssistantGroup({
  group,
  thread,
  modelChanges,
  runGroupFolds,
  completedWorkFold,
  runWorkSection,
}: PagedAssistantGroupProps) {
  const hasRenderableEvent = group.events.some((event) => {
    return isRenderableAssistantEvent(event);
  });
  const hasRunGroupFolds = (runGroupFolds?.length ?? 0) > 0;
  const visibleCompletedWorkFold = hasRunGroupFolds
    ? undefined
    : completedWorkFold;
  const visibleRunWorkSection = hasRunGroupFolds ? undefined : runWorkSection;
  if (
    !hasRenderableEvent &&
    !completedWorkFold &&
    !runWorkSection &&
    !hasRunGroupFolds
  ) {
    return null;
  }

  const groupElementId = `chat-event-group-${group.beginEventId}`;
  const runId = firstRunIdForEvents(group.events);
  const fullContent = group.events
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");
  const timelineItems = buildPagedAssistantTimeline({
    group,
    modelChanges,
    completedWorkFold: visibleCompletedWorkFold,
    runWorkSection: visibleRunWorkSection,
  });

  return (
    <div
      id={groupElementId}
      data-role="assistant"
      data-chat-run-id={runId}
      data-turn-created-at={group.events[0]?.createdAt}
      className={CHAT_THREAD_ASSISTANT_MESSAGE_GROUP_CLASS}
    >
      <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ROW_CLASS}>
        <AssistantBubbleAvatar thread={thread} />
        <div className="relative flex flex-col gap-2">
          {runGroupFolds?.map((fold) => {
            return (
              <RunGroupFoldRow key={fold.fold.key} control={fold} embedded />
            );
          })}
          <PagedAssistantTimeline items={timelineItems} thread={thread} />
        </div>
      </div>
      <PagedGroupActions group={group} content={fullContent} thread={thread} />
    </div>
  );
}

function PagedAssistantEventItem({
  event,
  compactTop = false,
  thread,
}: {
  event: EnrichedChatEvent;
  compactTop?: boolean;
  thread: ChatPanelSignals;
}) {
  const retryRichEventTree = useSet(thread.retryRichEventTree$);
  const pageSignal = useGet(pageSignal$);
  const error = chatEventDisplayError(event);
  if (error) {
    return (
      <ChatAssistantMessageBody
        data-chat-scroll-anchor-event-id={event.id}
        data-chat-run-id={event.runId}
        compactTop={compactTop}
      >
        <AssistantErrorContent
          error={error}
          eventId={event.id}
          thread={thread}
        />
      </ChatAssistantMessageBody>
    );
  }

  if (
    (isChatEventContentTextType(event.eventType) && event.content) ||
    hasChatEventBodyContent(event)
  ) {
    return (
      <ChatAssistantMessageBody
        data-chat-scroll-anchor-event-id={event.id}
        data-chat-run-id={event.runId}
        compactTop={compactTop}
      >
        <MarkdownEventBody
          tree={event.tree}
          mediaPreview
          onRetry={
            event.richContentError
              ? () => {
                  detach(
                    retryRichEventTree(event, pageSignal),
                    Reason.DomCallback,
                  );
                }
              : undefined
          }
        />
      </ChatAssistantMessageBody>
    );
  }

  return null;
}

function formatCredits(value: number): string {
  return value.toLocaleString(i18n.resolvedLanguage);
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
  usage: ChatEventUsagePayload,
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
  usage: ChatEventUsagePayload;
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
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground/70 hover:bg-state-hover hover:text-foreground transition-colors duration-150"
          aria-label={`${ariaLabel} ${total}`}
        >
          <Coins size={17} />
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
  usage: ChatEventUsagePayload;
}) {
  const { t } = useTranslation();
  const openRunId = useGet(runUsagePopoverOpenRunId$);
  const setOpenRunId = useSet(setRunUsagePopoverOpenRunId$);

  return (
    <UsageChip
      usage={usage}
      title={t(($) => {
        return $.chat.run.creditUsage;
      })}
      ariaLabel={t(($) => {
        return $.chat.run.creditUsage;
      })}
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
  usage: ChatEventUsagePayload | undefined;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1" data-testid="chat-event-actions">
      {firstRunId && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/activities/:activityRunId"
                options={{
                  pathParams: { activityRunId: firstRunId },
                }}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-state-hover transition-colors duration-150"
                aria-label={t(($) => {
                  return $.chat.run.viewLogs;
                })}
              >
                <ChartLine size={18} />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t(($) => {
                return $.chat.run.viewActivityLogs;
              })}
            </TooltipContent>
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
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-state-hover transition-colors duration-150"
                aria-label={t(($) => {
                  return $.chat.actions.copyMessage;
                })}
              >
                {copied ? <Check size={18} /> : <Copy size={18} />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {copied
                ? t(($) => {
                    return $.chat.actions.copied;
                  })
                : t(($) => {
                    return $.chat.actions.copyMessage;
                  })}
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
  group: ChatEventGroup;
  content: string;
  thread: ChatPanelSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(thread.copiedEventId$);
  const copied = copiedId === group.beginEventId;
  const copyEvent = useSet(thread.copyEvent$);

  const firstRunId = group.events.find((m) => {
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
      copyEvent(
        group.beginEventId,
        { text: content, attachments: [] },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_ROW_CLASS}>
      <div className="hidden @[900px]:block" />
      <div className={CHAT_THREAD_ASSISTANT_MESSAGE_ACTIONS_CLASS}>
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
