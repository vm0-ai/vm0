import {
  useGet,
  useSet,
  useLoadable,
  useLastResolved,
  useResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { user$ } from "../../signals/auth.ts";
import {
  IconArrowUpRight,
  IconMicrophone,
  IconPin,
  IconPlus,
  IconUserPlus,
} from "@tabler/icons-react";
import type { ConnectorType } from "@vm0/connectors/connectors";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  featureSwitch$,
  modelFirstModelProviderEnabled$,
  trinityEnabled$,
} from "../../signals/external/feature-switch.ts";
import {
  currentChatAgentId$,
  currentChatAgentDisplayName$,
} from "../../signals/agent-chat.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
  currentChatAgentPinned$,
} from "../../signals/zero-page/zero-pinned-agents.ts";

import { detach, Reason } from "../../signals/utils.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  setActiveOrgManageTab$,
  setBillingSubPage$,
} from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { AttachmentLightbox } from "./zero-attachment-chips.tsx";
import { composerModelProviders$ } from "../../signals/zero-page/composer-model-providers.ts";
import {
  chatPageAgentModelDefault$,
  chatPageInput$,
  chatPageModelSelection$,
  setChatPageInput$,
  setChatPageModelSelection$,
  resetChatPageModelSelection$,
  chatPageTaglineIndex$,
  suggestedPrompts$,
} from "../../signals/zero-page/zero-chat-page.ts";
import { lightboxUrl$ as attachmentLightboxUrl$ } from "../../signals/zero-page/zero-attachment-chips.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { activeRoute$ } from "../../signals/active-route.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import {
  createNewChatThreadOptimistically$,
  optimisticChatThread$,
  sendNewThreadOptimistically$,
  type OptimisticChatPane,
} from "../../signals/chat-page/optimistic-chat-thread-page.ts";
import { voiceChatStatus$ } from "../../signals/voice-chat/voice-chat-session.ts";
import { startChatNavigationTiming$ } from "../../lib/posthog.ts";
import {
  typewriterDisplayed$,
  typewriterRef$,
} from "../../signals/view-component-state.ts";
import { modelFirstPersonalOauthState$ } from "../../signals/zero-page/model-first-personal-oauth.ts";
import {
  resolveChatComposerSubmitBlocker,
  usePersonalOauthConfigurationAction,
} from "./model-first-oauth-submit-blocker.ts";
import { PersonalProviderDialog } from "./components/settings/personal-provider-dialog.tsx";
import { PersonalCodexAuthPasteDialog } from "./components/settings/codex-auth-paste-dialog.tsx";

function getTagline(
  agentName: string,
  userName: string | null,
  index: number,
): string {
  const taglines = userName
    ? [
        `Welcome back, ${userName}.`,
        `${userName}, what's the move?`,
        `Good to see you, ${userName}.`,
        `What's on your mind, ${userName}?`,
        `${userName} + ${agentName}. Let's roll.`,
        `Another day, another win, ${userName}.`,
        `Hey ${userName}, ready to build?`,
        `${userName} has entered the chat.`,
        `Good to see you, ${userName}.`,
        `${userName}! I saved your seat.`,
        `${userName}, let's make today count.`,
        `Coffee's ready, ${userName}. Let's go.`,
        `${userName}, I had a feeling you'd come.`,
        `What's cooking, ${userName}?`,
        `${userName}. New day, new ideas.`,
        `Ah, ${userName}. Right on time.`,
        `${userName}, what are we working on?`,
        `The usual, ${userName}?`,
      ]
    : [
        `Welcome back.`,
        `What's the move?`,
        `Good to see you.`,
        `What's on your mind?`,
        `Ready to roll.`,
        `Let's build something.`,
        `What are we working on?`,
      ];
  return taglines[index % taglines.length];
}

function TypewriterText({
  text,
  speed = 40,
}: {
  text: string;
  speed?: number;
}) {
  const displayed = useGet(typewriterDisplayed$);
  const typewriterRef = useSet(typewriterRef$);
  const typewriterKey = `${text}:${String(speed)}`;
  const displayedText = displayed[typewriterKey] ?? "";

  return (
    <>
      <span
        key={typewriterKey}
        ref={typewriterRef}
        className="contents"
        data-typewriter-speed={String(speed)}
        data-typewriter-key={typewriterKey}
        data-typewriter-text={text}
      >
        {displayedText}
      </span>
      {displayedText.length < text.length && (
        <span className="inline-block w-[2px] h-[1em] bg-foreground/60 ml-0.5 align-middle animate-pulse" />
      )}
    </>
  );
}

function InviteButton({ pageSignal }: { pageSignal: AbortSignal }) {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const setTab = useSet(setActiveOrgManageTab$);
  const setSubPage = useSet(setBillingSubPage$);
  const openManage = useSet(setOrgManageDialogOpen$);
  const handleInvite = () => {
    setTab("members");
    setSubPage(false);
    detach(openManage(true, pageSignal), Reason.DomCallback);
  };
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleInvite}
      className={`zero-btn-morandi gap-1.5${isAdmin ? "" : " invisible"}`}
      aria-hidden={isAdmin ? undefined : "true"}
      tabIndex={isAdmin ? undefined : -1}
      data-testid="invite-button"
    >
      <IconUserPlus size={14} stroke={1.5} />
      Invite people
    </Button>
  );
}

