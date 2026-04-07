import { Component } from "react";
import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { user$ } from "../../signals/auth.ts";
import { IconArrowUpRight, IconPin, IconUserPlus } from "@tabler/icons-react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { currentAgentId$, subagents$ } from "../../signals/agent.ts";
import {
  currentChatAgentId$,
  currentChatAgent$,
  currentChatAgentDisplayName$,
} from "../../signals/agent-chat.ts";
import { resolveAvatarUrl } from "./avatar-utils.ts";
import avatar1Img from "./assets/avatar_1.webp";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";

import { detach, Reason } from "../../signals/utils.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  setActiveTab$,
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
import { Link } from "../router/link.tsx";
import {
  resetTalkSendSignal$,
  sendNewThreadMessage$,
  startNewZeroSession$,
} from "../../signals/chat-page/chat-message.ts";

function getTagline(
  agentName: string,
  userName: string | undefined,
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

function useUserFirstName(): string | undefined {
  const loadable = useLoadable(user$);
  if (loadable.state !== "hasData") {
    return undefined;
  }
  return loadable.data?.firstName ?? undefined;
}

function InviteButton({ pageSignal }: { pageSignal: AbortSignal }) {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const setTab = useSet(setActiveTab$);
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

export function ZeroChatPage() {
  // Agent resolution (moved from ZeroTalkPage)
  const chatAgentLoadable = useLastLoadable(currentChatAgentId$);
  const currentChatAgentId =
    chatAgentLoadable.state === "hasData" ? chatAgentLoadable.data : null;
  const subagentsLoadable = useLastLoadable(subagents$);
  const subagents =
    subagentsLoadable.state === "hasData" ? subagentsLoadable.data : [];
  const selectedSubagent = currentChatAgentId
    ? subagents.find((a) => {
        return a.id === currentChatAgentId;
      })
    : null;

  const sidebarAgentIdLoadable = useLastLoadable(currentChatAgentId$);
  const sidebarAgentIdResolved =
    sidebarAgentIdLoadable.state === "hasData"
      ? sidebarAgentIdLoadable.data
      : null;
  const resolvedAgentId = selectedSubagent?.id ?? sidebarAgentIdResolved;
  const sidebarAgent = useLastResolved(currentChatAgent$);
  const zeroAvatarSrc = sidebarAgent
    ? (resolveAvatarUrl(sidebarAgent.avatarUrl) ?? avatar1Img)
    : null;

  const agentDisplayNameLoadable = useLastLoadable(
    currentChatAgentDisplayName$,
  );
  const agentDisplayName =
    agentDisplayNameLoadable.state === "hasData"
      ? (agentDisplayNameLoadable.data ?? "Zero")
      : "Zero";
  const chatAgentName = selectedSubagent
    ? (selectedSubagent.displayName ?? selectedSubagent.id)
    : agentDisplayName;

  // Send logic (moved from ZeroTalkPage)
  const sendNewThread = useSet(sendNewThreadMessage$);
  const startNewSession = useSet(startNewZeroSession$);
  const resetTalkSendSignal = useSet(resetTalkSendSignal$);

  const handleSendMessage = (message: string) => {
    if (!resolvedAgentId) {
      return;
    }
    startNewSession();
    const talkSignal = resetTalkSendSignal();
    detach(
      sendNewThread(resolvedAgentId, message, talkSignal),
      Reason.DomCallback,
    );
  };

  const displayName = chatAgentName;
  const userName = useUserFirstName();

  const input = useGet(chatPageInput$);
  const setInput = useSet(setChatPageInput$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline = getTagline(displayName, userName, taglineIndex);
  const suggestedPrompts = useGet(suggestedPrompts$);
  const navigate = useSet(detachedNavigateTo$);

  // Agent ID from URL for ideas navigation
  const talkAgentId = useGet(currentAgentId$);

  // Pin pill (currentChatAgentId is resolved above)
  const pinnedLoadable = useLastLoadable(pinnedAgentIds$);
  const pinnedIds = (
    pinnedLoadable.state === "hasData" ? pinnedLoadable.data : []
  ).filter((id): id is string => {
    return id !== null;
  });
  const savePinnedIds = useSet(updatePinnedAgentIds$);
  const pageSignal = useGet(pageSignal$);
  const showPinPill =
    typeof currentChatAgentId === "string" &&
    !pinnedIds.includes(currentChatAgentId);
  const handlePin = () => {
    if (currentChatAgentId) {
      detach(
        savePinnedIds([...pinnedIds, currentChatAgentId], pageSignal),
        Reason.DomCallback,
      );
    }
  };

  const handleSend = (text: string) => {
    setInput("");
    handleSendMessage(text);
  };

  const avatarAgentId = resolvedAgentId ?? undefined;

  // Landing page: full content (title, triggers, composer, actions, prompts)
  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <header className="hidden md:block shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-2">
        <div className="flex justify-end">
          <InviteButton pageSignal={pageSignal} />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-6 pt-8 pb-12 sm:pt-[15vh] sm:pb-[10vh]">
          <div className="flex items-center gap-4 w-full">
            <div className="relative shrink-0">
              {avatarAgentId ? (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Link
                        pathname="/agents/:id"
                        options={{ pathParams: { id: avatarAgentId } }}
                        aria-label="View agent profile"
                        className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent cursor-pointer"
                      >
                        {zeroAvatarSrc ? (
                          <img
                            src={zeroAvatarSrc}
                            alt=""
                            role="presentation"
                            className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
                          />
                        ) : (
                          <div
                            className="h-14 w-14 rounded-full bg-muted sm:h-16 sm:w-16"
                            aria-hidden
                          />
                        )}
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p className="text-xs">View agent profile</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <div className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl">
                  {zeroAvatarSrc ? (
                    <img
                      src={zeroAvatarSrc}
                      alt=""
                      role="presentation"
                      className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
                    />
                  ) : (
                    <div
                      className="h-14 w-14 rounded-full bg-muted sm:h-16 sm:w-16"
                      aria-hidden
                    />
                  )}
                </div>
              )}
              {showPinPill && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handlePin}
                        className="absolute -top-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full zero-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground hover:shadow-md cursor-pointer"
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
              )}
            </div>
            <div className="flex-1 min-w-0 flex flex-col justify-center">
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
            displayName={displayName}
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
                if (talkAgentId) {
                  navigate("/agents/:id/ideas", {
                    pathParams: { id: talkAgentId },
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
