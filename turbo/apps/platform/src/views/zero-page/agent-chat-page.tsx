// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { Component } from "react";
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
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/core";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
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
import {
  chatPageInput$,
  setChatPageInput$,
  chatPageTaglineIndex$,
  suggestedPrompts$,
} from "../../signals/zero-page/zero-chat-page.ts";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import {
  createNewChatThread$,
  resetTalkSendSignal$,
  sendNewThreadMessage$,
  startNewZeroSession$,
} from "../../signals/chat-page/chat-message.ts";
import { navigateToChat$ } from "../../signals/zero-page/zero-nav.ts";
import { vcEnabled$ } from "../../signals/voice-chat/voice-chat-session.ts";
import { ROUTES } from "../../signals/route-paths.ts";

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

class TypewriterText extends Component<
  { text: string; speed?: number },
  { displayed: string }
> {
  private timer: number | undefined;
  state = { displayed: "" };

  componentDidMount() {
    this.startTypewriter();
  }

  componentDidUpdate(prev: { text: string; speed?: number }) {
    if (prev.text !== this.props.text || prev.speed !== this.props.speed) {
      this.cleanup();
      this.startTypewriter();
    }
  }

  componentWillUnmount() {
    this.cleanup();
  }

  private startTypewriter() {
    this.setState({ displayed: "" });
    let i = 0;
    const { text, speed = 40 } = this.props;
    this.timer = window.setInterval(() => {
      i++;
      this.setState({ displayed: text.slice(0, i) });
      if (i >= text.length) {
        window.clearInterval(this.timer);
      }
    }, speed);
  }

  private cleanup() {
    if (this.timer !== undefined) {
      window.clearInterval(this.timer);
    }
  }

  render() {
    const { text } = this.props;
    const { displayed } = this.state;
    return (
      <>
        {displayed}
        {displayed.length < text.length && (
          <span className="inline-block w-[2px] h-[1em] bg-foreground/60 ml-0.5 align-middle animate-pulse" />
        )}
      </>
    );
  }
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

function NewChatButton({ pageSignal }: { pageSignal: AbortSignal }) {
  const currentChatAgentId = useResolved(currentChatAgentId$);
  const [creatingLoadable, createNewChat] =
    useLoadableSet(createNewChatThread$);
  const navigateToChatFn = useSet(navigateToChat$);
  const creating = creatingLoadable.state === "loading";

  const handleNewChat = () => {
    detach(
      createNewChat(currentChatAgentId ?? null, pageSignal).then((threadId) => {
        if (threadId) {
          navigateToChatFn(threadId);
        }
      }),
      Reason.DomCallback,
    );
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleNewChat}
      disabled={creating}
      className="zero-btn-morandi gap-1.5"
      data-testid="chat-header-new-button"
    >
      <IconPlus size={14} stroke={1.5} />
      New
    </Button>
  );
}

function ChatHeaderAction({ pageSignal }: { pageSignal: AbortSignal }) {
  const features = useLastResolved(featureSwitch$);
  const newButtonEnabled =
    features?.[FeatureSwitchKey.ChatHeaderNewButton] ?? false;
  return newButtonEnabled ? (
    <NewChatButton pageSignal={pageSignal} />
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

function VoiceChatLauncher() {
  const vcEnabled = useLastResolved(vcEnabled$) ?? false;
  const navigate = useSet(detachedNavigateTo$);
  if (!vcEnabled) {
    return null;
  }
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              navigate(ROUTES.voiceChat);
            }}
            className="shrink-0 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
            aria-label="Start voice chat"
          >
            <IconMicrophone size={20} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Voice chat</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function AgentChatPage() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const currentChatAgentDisplayName = useLastResolved(
    currentChatAgentDisplayName$,
  );

  const sendNewThread = useSet(sendNewThreadMessage$);
  const startNewSession = useSet(startNewZeroSession$);
  const resetTalkSendSignal = useSet(resetTalkSendSignal$);
  const navigateToChatFn = useSet(navigateToChat$);
  const { signal: rootSignal } = useGet(rootSignal$);

  const handleSendMessage = (message: string) => {
    if (!currentChatAgentId) {
      return;
    }
    startNewSession();
    // Link to rootSignal so the send is cancellable on app/test teardown,
    // but not on page navigation (unlike pageSignal).
    const talkSignal = resetTalkSendSignal(rootSignal);
    detach(
      sendNewThread(currentChatAgentId, message, talkSignal).then(
        (threadId) => {
          if (threadId) {
            navigateToChatFn(threadId);
          }
        },
      ),
      Reason.DomCallback,
    );
  };

  const userFirstName = useLastResolved(user$)?.firstName ?? null;

  const input = useGet(chatPageInput$);
  const setInput = useSet(setChatPageInput$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline =
    currentChatAgentDisplayName !== undefined
      ? getTagline(
          currentChatAgentDisplayName ?? "Zero",
          userFirstName,
          taglineIndex,
        )
      : "";

  const suggestedPrompts = useGet(suggestedPrompts$);
  const navigate = useSet(detachedNavigateTo$);
  const pageSignal = useGet(pageSignal$);

  const handleSend = (text: string) => {
    setInput("");
    handleSendMessage(text);
  };

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-2">
        <div className="flex justify-end">
          <ChatHeaderAction pageSignal={pageSignal} />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-6 pt-8 pb-12 sm:pt-[15vh] sm:pb-[10vh]">
          <div className="flex items-center gap-4 w-full">
            <div className="relative shrink-0">
              {currentChatAgentId ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        pathname="/agents/:agentId"
                        options={{
                          pathParams: { agentId: currentChatAgentId },
                        }}
                        aria-label="View agent profile"
                        className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent cursor-pointer"
                      >
                        <AgentAvatarImg
                          name={currentChatAgentId}
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

          {/* Composer */}
          <ZeroChatComposer
            className="w-full"
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            displayName={currentChatAgentDisplayName ?? ""}
          />

          {/* Suggested prompts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 w-full">
            {suggestedPrompts.map(
              ({ title, description, connectors, prompt }) => {
                return (
                  <button
                    key={title}
                    type="button"
                    className="zero-card cursor-pointer p-4 text-left flex flex-col relative group hover:bg-muted/30 transition-colors"
                    onClick={() => {
                      return setInput(prompt);
                    }}
                  >
                    <IconArrowUpRight
                      size={14}
                      stroke={2}
                      className="absolute top-4 right-4 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
                    />
                    <p className="text-sm font-semibold text-foreground pr-5">
                      {title}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                      {description}
                    </p>
                    {connectors && connectors.length > 0 && (
                      <div className="flex items-center gap-1.5 mt-auto pt-2.5">
                        {connectors.map((type) => {
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
              },
            )}
            <button
              type="button"
              className="zero-card cursor-pointer p-4 text-left flex flex-col relative group hover:bg-muted/30 transition-colors"
              onClick={() => {
                if (currentChatAgentId) {
                  navigate("/agents/:agentId/ideas", {
                    pathParams: { agentId: currentChatAgentId },
                  });
                }
              }}
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
          </div>
        </div>
      </main>
    </div>
  );
}