function NewChatButton() {
  const currentChatAgentId = useResolved(currentChatAgentId$);
  const createNewChat = useSet(createNewChatThreadOptimistically$);
  const creating = useGet(optimisticChatThread$) !== null;
  const rootSignal = useGet(rootSignal$);

  const handleNewChat = (pane: OptimisticChatPane) => {
    if (!currentChatAgentId) {
      return;
    }

    detach(
      createNewChat(currentChatAgentId, pane, rootSignal),
      Reason.DomCallback,
    );
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={(event) => {
        handleNewChat(event.altKey ? "sidebar" : "main");
      }}
      disabled={!currentChatAgentId || creating}
      className="zero-btn-morandi gap-1.5"
      data-testid="chat-header-new-button"
    >
      <IconPlus size={14} stroke={1.5} />
      New
    </Button>
  );
}

export function ChatHeaderAction({ pageSignal }: { pageSignal: AbortSignal }) {
  const features = useLastResolved(featureSwitch$);
  const newButtonEnabled =
    features?.[FeatureSwitchKey.ChatHeaderNewButton] ?? false;
  return newButtonEnabled ? (
    <NewChatButton />
  ) : (
    <InviteButton pageSignal={pageSignal} />
  );
}

function PinPill() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const pinnedStatus = useLastResolved(currentChatAgentPinned$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const pinSaving = pinLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  if (pinnedStatus !== false || !currentChatAgentId) {
    return null;
  }
  const handlePin = () => {
    const newPinnedIds = [...pinnedIds, currentChatAgentId];
    detach(savePinnedIds(newPinnedIds, pageSignal), Reason.DomCallback);
  };
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePin}
            disabled={pinSaving}
            className="absolute -top-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full zero-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground hover:shadow-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Pin to sidebar"
          >
            <IconPin size={12} stroke={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Pin to sidebar</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function VoiceChatLauncher() {
  const trinityEnabled = useLastResolved(trinityEnabled$) ?? false;
  const voiceChatStatus = useGet(voiceChatStatus$);
  const activeRoute = useGet(activeRoute$);
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const navigate = useSet(detachedNavigateTo$);

  if (!trinityEnabled) {
    return null;
  }

  const onTalk = activeRoute === "agentTalk";

  const handleClick = () => {
    if (!currentChatAgentId) {
      return;
    }
    navigate(onTalk ? "/agents/:agentId/chat" : "/agents/:agentId/talk", {
      pathParams: { agentId: currentChatAgentId },
    });
  };

  const isConnecting = onTalk && voiceChatStatus === "connecting";
  const isConnected = onTalk && voiceChatStatus === "connected";
  const colorClass = isConnected
    ? "text-green-600 hover:text-green-700"
    : isConnecting
      ? "text-primary animate-pulse"
      : "text-muted-foreground hover:text-foreground";

  const tooltipText = onTalk ? "Exit voice chat" : "Start voice chat";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            data-testid="voice-chat-launcher"
            aria-label={tooltipText}
            aria-pressed={onTalk}
            className={`shrink-0 flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-accent cursor-pointer ${colorClass}`}
          >
            <IconMicrophone size={20} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ChatAgentAvatar({
  agentId,
}: {
  agentId: string | null | undefined;
}) {
  return (
    <div className="relative shrink-0">
      {agentId ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/agents/:agentId"
                options={{
                  pathParams: { agentId },
                }}
                aria-label="View agent profile"
                className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent cursor-pointer"
              >
                <AgentAvatarImg
                  name={agentId}
                  alt=""
                  className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
                />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">View agent profile</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl">
          <AgentAvatarImg
            name=""
            alt=""
            className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
          />
        </div>
      )}
      <PinPill />
    </div>
  );
}

interface SuggestedPrompt {
  title: string;
  description: string;
  prompt: string;
  connectors?: readonly ConnectorType[];
}

function SuggestedPromptButton({
  item,
  onSelectPrompt,
}: {
  item: SuggestedPrompt;
  onSelectPrompt: (prompt: string) => void;
}) {
  return (
    <button
      type="button"
      className="zero-card cursor-pointer p-4 text-left flex flex-col relative group hover:bg-muted/30 transition-colors"
      onClick={() => {
        onSelectPrompt(item.prompt);
      }}
    >
      <IconArrowUpRight
        size={14}
        stroke={2}
        className="absolute top-4 right-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
      />
      <p className="text-sm font-semibold text-foreground pr-5">{item.title}</p>
      <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
        {item.description}
      </p>
      {item.connectors && item.connectors.length > 0 && (
        <div className="flex items-center gap-1.5 mt-auto pt-2.5">
          {item.connectors.map((type) => {
            return (
              <span
                key={type}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background"
              >
                <ConnectorIcon type={type} size={14} />
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
}

function IdeasUseCasesButton() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const navigate = useSet(detachedNavigateTo$);

  const handleClick = () => {
    if (!currentChatAgentId) {
      return;
    }
    navigate("/agents/:agentId/ideas", {
      pathParams: { agentId: currentChatAgentId },
    });
  };

  return (
    <button
      type="button"
      className="zero-card cursor-pointer p-4 text-left flex flex-col relative group hover:bg-muted/30 transition-colors"
      onClick={handleClick}
    >
      <IconArrowUpRight
        size={14}
        stroke={2}
        className="absolute top-4 right-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
      />
      <p className="text-sm font-semibold text-foreground pr-5">
        Ideas &amp; use cases
      </p>
      <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
        Browse use cases across all connectors
      </p>
      <div className="flex items-center gap-1.5 mt-auto pt-2.5 text-sm font-medium text-primary">
        <span>View all</span>
        <IconArrowUpRight size={14} stroke={2} />
      </div>
    </button>
  );
}

function SuggestedPromptsGrid({
  onSelectPrompt,
}: {
  onSelectPrompt: (prompt: string) => void;
}) {
  const suggestedPrompts = useLastResolved(suggestedPrompts$) ?? [];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
      {suggestedPrompts.map((item) => {
        return (
          <SuggestedPromptButton
            key={item.title}
            item={item}
            onSelectPrompt={onSelectPrompt}
          />
        );
      })}
      <IdeasUseCasesButton />
    </div>
  );
}

export function AgentChatPage() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const currentChatAgentDisplayName = useLastResolved(
    currentChatAgentDisplayName$,
  );

  const sendNewThread = useSet(sendNewThreadOptimistically$);
  const rootSignal = useGet(rootSignal$);
  const pageSignal = useGet(pageSignal$);

  const composerProviders = useLastResolved(composerModelProviders$);
  const modelSelection = useLastResolved(chatPageModelSelection$) ?? null;
  const setModelSelection = useSet(setChatPageModelSelection$);
  const resetModelSelection = useSet(resetChatPageModelSelection$);
  const modelFirstEnabled = useGet(modelFirstModelProviderEnabled$);
  const agentModelDefault = useLastResolved(chatPageAgentModelDefault$) ?? null;
  const modelFirstOauthState = useLastResolved(modelFirstPersonalOauthState$);
  const openPersonalOauthConfiguration =
    usePersonalOauthConfigurationAction(pageSignal);

  const handleSendMessage = (message: string, options?: { goal?: boolean }) => {
    if (!currentChatAgentId) {
      return;
    }

    detach(
      sendNewThread(
        {
          agentId: currentChatAgentId,
          prompt: message,
          modelSelection,
          goal: options?.goal,
        },
        rootSignal,
      ),
      Reason.DomCallback,
    );
  };

  const userFirstName = useLastResolved(user$)?.firstName ?? null;

  const input = useGet(chatPageInput$);
  const setInput = useSet(setChatPageInput$);
  const startTiming = useSet(startChatNavigationTiming$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline =
    currentChatAgentDisplayName !== undefined
      ? getTagline(
          currentChatAgentDisplayName ?? "Zero",
          userFirstName,
          taglineIndex,
        )
      : "";

  const lightboxUrl = useGet(attachmentLightboxUrl$);

  const handleSend = (text: string, options?: { goal?: boolean }) => {
    startTiming();
    setInput("");
    handleSendMessage(text, options);
    resetModelSelection();
  };

  const submitBlockerProps = resolveChatComposerSubmitBlocker({
    state: modelFirstOauthState,
    modelSelection,
    agentModelDefault,
    onAction: openPersonalOauthConfiguration,
  });

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-2">
        <div className="flex justify-end items-center gap-2">
          <ChatHeaderAction pageSignal={pageSignal} />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-6 pt-8 pb-12 sm:pt-[20vh] sm:pb-[10vh]">
          <div className="flex items-center gap-4 w-full">
            <ChatAgentAvatar agentId={currentChatAgentId} />
            <div className="flex-1 min-w-0 flex items-center gap-3">
              <VoiceChatLauncher />
              <h2
                aria-label={tagline}
                data-testid="chat-tagline"
                className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground"
              >
                <TypewriterText text={tagline} />
              </h2>
            </div>
          </div>

          <ZeroChatComposer
            className="w-full"
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            displayName={currentChatAgentDisplayName ?? ""}
            autoFocus
            modelPicker={
              composerProviders &&
              (modelFirstEnabled || composerProviders.providers.length > 0)
                ? {
                    providers: composerProviders.providers,
                    value: modelSelection,
                    onChange: setModelSelection,
                    // No prior session exists on the landing page.
                    sessionProviderType: null,
                    agentDefault: agentModelDefault,
                    showUseDefault: !modelFirstEnabled,
                  }
                : undefined
            }
            submitBlocker={submitBlockerProps}
          />

          <SuggestedPromptsGrid onSelectPrompt={setInput} />
        </div>
      </main>
      <PersonalProviderDialog />
      <PersonalCodexAuthPasteDialog />
      {lightboxUrl && <AttachmentLightbox />}
    </div>
  );
}
