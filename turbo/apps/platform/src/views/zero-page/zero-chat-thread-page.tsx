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
  useSet,
  useLastLoadable,
  useLastResolved,
  useLoadable,
} from "ccstate-react";
import type { TFunction } from "i18next";
import { equalArrays } from "../../lib/equality.ts";
import { now } from "../../lib/time.ts";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { resolvedAppLocale } from "../../i18n/format.ts";
import { i18n } from "../../i18n/index.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
  Play,
  Video,
  Copy,
  Monitor,
  Check,
  SwatchBook,
  ArrowDown,
  ArrowUpRight,
  ChevronRight,
  Link as LinkIcon,
  Loader2,
  MessageCircle,
  SmilePlus,
  Package,
  Route,
  Search,
  Sunrise,
  Target,
  X,
  Clock,
  Coins,
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
} from "@vm0/ui";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import type {
  ChatEventUsagePayload,
  ChatRecommendedFollowup,
  GenerationTemplateRequest,
  UserMessageDocument,
  UserMessagePart,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  isChatEventContentTextType,
  terminatedChatRunIds,
} from "@vm0/api-contracts/contracts/chat-events";
import {
  messageDocumentToDisplayText,
  messageDocumentToPrompt,
} from "../../signals/zero-page/user-message-document-codec.ts";
import { avatarTemplateSelection } from "../../signals/zero-page/avatar-template-selection.ts";
import type {
  ChatThreadWorkflowAutomation,
  ZeroWorkflowSchedule,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { r2ImageTransformUrl } from "@vm0/core";
import { getModelDisplayName } from "@vm0/core/model-display-name";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import type {
  PlatformConnectorPermissionMetadata,
  PlatformUserPermissionGrant,
} from "../../signals/connector-domain.ts";
import { emptyChatImg } from "./platform-assets.ts";
import type { FirewallPolicyValue } from "@vm0/connectors/firewall-types";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isMobileTextInputDevice } from "../../lib/visual-viewport-keyboard.ts";
import { Markdown } from "../components/markdown.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  customConnectorMcpEnabled$,
  featureSwitch$,
  videoTemplateOptionsEnabled$,
} from "../../signals/external/feature-switch.ts";
import {
  videoTemplateSpec,
  videoTemplateSpecText,
  type VideoTemplateSpec,
} from "../../signals/zero-page/video-template-spec.ts";
import { openSentTemplateDetail$ } from "../../signals/zero-page/sent-template-detail.ts";
import { SentTemplateDetailDialog } from "./sent-template-detail-dialog.tsx";
import { isStandalonePwa } from "../../lib/keyboard-dismiss-gesture.ts";
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
} from "./zero-attachment-chips.tsx";
import { publicAttachmentUrl } from "./zero-attachment-url";
import { MailDraftCard } from "./mail-draft-card.tsx";
import { BrowserSessionCard } from "./browser-session-card.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  classifyChatAttachment,
  contentTypeForBodyPreviewKind,
  type BodyRenderBlock,
} from "../../signals/chat-page/parse-body-blocks.ts";
import type { ArtifactSignals } from "../../signals/chat-page/artifact-card-signals.ts";
import {
  activeChatConnectorAction$,
  closeChatConnectorActionConnectDialog$,
  type CatalogConnectorSignals,
  type ConnectorSignals,
  type CustomConnectorSignals,
} from "../../signals/chat-page/connector-action-block.ts";
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
import {
  activeGoalDialogGoal$,
  activeGoalDialogThreadId$,
  closeChatThreadGoalDialog$,
} from "../../signals/chat-page/chat-goal.ts";
import type { ComputerUseAuthorizationSignals } from "../../signals/chat-page/computer-use-authorization-block.ts";
import type { PlanUpgradeSignals } from "../../signals/chat-page/plan-upgrade-block.ts";
import type { PermissionSignals } from "../../signals/chat-page/permission-card-signals.ts";
import { AttachmentPreview } from "./zero-attachment-preview.tsx";
import { ArtifactThumbnailImage } from "./zero-artifact-thumbnail.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { ConnectorCard } from "./components/settings/connector-card.tsx";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { CustomConnectorIcon } from "./components/settings/custom-connector-icon.tsx";
import { CustomConnectorConnectDialog } from "./components/settings/custom-connector-connect-dialog.tsx";
import { connectorCurrentConnectionStatus } from "../../signals/zero-page/settings/connectors.ts";
import { customConnectors$ } from "../../signals/zero-page/settings/custom-connectors.ts";
import { PermissionGrantDurationSelect } from "../components/permission-grant-duration-select.tsx";
import {
  lightboxUrl$ as attachmentLightboxUrl$,
  openImageLightbox$ as openAttachmentImageLightbox$,
  openVideoLightbox$ as openAttachmentVideoLightbox$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN,
  permissionGrantExpiresInByScope$,
  setPermissionGrantExpiresIn$,
} from "../../signals/permission-allow/permission-grant-expiration.ts";
import { isActiveUserPermissionGrant } from "../../signals/user-permission-grants.ts";
import {
  writeToClipboard,
  type ChatClipboardAttachment,
} from "../../signals/zero-page/clipboard.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
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
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import {
  ModelProviderPicker,
  type ModelProviderSelection,
} from "./components/model-provider-picker.tsx";
import { ChatFeedbackSelection } from "./zero-chat-feedback-selection.tsx";
import { formatSubscriptionUsageReset } from "./subscription-usage-format.ts";
import { AgentAvatarImg, AvatarFromUrl } from "./zero-sidebar-shared.tsx";
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

type RecommendedFollowup = ChatRecommendedFollowup;

type UserMessageNonContentPart = Extract<
  UserMessagePart,
  { readonly type: "source" | "automation" | "goal" | "morning_brief" }
>;

type UserMessageAnnotationRenderPart = Extract<
  UserMessageRenderPart,
  { readonly type: "source" | "automation" | "goal" | "morning_brief" }
>;

function isUserMessageNonContentPart(
  part: UserMessagePart,
): part is UserMessageNonContentPart {
  return (
    part.type === "source" ||
    part.type === "automation" ||
    part.type === "goal" ||
    part.type === "morning_brief"
  );
}

type UserMessageHiddenPart = Extract<
  UserMessagePart,
  {
    readonly type: "source" | "automation" | "goal" | "morning_brief" | "model";
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
        renderPart.type === "goal" ||
        renderPart.type === "morning_brief"
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

function chatEventAttachments(event: ChatEvent) {
  return isInputChatEvent(event)
    ? userMessageFileAttachments(event.userMessage)
    : undefined;
}

function chatEventError(event: ChatEvent): string | undefined {
  if (
    event.eventType === "input.rejected" ||
    event.eventType === "output.error" ||
    event.eventType === "run.failed" ||
    event.eventType === "run.cancelled"
  ) {
    return event.error;
  }
  return undefined;
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
              open && "bg-primary/10 text-primary hover:text-primary",
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
              open && "bg-primary/10 text-primary hover:text-primary",
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
              open && "bg-primary/10 text-primary hover:text-primary",
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
        <AutomationMenuButton key={thread.threadId} thread={thread} />
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
  const railEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.EmojiPickerCategoryRail] ?? false;
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
      {railEnabled && (
        <ChatThreadEmojiCategoryRail
          categories={categories}
          onSelect={jumpToCategory}
        />
      )}
      <div
        className={cn(
          "flex items-center gap-2 px-2 pt-2",
          // Pull the first section title up towards the search field. The title
          // keeps its own box height so the fade under it is unchanged; only
          // the gap above it closes.
          railEnabled ? "pb-1" : "pb-2",
        )}
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
        railEnabled={railEnabled}
      />
      {railEnabled && <ChatThreadEmojiPreview />}
    </div>
  );
}

// Names whichever emoji the pointer or keyboard is on, so the grid stays a
// grid of glyphs and the reader still gets a label for the one in question.
function ChatThreadEmojiPreview() {
  const { t } = useTranslation();
  const preview = useGet(chatThreadEmojiPreview$);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-3">
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
  railEnabled,
}: {
  categories: ChatThreadEmojiCategory[];
  searchResults: ChatThreadEmojiItem[] | null;
  onSelect: (emoji: string) => void;
  railEnabled: boolean;
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
      onScroll={railEnabled ? handleScroll : undefined}
      onWheel={railEnabled ? releasePendingJump : undefined}
      onTouchStart={railEnabled ? releasePendingJump : undefined}
      onPointerDown={railEnabled ? releasePendingJump : undefined}
      onMouseOver={
        railEnabled
          ? (event) => {
              previewEmojiUnder(event.target);
            }
          : undefined
      }
      onFocus={
        railEnabled
          ? (event) => {
              previewEmojiUnder(event.target);
            }
          : undefined
      }
      onMouseLeave={
        railEnabled
          ? () => {
              setPreview(null);
            }
          : undefined
      }
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
              pinnedTitle={railEnabled}
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
  pinnedTitle = false,
}: {
  categoryKey: string;
  label: string;
  items: ChatThreadEmojiItem[];
  onSelect: (emoji: string) => void;
  showShortcutDigits?: boolean;
  shortcodeNames?: boolean;
  pinnedTitle?: boolean;
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
    >
      <div
        className={cn(
          "flex items-baseline justify-between gap-2 px-1 pb-1 pt-2",
          // Fade to transparent at the lower edge so emoji dissolve as they
          // scroll under the pinned title instead of colliding with it.
          // pt-1/pb-3 shifts the label up towards the search field while
          // keeping the box — and so the painted fade — the same 32px tall as
          // the pt-2/pb-2 it replaces.
          pinnedTitle &&
            "sticky top-0 z-10 bg-gradient-to-b from-popover from-60% to-transparent pb-3 pt-1",
        )}
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
            className="relative flex aspect-square items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-state-hover"
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

function formatChatTimestamp(value: string): string {
  return new Date(value).toLocaleString(resolvedAppLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type ChatImagePreviewLinkProps = {
  alt: string;
  ariaLabel: string;
  imageClassName: string;
  linkClassName: string;
  onPreview: () => void;
  placeholderClassName: string;
  resourceUrl$: ArtifactSignals["resourceUrl$"];
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

function ChatImagePreviewLink({
  alt,
  ariaLabel,
  imageClassName,
  linkClassName,
  onPreview,
  placeholderClassName,
  resourceUrl$,
  url,
}: ChatImagePreviewLinkProps) {
  const imageLoadStatuses = useGet(imageLoadStatusByKey$);
  const imageLoadStatusRef = useSet(imageLoadStatusRef$);
  const setImageLoadStatus = useSet(setImageLoadStatus$);
  const imageUrl = publicAttachmentUrl(url);
  const resourceUrl = useLastResolved(resourceUrl$) ?? null;
  const previewImageUrl =
    resourceUrl === null
      ? null
      : r2ImageTransformUrl(resourceUrl, {
          width: 800,
          height: 720,
        });
  const imageLoadKey = `chat-image-preview:${previewImageUrl ?? imageUrl}`;
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
      href={resourceUrl ?? imageUrl}
      onClick={openPreview}
      className={cn(
        "group/image-preview relative inline-flex self-start items-center justify-center overflow-hidden",
        linkClassName,
      )}
      aria-label={ariaLabel}
    >
      {/* Preserve one flex item so the inline baseline cannot change on load. */}
      <span aria-hidden="true" className="block h-full w-full" />
      {showPlaceholder && (
        <span
          data-testid="chat-image-preview-loading"
          className={cn(
            "absolute inset-0 flex items-center justify-center bg-muted/70 text-muted-foreground",
            placeholderClassName,
          )}
        >
          {imageStatus === "loading" ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Image size={18} />
          )}
        </span>
      )}
      {previewImageUrl !== null ? (
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
            "absolute inset-0",
            imageClassName,
            showPlaceholder && "opacity-0",
          )}
        />
      ) : null}
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
          <Play size={17} />
        </span>
      </span>
    </button>
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
    case "gmail-label-applied":
    case "github-label-applied": {
      return i18n.t(
        ($) => {
          return $.chat.automations.matchSummary.label;
        },
        {
          value: quotedAutomationValue(automation.eventConfig.labelName),
        },
      );
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
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

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

export function ZeroChatThreadPage() {
  const activeThreadSidebar = useGet(activeThreadSidebar$);
  const leftPane = useGet(currentLeftPane$);
  const rightPane = useGet(currentRightPane$);
  const lightboxUrl = useGet(attachmentLightboxUrl$);
  return (
    <>
      <ChatThreadSidebarShell
        animateEntry={activeThreadSidebar?.animateEntry ?? true}
        open={activeThreadSidebar !== null}
        sidebar={
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
        }
      >
        <ChatThreadArea leftPane={leftPane} rightPane={rightPane} />
      </ChatThreadSidebarShell>
      {lightboxUrl && <AttachmentLightbox />}
      <SentTemplateDetailDialog />
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

const CHAT_THREAD_CONTENT_MAIN_CLASS =
  "items-center py-4 pl-4 pr-4 sm:pl-6 sm:pr-6 @container";
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
  const runGroupExpansionOverrides = useGet(runGroupExpansionOverrides$);
  const toggleRunGroupExpanded = useSet(toggleRunGroupExpanded$);
  const runGroupFolding = buildRunGroupFolding(
    renderedActiveGroups,
    runGroupExpansionOverrides,
    scrollTargetEventId,
  );
  const runGroupVisibleGroups =
    runGroupFolding?.visibleGroups ?? renderedActiveGroups;
  const completedWorkFolding = buildCompletedWorkFolding(runGroupVisibleGroups);
  const completedWorkExpandedKeys = useGet(completedWorkExpandedKeys$);
  const effectiveCompletedWorkExpandedKeys =
    completedWorkExpandedKeysForScrollTarget(
      completedWorkFolding,
      completedWorkExpandedKeys,
      scrollTargetEventId,
    );
  const toggleCompletedWorkExpanded = useSet(toggleCompletedWorkExpanded$);
  const visibleGroups =
    completedWorkFolding?.visibleGroups ?? runGroupVisibleGroups;

  return (
    <>
      <ChatThreadEventGroups
        thread={thread}
        groups={visibleGroups}
        modelChanges={modelChanges}
        runGroupFolding={runGroupFolding}
        onToggleRunGroup={toggleRunGroupExpanded}
        completedWorkFolding={completedWorkFolding}
        completedWorkExpandedKeys={effectiveCompletedWorkExpandedKeys}
        onToggleCompletedWork={toggleCompletedWorkExpanded}
      />
      <ChatThreadScrollCommitMarker
        thread={thread}
        renderedGroups={resolvedRenderedGroups}
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
  const renderedGroupsReady =
    useLastResolved(thread.visibleRenderedChatGroupsReady$) ?? false;
  const threadSettledInServer = useGet(thread.threadSettledInServer$);
  const hasEvents = useLastResolved(thread.hasEvents$);
  if (!renderedGroupsReady || !threadSettledInServer || hasEvents !== false) {
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
          "w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4 overflow-visible",
          sharingPhase !== "idle" && "pr-10 lg:pr-0",
        )}
        style={{ visibility: renderedGroupsReady ? "visible" : "hidden" }}
      >
        <ChatThreadSessionError thread={thread} />
        <ChatThreadEmptyState thread={thread} />
        <ChatHistoryBackfillSkeleton thread={thread} />
        <ChatThreadRenderedEventGroups thread={thread} />
        <ChatThreadThinkingIndicator thread={thread} />
        <ChatThreadNextRunModelNotice thread={thread} />
      </div>
    </main>
  );
}

function ChatThreadThinkingIndicator({ thread }: { thread: ChatPanelSignals }) {
  return <ThinkingIndicator thread={thread} />;
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

function ChatThreadEventGroups({
  thread,
  groups,
  modelChanges,
  runGroupFolding,
  onToggleRunGroup,
  completedWorkFolding,
  completedWorkExpandedKeys,
  onToggleCompletedWork,
}: {
  thread: ChatPanelSignals;
  groups: readonly ChatEventGroup[];
  modelChanges: ReadonlyMap<string, RunModelChange>;
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
          externalRunGroupFolds.get(group.beginEventId) ?? [];
        const embeddedFolds =
          embeddedRunGroupFolds.get(group.beginEventId) ?? [];
        const completedWorkFold = completedWorkFoldForGroup(
          completedWorkFolding,
          group,
        );
        const completedWorkExpanded =
          completedWorkFold !== null &&
          completedWorkExpandedKeys.has(completedWorkFold.key);
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
  groups: readonly ChatEventGroup[];
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

  return { embeddedRunGroupFolds, externalRunGroupFolds };
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

function completedWorkFoldForGroup(
  completedWorkFolding: CompletedWorkFolding | null,
  group: ChatEventGroup,
): CompletedWorkFold | null {
  if (completedWorkFolding === null) {
    return null;
  }
  return (
    group.events
      .map((event) => {
        return completedWorkFolding.foldsByFinalEventId.get(event.id);
      })
      .find((fold) => {
        return fold !== undefined;
      }) ?? null
  );
}

function groupEventsByRole(
  events: readonly EnrichedChatEvent[],
): ChatEventGroup[] {
  const groups: ChatEventGroup[] = [];
  for (const event of events) {
    const role = chatEventCompatibilityRole(event.eventType);
    const last = groups[groups.length - 1];
    if (last && last.role === role) {
      last.events.push(event);
      continue;
    }
    groups.push({
      beginEventId: event.id,
      role,
      events: [event],
    });
  }
  return groups;
}

interface CompletedWorkFold {
  key: string;
  finalEventId: string;
  hiddenGroups: ChatEventGroup[];
  labelGroups: ChatEventGroup[];
}

interface CompletedWorkFolding {
  visibleGroups: ChatEventGroup[];
  foldsByFinalEventId: Map<string, CompletedWorkFold>;
}

function completedWorkExpandedKeysForScrollTarget(
  folding: CompletedWorkFolding | null,
  expandedKeys: ReadonlySet<string>,
  targetEventId: string | null,
): ReadonlySet<string> {
  if (folding === null || targetEventId === null) {
    return expandedKeys;
  }
  const targetFold = Array.from(folding.foldsByFinalEventId.values()).find(
    (fold) => {
      return fold.hiddenGroups.some((group) => {
        return group.events.some((event) => {
          return event.id === targetEventId;
        });
      });
    },
  );
  if (!targetFold || expandedKeys.has(targetFold.key)) {
    return expandedKeys;
  }
  const next = new Set(expandedKeys);
  next.add(targetFold.key);
  return next;
}

function groupEventsForCompletedWorkDisplay(
  events: readonly EnrichedChatEvent[],
  foldFinalEventIds: ReadonlySet<string>,
): ChatEventGroup[] {
  const groups: ChatEventGroup[] = [];
  for (const event of events) {
    const role = chatEventCompatibilityRole(event.eventType);
    const forceStandalone = foldFinalEventIds.has(event.id);
    const last = groups[groups.length - 1];
    const lastHasFoldFinal =
      last?.events.some((candidate) => {
        return foldFinalEventIds.has(candidate.id);
      }) ?? false;
    const lastFoldFinal = last?.events.find((candidate) => {
      return foldFinalEventIds.has(candidate.id);
    });
    const continuesFoldFinalRun =
      lastFoldFinal?.runId !== undefined && lastFoldFinal.runId === event.runId;

    if (
      !forceStandalone &&
      last &&
      last.role === role &&
      (!lastHasFoldFinal || continuesFoldFinalRun)
    ) {
      last.events.push(event);
      continue;
    }

    groups.push({
      beginEventId: event.id,
      role,
      events: [event],
    });
  }
  return groups;
}

function firstRunIdForEvents(
  events: readonly EnrichedChatEvent[],
): string | undefined {
  return events.find((event) => {
    return event.runId !== undefined;
  })?.runId;
}

function usageByRunIdFromGroups(
  groups: readonly ChatEventGroup[],
): Map<string, ChatEventUsagePayload> {
  return foldLatestChatUsageByRunId(
    groups.flatMap((group) => {
      const runId = firstRunIdForEvents(group.events);
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
  groups: readonly ChatEventGroup[],
  usageByRunId: ReadonlyMap<string, ChatEventUsagePayload>,
): ChatEventGroup[] {
  const lastAssistantGroupIndexByRunId = new Map<string, number>();
  for (const [index, group] of groups.entries()) {
    if (
      group.role !== "assistant" ||
      !group.events.some(isRenderableAssistantEvent)
    ) {
      continue;
    }
    const runId = firstRunIdForEvents(group.events);
    if (runId !== undefined) {
      lastAssistantGroupIndexByRunId.set(runId, index);
    }
  }
  return groups.map((group, index) => {
    if (group.role !== "assistant") {
      return group;
    }
    const runId = firstRunIdForEvents(group.events);
    if (
      runId === undefined ||
      lastAssistantGroupIndexByRunId.get(runId) !== index
    ) {
      return group;
    }
    const usage = usageByRunId.get(runId);
    return usage === undefined ? group : { ...group, usage };
  });
}

function isRenderableAssistantEvent(event: EnrichedChatEvent): boolean {
  return (
    chatEventCompatibilityRole(event.eventType) === "assistant" &&
    ((isChatEventContentTextType(event.eventType) && Boolean(event.content)) ||
      Boolean(chatEventError(event)) ||
      event.blocks.length > 0 ||
      Boolean(chatEventAttachments(event)?.length))
  );
}

function isThinkingOnlyAssistantEvent(event: EnrichedChatEvent): boolean {
  return (
    event.eventType === "output.thinking" && event.thinking.trim().length > 0
  );
}

function terminatedRunIdsForCompletedWork(
  events: readonly EnrichedChatEvent[],
): Set<string> {
  return terminatedChatRunIds(events);
}

function splitCompletedWorkEventsAtUsers(
  events: readonly EnrichedChatEvent[],
): EnrichedChatEvent[][] {
  const phases: EnrichedChatEvent[][] = [];
  let phase: EnrichedChatEvent[] = [];
  for (const event of events) {
    if (
      phase.length > 0 &&
      chatEventCompatibilityRole(event.eventType) === "user"
    ) {
      phases.push(phase);
      phase = [];
    }
    phase.push(event);
  }
  if (phase.length > 0) {
    phases.push(phase);
  }
  return phases;
}

function lastCompletedWorkEventIndex(
  events: readonly EnrichedChatEvent[],
  predicate: (event: EnrichedChatEvent) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index--) {
    if (predicate(events[index]!)) {
      return index;
    }
  }
  return -1;
}

function completedWorkFinalEventIndex(
  events: readonly EnrichedChatEvent[],
): number {
  return lastCompletedWorkEventIndex(events, isRenderableAssistantEvent);
}

function canFoldCompletedWorkTrailingEvent(event: EnrichedChatEvent): boolean {
  const role = chatEventCompatibilityRole(event.eventType);
  return (
    role === "user" ||
    (role === "assistant" && !isRenderableAssistantEvent(event))
  );
}

interface CompletedWorkPhaseFolding {
  visibleEvents: readonly EnrichedChatEvent[];
  fold: CompletedWorkFold | null;
}

function foldCompletedWorkPhase(
  runId: string,
  events: readonly EnrichedChatEvent[],
): CompletedWorkPhaseFolding {
  const finalEventIndex = completedWorkFinalEventIndex(events);
  const finalEvent =
    finalEventIndex >= 0 ? events[finalEventIndex]! : undefined;
  const precedingEvents =
    finalEventIndex > 0 ? events.slice(0, finalEventIndex) : [];
  const hiddenEvents = precedingEvents.filter((event) => {
    return (
      chatEventCompatibilityRole(event.eventType) !== "user" &&
      !isThinkingOnlyAssistantEvent(event)
    );
  });
  const userEvents = events.filter((event) => {
    return chatEventCompatibilityRole(event.eventType) === "user";
  });
  const trailingEvents =
    finalEventIndex >= 0 ? events.slice(finalEventIndex + 1) : [];
  const trailingEventsCanFold = trailingEvents.every((event) => {
    return canFoldCompletedWorkTrailingEvent(event);
  });
  if (
    finalEvent === undefined ||
    hiddenEvents.length === 0 ||
    !trailingEventsCanFold
  ) {
    return { visibleEvents: events, fold: null };
  }
  return {
    visibleEvents: [
      ...userEvents,
      finalEvent,
      ...trailingEvents.filter(isRenderableAssistantEvent),
    ],
    fold: {
      key: `${runId}:${finalEvent.id}`,
      finalEventId: finalEvent.id,
      hiddenGroups: groupEventsByRole(hiddenEvents),
      labelGroups: groupEventsByRole(events),
    },
  };
}

function buildCompletedWorkFolding(
  groups: readonly ChatEventGroup[],
): CompletedWorkFolding | null {
  const usageByRunId = usageByRunIdFromGroups(groups);
  const events = groups.flatMap((group) => {
    return group.events;
  });
  const terminatedRunIds = terminatedRunIdsForCompletedWork(events);
  const visibleEvents: EnrichedChatEvent[] = [];
  const folds: CompletedWorkFold[] = [];
  let hasCompletedWorkPhaseBoundary = false;

  for (let index = 0; index < events.length; ) {
    const runId = events[index]!.runId;
    if (runId === undefined) {
      visibleEvents.push(events[index]!);
      index++;
      continue;
    }

    let endIndex = index + 1;
    while (endIndex < events.length && events[endIndex]!.runId === runId) {
      endIndex++;
    }

    const runEvents = events.slice(index, endIndex);
    if (!terminatedRunIds.has(runId) || runEvents.some(isCancelledRunEvent)) {
      visibleEvents.push(...runEvents);
      index = endIndex;
      continue;
    }

    const completedWorkEventGroups = splitCompletedWorkEventsAtUsers(runEvents);
    if (completedWorkEventGroups.length > 1) {
      hasCompletedWorkPhaseBoundary = true;
    }
    for (const completedWorkEvents of completedWorkEventGroups) {
      const phaseFolding = foldCompletedWorkPhase(runId, completedWorkEvents);
      visibleEvents.push(...phaseFolding.visibleEvents);
      if (phaseFolding.fold !== null) {
        folds.push(phaseFolding.fold);
      }
    }

    index = endIndex;
  }

  if (folds.length === 0 && !hasCompletedWorkPhaseBoundary) {
    return null;
  }

  const foldFinalEventIds = new Set(
    folds.map((fold) => {
      return fold.finalEventId;
    }),
  );
  return {
    visibleGroups: attachUsageToCompletedWorkGroups(
      groupEventsForCompletedWorkDisplay(visibleEvents, foldFinalEventIds),
      usageByRunId,
    ),
    foldsByFinalEventId: new Map(
      folds.map((fold) => {
        return [fold.finalEventId, fold];
      }),
    ),
  };
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
  const label =
    change.kind === "model"
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
  return <RunSectionDividerRow label={label} />;
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
  const chatSkeletonVisible = useGet(thread.chatSkeletonVisible$);
  if (!chatSkeletonVisible) {
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
        <ChatThreadEventsMain key={thread.threadId} thread={thread} />
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

function ChatHistoryBackfillSkeleton({ thread }: { thread: ChatPanelSignals }) {
  const { t } = useTranslation();
  const historyBackfillPending = useGet(thread.historyBackfillPending$);
  if (!historyBackfillPending) {
    return null;
  }
  return (
    <div
      data-history-backfill-skeleton
      role="status"
      aria-label={t(($) => {
        return $.chat.thread.loadingEarlier;
      })}
      className="flex flex-col gap-6"
    >
      <ChatEventSkeletonPair />
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
          {/* Command loadables are hook-owned, so keep their identity boundary
              narrower than the persistent thread and event owners. */}
          <ChatThreadBottomBar key={thread.threadId} thread={thread} />
        </div>
      </div>

      <ChatFeedbackSelection feedback={thread.feedback} />
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
      aria-label={t(($) => {
        return $.chat.thread.scrollToBottom;
      })}
      onClick={() => {
        scrollToBottom();
      }}
      className="absolute bottom-4 left-1/2 z-20 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-md transition-colors hover:bg-background-hover hover:text-foreground"
    >
      <ArrowDown size={18} />
    </button>
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
              mathEnabled
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
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-[21px] bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div
        className={cn(
          "overflow-y-auto [scrollbar-gutter:stable] pb-2 pl-4 pr-4 pt-3 sm:pl-6 sm:pr-6",
          standalonePwa && "overscroll-contain",
        )}
      >
        <div className="mx-auto max-w-[900px]">
          <ZeroChatComposer signals={thread.composer} />
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
        className="zero-shimmer-text h-5 w-full overflow-hidden whitespace-nowrap"
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
  const pageSignal = useGet(pageSignal$);

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
            openQueueDrawer(pageSignal);
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
  thread: ChatPanelSignals;
  source: RecommendedFollowupSource | null;
}) {
  const { t } = useTranslation();
  const donePhrase =
    useLastResolved(thread.donePhrase$) ??
    t(($) => {
      return $.chat.run.done.default;
    });
  const runFinishedAt = useLastResolved(thread.latestRunFinishCreatedAt$);
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
  thinkingLabel,
  serverThinkingLabel,
}: {
  thread: ChatPanelSignals;
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
          <div className="flex h-5 min-w-0 items-center gap-2">
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
  thread: ChatPanelSignals;
  recommendedFollowupSource: RecommendedFollowupSource | null;
}) {
  const thinkingIndicatorProps = running
    ? { "data-thinking-indicator": true }
    : {};

  return (
    <div
      {...thinkingIndicatorProps}
      data-role="assistant-thinking"
      className={RUN_SECTION_ROW_CLASS}
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
      previous.eventId === next.eventId &&
      previous.followups === next.followups)
  );
}

function ThinkingIndicator({ thread }: { thread: ChatPanelSignals }) {
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
  const thinkingEventId = useLastResolved(thread.thinkingEventId$);
  const displayedThinkingText =
    useLastResolved(thread.displayedThinkingText$) ?? "";
  const thinkingTextFadingOut =
    useLastResolved(thread.thinkingTextFadingOut$) ?? false;
  const setThinkingIndicatorTextRef = useSet(
    thread.setThinkingIndicatorTextRef$,
  );
  const serverThinkingLabel =
    thinkingText && thinkingEventId && running
      ? {
          displayedText: displayedThinkingText,
          fadingOut: thinkingTextFadingOut,
          fullText: thinkingText,
          id: thinkingEventId,
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

function BodyContentBlocks({
  blocks,
  mermaidScope,
  openLightbox,
  hardBreaks,
  escapeMarkdownHtml = false,
  markdownMediaPreview = true,
}: {
  blocks: BodyRenderBlock[];
  mermaidScope: string;
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
            mermaidScope={mermaidScope}
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
  mermaidScope,
  openLightbox,
  openVideoLightbox,
  hardBreaks,
  escapeMarkdownHtml,
  markdownMediaPreview,
}: {
  block: BodyRenderBlock;
  mermaidScope: string;
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
          mermaidScope={mermaidScope}
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
  const { t } = useTranslation();
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
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: signals.filename,
          },
        )}
        imageClassName="block h-full w-full object-contain"
        linkClassName={CHAT_INLINE_IMAGE_PREVIEW_CLASS}
        onPreview={() => {
          openLightbox(signals.url);
        }}
        placeholderClassName="h-full w-full"
        resourceUrl$={signals.resourceUrl$}
        url={signals.url}
      />
    );
  }
  if (signals.kind === "video") {
    return (
      <ChatVideoPreviewButton
        ariaLabel={t(
          ($) => {
            return $.chat.attachments.previewFile;
          },
          {
            filename: signals.filename,
          },
        )}
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

const CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS = "h-[136px] sm:h-[88px]";

function ConnectorActionCardSkeleton() {
  return (
    <Skeleton
      data-testid="connector-action-card-loading"
      className={cn(
        "w-full rounded-[var(--zero-card-radius)]",
        CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS,
      )}
    />
  );
}

function CatalogConnectorActionCard({
  signals,
}: {
  signals: CatalogConnectorSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const catalogItemLoadable = useLastLoadable(signals.catalogItem$);
  const catalogItem = useLastResolved(signals.catalogItem$);
  const connected = useLastResolved(signals.connected$) ?? false;
  const completeLoadable = useLoadable(signals.complete$);
  const complete =
    completeLoadable.state === "hasData" && completeLoadable.data;
  const [activateLoadable, activate] = useLoadableSet(signals.activate$);
  const loading =
    completeLoadable.state === "loading" ||
    activateLoadable.state === "loading";
  if (!catalogItem && catalogItemLoadable.state === "loading") {
    return <ConnectorActionCardSkeleton />;
  }
  if (!catalogItem) {
    return null;
  }

  return (
    <ConnectorCard
      variant="action"
      className={cn(
        "justify-between overflow-hidden",
        CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS,
      )}
      icon={<ConnectorIcon icon={catalogItem.icon} size={22} />}
      label={catalogItem.label}
      description={catalogItem.description}
      connected={connected}
      complete={complete}
      reconnectRequired={
        connectorCurrentConnectionStatus(catalogItem) === "reconnect-required"
      }
      busy={loading}
      onActivate={() => {
        detach(activate(pageSignal), Reason.DomCallback);
      }}
    />
  );
}

function CustomConnectorActionCard({
  signals,
}: {
  signals: CustomConnectorSignals;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const connectorLoadable = useLastLoadable(signals.connector$);
  const connector = useLastResolved(signals.connector$);
  const connected = useLastResolved(signals.connected$) ?? false;
  const completeLoadable = useLoadable(signals.complete$);
  const complete =
    completeLoadable.state === "hasData" && completeLoadable.data;
  const [activateLoadable, activate] = useLoadableSet(signals.activate$);
  const loading =
    completeLoadable.state === "loading" ||
    activateLoadable.state === "loading";
  if (!connector && connectorLoadable.state === "loading") {
    return <ConnectorActionCardSkeleton />;
  }
  if (!connector) {
    return null;
  }

  return (
    <ConnectorCard
      variant="action"
      className={cn(
        "justify-between overflow-hidden",
        CHAT_CONNECTOR_ACTION_CARD_HEIGHT_CLASS,
      )}
      icon={
        <CustomConnectorIcon
          id={connector.id}
          displayName={connector.displayName}
          size={22}
        />
      }
      label={connector.displayName}
      description={t(($) => {
        return $.chat.connectors.customAuthorizeDescription;
      })}
      connected={connected}
      complete={complete}
      reconnectRequired={false}
      busy={loading}
      onActivate={() => {
        detach(activate(pageSignal), Reason.DomCallback);
      }}
    />
  );
}

function ConnectorActionCard({ signals }: { signals: ConnectorSignals }) {
  return signals.kind === "catalog" ? (
    <CatalogConnectorActionCard signals={signals} />
  ) : (
    <CustomConnectorActionCard signals={signals} />
  );
}

function ComputerUseAuthorizationCard({
  signals,
}: {
  signals: ComputerUseAuthorizationSignals;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="computer-use-authorization-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <Monitor size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.computerUse.authorization;
            })}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.chat.computerUse.authorizationDescription;
            })}
          </div>
        </div>
      </div>
      <a
        href={signals.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-state-hover sm:w-auto"
      >
        {t(($) => {
          return $.chat.actions.authorize;
        })}
        <ArrowUpRight size={15} />
      </a>
    </div>
  );
}

function PlanUpgradeCard({ signals }: { signals: PlanUpgradeSignals }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="plan-upgrade-card"
      className="flex min-h-[88px] w-full flex-col gap-3 rounded-lg border border-border/70 bg-background/85 p-3 text-left shadow-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40">
          <Coins size={22} />
        </div>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium text-foreground">
            {t(($) => {
              return $.chat.billing.upgradeWorkspace;
            })}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {t(($) => {
              return $.chat.billing.comparePlansDescription;
            })}
          </div>
        </div>
      </div>
      <a
        href={signals.href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-state-hover sm:w-auto"
      >
        {t(($) => {
          return $.chat.billing.comparePlans;
        })}
        <ArrowUpRight size={15} />
      </a>
    </div>
  );
}

type PermissionAction = "allow" | "deny";

type PermissionActionUserGrant = PlatformUserPermissionGrant;

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
    connectorSlug: string;
    permission: string;
    action: PermissionAction;
    expiresIn?: UserPermissionGrantExpiresIn;
  },
  signal: AbortSignal,
) => Promise<PlatformUserPermissionGrant>;

function loadableData<T>(loadable: LoadableLike<T>): T | undefined {
  return loadable.state === "hasData" ? loadable.data : undefined;
}

function permissionActionVerb(action: PermissionAction): string {
  return action === "allow"
    ? i18n.t(($) => {
        return $.chat.permissions.allow;
      })
    : i18n.t(($) => {
        return $.chat.permissions.deny;
      });
}

function permissionActionStatusText(
  status: PermissionActionCardStatus,
  action: "allow" | "deny",
): { label: string; className: string } | null {
  if (status.kind === "saved") {
    return action === "allow"
      ? {
          label: i18n.t(($) => {
            return $.chat.permissions.updated;
          }),
          className: "text-green-600",
        }
      : {
          label: i18n.t(($) => {
            return $.chat.permissions.denied;
          }),
          className: "text-destructive",
        };
  }
  if (status.kind === "already-applied") {
    return action === "allow"
      ? {
          label: i18n.t(($) => {
            return $.chat.permissions.alreadyAllowed;
          }),
          className: "text-green-600",
        }
      : {
          label: i18n.t(($) => {
            return $.chat.permissions.alreadyDenied;
          }),
          className: "text-destructive",
        };
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
  const { t } = useTranslation();
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
      className="inline-flex h-9 w-full min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-state-hover sm:w-auto sm:flex-none"
    >
      {saving && <Loader2 size={15} className="animate-spin" />}
      {saving
        ? t(($) => {
            return $.chat.actions.saving;
          })
        : t(($) => {
            return $.chat.actions.confirm;
          })}
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
  const { t } = useTranslation();
  switch (status.kind) {
    case "loading": {
      return (
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          <span>
            {t(($) => {
              return $.chat.permissions.checking;
            })}
          </span>
        </div>
      );
    }
    case "load-error": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.loadFailed;
            })}
          </span>
        </div>
      );
    }
    case "save-error": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.updateFailed;
            })}
          </span>
        </div>
      );
    }
    case "missing-target": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.agentNotFound;
            })}
          </span>
        </div>
      );
    }
    case "missing-permission": {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-destructive">
          <AlertCircle size={13} />
          <span>
            {t(($) => {
              return $.chat.permissions.unknown;
            })}
          </span>
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

function permissionActionHasControls(
  status: PermissionActionCardStatus,
): boolean {
  switch (status.kind) {
    case "loading":
    case "save-error":
    case "ready":
    case "saving":
    case "saved":
    case "already-applied": {
      return true;
    }
    case "load-error":
    case "missing-target":
    case "missing-permission": {
      return false;
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
  metadata: PlatformConnectorPermissionMetadata | undefined,
) {
  return metadata
    ? (findPermissionInMetadata(metadata, block.permission) ?? undefined)
    : undefined;
}

function permissionActionUserGrantPolicy(
  loadable: LoadableLike<readonly PermissionActionUserGrant[]>,
  block: PermissionSignals,
  metadata: PlatformConnectorPermissionMetadata | undefined,
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
      grant.connectorSlug === block.connectorSlug &&
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
  permissionMetadataLoadable: LoadableLike<PlatformConnectorPermissionMetadata | null>;
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

function createPermissionActionHandler(
  params: {
    block: PermissionSignals;
    focusedPermission:
      | {
          name: string;
        }
      | undefined;
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
  },
  pageSignal: AbortSignal,
): () => void {
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
                connectorSlug: params.block.connectorSlug,
                permission: permissionName,
                action: params.block.action,
                ...(params.expirationAvailable
                  ? { expiresIn: params.expiresIn }
                  : {}),
              },
              pageSignal,
            );
            if (params.block.callbackPrompt && params.block.threadId) {
              await params.runCallback(
                {
                  threadId: params.block.threadId,
                  agentId: params.block.agentId,
                  callbackPrompt: params.block.callbackPrompt,
                },
                pageSignal,
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
  icon: PlatformConnectorPermissionMetadata["icon"] | undefined;
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
  const { t } = useTranslation();
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const remainingMs = expiresAtMs - now();
  const hourCount = Math.ceil(remainingMs / (60 * 60 * 1000));
  const dayCount = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  const expiryText =
    !expirationAvailable || !Number.isFinite(expiresAtMs)
      ? null
      : remainingMs <= 0
        ? t(($) => {
            return $.chat.permissions.expired;
          })
        : remainingMs >= 24 * 60 * 60 * 1000
          ? t(
              ($) => {
                return $.chat.permissions.expiresInDays;
              },
              { count: dayCount },
            )
          : remainingMs < 59 * 60 * 1000 || hourCount === 1
            ? null
            : t(
                ($) => {
                  return $.chat.permissions.expiresInHours;
                },
                {
                  count: hourCount,
                },
              );
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
            {t(
              ($) => {
                return $.chat.permissions.connectorTitle;
              },
              {
                connectorName: connectorLabel,
              },
            )}
          </div>
          <div className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {t(
              ($) => {
                return $.chat.permissions.actionDescription;
              },
              {
                action: actionLabel,
                permissionName,
              },
            )}
          </div>
          {status.kind !== "loading" && (
            <PermissionActionInlineStatus status={status} />
          )}
          {expiryText && (
            <div className="mt-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              {expiryText}
            </div>
          )}
        </div>
      </div>
      {permissionActionHasControls(status) && (
        <div
          data-testid="permission-action-card-controls"
          className="flex min-h-9 w-full shrink-0 flex-row items-center gap-2 sm:w-auto"
        >
          {status.kind === "loading" && (
            <PermissionActionInlineStatus status={status} />
          )}
          {showDurationSelect && (
            <PermissionGrantDurationSelect
              value={expiresIn}
              onValueChange={onExpiresInChange}
              disabled={status.kind === "saving"}
              ariaLabel={t(($) => {
                return $.chat.permissions.duration;
              })}
            />
          )}
          <PermissionActionTerminalStatus
            status={status}
            action={signals.action}
          />
          <PermissionActionButton status={status} onClick={onClick} />
        </div>
      )}
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
      connectorLabel={permissionMetadata?.label ?? signals.connectorSlug}
      actionLabel={actionState.actionLabel}
      permissionName={actionState.focusedPermission?.name ?? signals.permission}
      status={actionState.status}
      expirationAvailable={expirationAvailable}
      expiresIn={expiresIn}
      onExpiresInChange={(value) => {
        setExpiresInForScope(durationScope, value);
      }}
      expiresAt={grantExpiresAt}
      onClick={createPermissionActionHandler(
        {
          block: signals,
          focusedPermission: actionState.focusedPermission,
          status: actionState.status,
          expirationAvailable,
          expiresIn,
          applyGrant,
          runCallback,
        },
        pageSignal,
      )}
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
    return connector ? (
      <CustomConnectorConnectDialog
        connector={connector}
        agentId={active.agentId}
        onClose={close}
        onSuccess={onSuccess}
      />
    ) : null;
  }

  return (
    <ConnectModal
      item={active.catalogItem}
      agentId={active.agentId}
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
  redirecting,
  handleCreditClick,
}: {
  readonly redirecting: boolean;
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
              disabled={redirecting}
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
              disabled={redirecting}
              variant="default"
              size="sm"
              className="disabled:opacity-60"
            >
              {redirecting
                ? t(($) => {
                    return $.chat.billing.redirecting;
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
        <Button
          type="button"
          onClick={handleUpgradeClick}
          disabled={redirecting}
          variant="default"
          size="sm"
          className="mt-3 disabled:opacity-60"
        >
          {redirecting
            ? t(($) => {
                return $.chat.billing.redirecting;
              })
            : t(($) => {
                return $.chat.billing.upgradeToPro;
              })}
        </Button>
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
  const setModelSelection = useSet(thread.composer.model.setModelSelection$);
  const [retryLoadable, retry] = useLoadableSet(thread.retryAssistantError$);
  const [resetLoadable, resetAndRetry] = useLoadableSet(
    thread.resetCodexSubscriptionAndRetry$,
  );
  const retrying = retryLoadable.state === "loading";
  const resetting = resetLoadable.state === "loading";
  const hasResetAction = recovery.actions.resetAndTryAgain !== null;
  const handleModelSelection = (
    selection: ModelProviderSelection | null,
  ): void => {
    if (!selection) {
      return;
    }
    detach(setModelSelection(selection, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {hasResetAction && (
        <Button
          type="button"
          size="sm"
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
      <ModelProviderPicker
        value={null}
        onChange={handleModelSelection}
        placeholder={t(($) => {
          return $.chat.errors.recovery.selectModel;
        })}
        triggerClassName="h-8 w-auto min-w-[9rem] bg-background text-sm"
        compactTrigger
        resolveDefaultSelection={false}
      />
      <Button
        type="button"
        size="sm"
        variant={hasResetAction ? "outline" : "default"}
        disabled={retrying || resetting}
        onClick={() => {
          detach(retry(pageSignal), Reason.DomCallback);
        }}
      >
        <AssistantRecoveryActionSpinner loading={retrying} />
        {t(($) => {
          return $.chat.errors.recovery.tryAgain;
        })}
      </Button>
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
  const framework =
    recovery.framework === "codex"
      ? t(($) => {
          return $.chat.errors.recovery.codex;
        })
      : t(($) => {
          return $.chat.errors.recovery.claudeCode;
        });

  return (
    <div
      role="status"
      data-testid="assistant-error-recovery"
      className="rounded-xl border border-border/80 bg-muted/35 p-4 text-foreground"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
          {recovery.kind === "usage-limit" ? (
            <Clock size={17} />
          ) : (
            <AlertCircle size={17} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-6">
            {recovery.kind === "usage-limit"
              ? t(
                  ($) => {
                    return $.chat.errors.recovery.usageTitle;
                  },
                  { framework },
                )
              : t(
                  ($) => {
                    return $.chat.errors.recovery.capacityTitle;
                  },
                  { framework },
                )}
          </div>
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
            {recovery.kind === "usage-limit"
              ? t(($) => {
                  return $.chat.errors.recovery.usageDescription;
                })
              : t(($) => {
                  return $.chat.errors.recovery.capacityDescription;
                })}
          </p>
          {resetText && (
            <div className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Clock size={14} className="text-muted-foreground" />
              {resetText}
            </div>
          )}
          <AssistantRecoveryActions recovery={recovery} thread={thread} />
        </div>
      </div>
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
      className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-state-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label={t(($) => {
        return $.chat.agentPage.viewAgentProfile;
      })}
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
// Paged event rendering — renders from visibleRenderedChatGroups$ (flat data,
// no signal-based run loops).
// ---------------------------------------------------------------------------

function PagedGroupRow({
  group,
  thread,
  modelChanges,
  runGroupFolds,
  completedWorkFold,
}: {
  group: ChatEventGroup;
  thread: ChatPanelSignals;
  modelChanges: ReadonlyMap<string, RunModelChange>;
  runGroupFolds?: readonly RunGroupFoldControl[];
  completedWorkFold?: {
    groups: readonly ChatEventGroup[];
    hiddenGroups: readonly ChatEventGroup[];
    expanded: boolean;
    onToggle: () => void;
  };
}) {
  if (group.role === "user") {
    return (
      <PagedUserGroup
        group={group}
        thread={thread}
        modelChanges={modelChanges}
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
  runGroupFolds,
  completedWorkFold,
}: Parameters<typeof PagedGroupRow>[0]) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const selectedEventIds = useGet(thread.sharing.selectedEventIds$);
  const toggle = useSet(thread.sharing.toggle$);
  const events = group.events.flatMap((event) => {
    const shareable = shareableEventFromChatEvent(event);
    return shareable ? [shareable] : [];
  });
  if (phase === "idle" || events.length === 0) {
    return (
      <PagedGroupRow
        group={group}
        thread={thread}
        modelChanges={modelChanges}
        runGroupFolds={runGroupFolds}
        completedWorkFold={completedWorkFold}
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
    const result = toggle(events);
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
        runGroupFolds={runGroupFolds}
        completedWorkFold={completedWorkFold}
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
  runGroupFolds,
}: {
  group: ChatEventGroup;
  thread: ChatPanelSignals;
  modelChanges: ReadonlyMap<string, RunModelChange>;
  runGroupFolds?: readonly RunGroupFoldControl[];
}) {
  return (
    <>
      {group.events.map((event) => {
        const modelChange = modelChanges.get(event.id);
        return (
          <div key={event.id} className="contents">
            {modelChange === undefined ? null : (
              <ModelChangeDividerRow change={modelChange} />
            )}
            <PagedUserMessage event={event} thread={thread} />
          </div>
        );
      })}
      {runGroupFolds?.map((fold) => {
        return <RunGroupFoldRow key={fold.fold.key} control={fold} />;
      })}
    </>
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
    return attachment ? [attachment] : [];
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
    <div className="flex justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
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
  if (renderPart.type === "morning_brief") {
    return (
      <div
        aria-label={t(($) => {
          return $.settings.preferences.morningBrief.title;
        })}
        className={className}
      >
        <Sunrise size={15} className="shrink-0" />
        <span>
          {t(($) => {
            return $.settings.preferences.morningBrief.title;
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
// Layout without a display class so the spec-bearing chip can pick its own
// responsive display (hidden sm:inline-flex / sm:hidden) per variant.
const STRUCTURED_INLINE_REFERENCE_LAYOUT_CLASS =
  "relative -top-px mx-0.5 h-7 items-center " +
  "gap-1.5 rounded-md bg-orange-500/10 px-2 align-middle text-[13px] " +
  "font-medium text-orange-600 dark:bg-orange-400/15 dark:text-orange-300";
const STRUCTURED_INLINE_REFERENCE_BASE_CLASS = `inline-flex ${STRUCTURED_INLINE_REFERENCE_LAYOUT_CLASS}`;
const STRUCTURED_INLINE_REFERENCE_CLASS = `${STRUCTURED_INLINE_REFERENCE_BASE_CLASS} max-w-[240px]`;
const STRUCTURED_INLINE_INTERACTIVE_CLASS =
  "transition-colors hover:bg-orange-500/15 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-orange-500/30 " +
  "active:bg-orange-500/20 dark:hover:bg-orange-400/20 " +
  "dark:active:bg-orange-400/25";
const STRUCTURED_INLINE_LINK_REFERENCE_CLASS = `${STRUCTURED_INLINE_REFERENCE_CLASS} ${STRUCTURED_INLINE_INTERACTIVE_CLASS}`;

/**
 * Read-only echo of the parameters a sent video used. Rendered only inside
 * the wide-viewport chip variant, which owns the responsive visibility.
 */
function SentVideoTemplateSpec({ spec }: { readonly spec: VideoTemplateSpec }) {
  return (
    <span className="shrink-0 text-[12px] font-normal text-orange-600/70 dark:text-orange-300/70">
      {videoTemplateSpecText(spec)}
    </span>
  );
}

/**
 * A sent template is a record of what the message used, not an editing
 * control. Templates without a spec render as static text. A spec-bearing
 * video chip stays a static record on wide viewports too — the inline echo
 * and hover title already carry the spec there — and only the touch-width
 * variant is a button opening the read-only detail dialog, because narrow
 * viewports hide the inline echo and touch has no hover title.
 */
function UserMessageTemplateReference({
  part,
}: {
  part: Extract<UserMessagePart, { type: "template" }>;
}) {
  const typeLabel = generationTemplateTypeLabel(part.template);
  const videoOptionsEnabled = useGet(videoTemplateOptionsEnabled$);
  const openDetail = useSet(openSentTemplateDetail$);
  const spec = videoOptionsEnabled ? videoTemplateSpec(part.template) : null;
  const label = `${typeLabel ?? part.template.type} · ${part.titleSnapshot}`;
  if (spec === null) {
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
  return (
    <>
      <span
        data-structured-template-reference=""
        // The spec is as wide as the chip's old fixed cap on its own, so a
        // spec-bearing chip trades the cap for the full message width.
        className={`hidden max-w-full sm:inline-flex ${STRUCTURED_INLINE_REFERENCE_LAYOUT_CLASS}`}
        title={`${label} · ${videoTemplateSpecText(spec)}`}
      >
        <SwatchBook size={13} className="shrink-0" />
        <span className="min-w-0 truncate">{part.titleSnapshot}</span>
        <SentVideoTemplateSpec spec={spec} />
      </span>
      <button
        type="button"
        data-structured-template-reference=""
        className={`max-w-full sm:hidden ${STRUCTURED_INLINE_REFERENCE_BASE_CLASS} ${STRUCTURED_INLINE_INTERACTIVE_CLASS}`}
        aria-haspopup="dialog"
        onClick={() => {
          openDetail({
            titleSnapshot: part.titleSnapshot,
            template: part.template,
          });
        }}
      >
        <SwatchBook size={13} className="shrink-0" />
        <span className="min-w-0 truncate">{part.titleSnapshot}</span>
      </button>
    </>
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
    readonly type: "source" | "automation" | "goal" | "morning_brief" | "model";
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
        <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden">
          <div className="px-4 py-3">
            <UserMessageView
              document={document}
              elevatedFileIds={elevatedFileIds}
            />
          </div>
        </div>
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
      className="group"
    >
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
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
      className="group"
    >
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
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
}: {
  event: EnrichedChatEvent;
  thread: ChatPanelSignals;
}) {
  const inputEvent = asInputChatEvent(event);
  const renderDocument = event.userMessageRenderDocument;
  const { canonicalUserMessage, clipboardAttachments, copyText } =
    resolvePagedUserMessageRendering({
      renderDocument,
    });
  const bodyBlocks = event.blocks;
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
    nonContentRenderPart?.type === "morning_brief" ||
    nonContentRenderPart?.type === "source"
      ? nonContentRenderPart
      : undefined;
  return (
    <div
      id={inputPromptRunAnchor(inputEvent)}
      data-role="user"
      data-chat-scroll-anchor-event-id={event.id}
      className="group"
    >
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
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
          ) : (
            <>
              <UserMessageAttachments
                attachments={allAttachments}
                onImageClick={openLightbox}
              />
              {bodyBlocks.length > 0 && (
                <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-[0.9375rem] leading-[1.7] [overflow-wrap:anywhere] overflow-hidden">
                  <div className="px-4 py-3">
                    <BodyContentBlocks
                      blocks={bodyBlocks}
                      mermaidScope={thread.threadId}
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
  group: ChatEventGroup;
  thread: ChatPanelSignals;
  runGroupFolds?: readonly RunGroupFoldControl[];
  completedWorkFold?: {
    groups: readonly ChatEventGroup[];
    hiddenGroups: readonly ChatEventGroup[];
    expanded: boolean;
    onToggle: () => void;
  };
}) {
  const hasRenderableEvent = group.events.some((event) => {
    return isRenderableAssistantEvent(event);
  });
  const hasRunGroupFolds = (runGroupFolds?.length ?? 0) > 0;
  const showCompletedWorkFold = completedWorkFold && !hasRunGroupFolds;
  if (!hasRenderableEvent && !completedWorkFold && !hasRunGroupFolds) {
    return null;
  }

  const groupElementId = `chat-event-group-${group.beginEventId}`;
  const fullContent = group.events
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");
  let renderedAssistantEventCount = 0;
  const renderAssistantEventItem = (event: EnrichedChatEvent) => {
    const isRenderable = isRenderableAssistantEvent(event);
    const compactTop = isRenderable && renderedAssistantEventCount > 0;
    if (isRenderable) {
      renderedAssistantEventCount += 1;
    }
    return (
      <PagedAssistantEventItem
        key={event.id}
        event={event}
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
                  <div key={hiddenGroup.beginEventId} className="contents">
                    {hiddenGroup.events.map((event) => {
                      return renderAssistantEventItem(event);
                    })}
                  </div>
                );
              })
            : null}
          {group.events.map((event) => {
            return renderAssistantEventItem(event);
          })}
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
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox: OpenMessageImagePreview = (url, filename) => {
    openImageLightbox(
      messageImageLightboxTarget(thread.threadId, url, filename),
    );
  };
  const error = chatEventError(event);
  if (error) {
    return (
      <div
        data-chat-scroll-anchor-event-id={event.id}
        className={cn(
          "zero-chat-bubble-assistant px-0 text-[0.9375rem] leading-[1.7] min-w-0 [overflow-wrap:anywhere]",
          compactTop ? "@[900px]:pt-0" : "@[900px]:pt-2.5",
        )}
      >
        <AssistantErrorContent
          error={error}
          eventId={event.id}
          thread={thread}
        />
      </div>
    );
  }

  if (
    (isChatEventContentTextType(event.eventType) && event.content) ||
    event.blocks.length > 0
  ) {
    const { blocks } = event;
    return (
      <div
        data-chat-scroll-anchor-event-id={event.id}
        className={cn(
          "zero-chat-bubble-assistant px-0 text-[0.9375rem] leading-[1.7] min-w-0 [overflow-wrap:anywhere]",
          compactTop ? "@[900px]:pt-0" : "@[900px]:pt-2.5",
        )}
      >
        {blocks.length > 0 ? (
          <BodyContentBlocks
            blocks={blocks}
            mermaidScope={thread.threadId}
            openLightbox={openLightbox}
            hardBreaks={false}
          />
        ) : null}
      </div>
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
