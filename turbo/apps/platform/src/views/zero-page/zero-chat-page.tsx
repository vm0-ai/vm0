import { Component, useState } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { user$ } from "../../signals/auth.ts";
import { IconArrowUpRight, IconPin } from "@tabler/icons-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { zeroChatAgentId$ } from "../../signals/zero-page/zero-nav.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import {
  chatPageInput$,
  setChatPageInput$,
  chatPageTaglineIndex$,
} from "../../signals/zero-page/zero-chat-page.ts";
import { ZeroIdeationPage, getRandomPrompts } from "./zero-ideation-page.tsx";
import { ConnectorIcon } from "./components/settings/connector-icons.tsx";
import zeroAvatarImg from "./assets/zero-avatar.webp";
import chatFolderImg from "./assets/chat-folder.webp";

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

interface ZeroChatPageProps {
  onNavigateToMeet?: (tab?: string) => void;
  onSendMessage?: (
    message: string,
    options?: { modelProvider?: string },
  ) => void;
  zeroAvatarSrc?: string;
  /** Override agent name when chatting with a sub-agent. */
  chatAgentName?: string;
  /** Navigate to agent team detail page when avatar is clicked. */
  onAvatarClick?: () => void;
}

export function ZeroChatPage({
  onNavigateToMeet,
  onSendMessage,
  zeroAvatarSrc = zeroAvatarImg,
  chatAgentName,
  onAvatarClick,
}: ZeroChatPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const defaultAgentId =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const agentName = chatAgentName ?? defaultAgentId;
  const userName = useUserFirstName();

  const input = useGet(chatPageInput$);
  const setInput = useSet(setChatPageInput$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline = getTagline(agentName, userName, taglineIndex);
  const [showIdeation, setShowIdeation] = useState(false);
  const [suggestedPrompts] = useState(() => getRandomPrompts(3));

  // Pin pill
  const currentChatAgentId = useGet(zeroChatAgentId$);
  const pinnedLoadable = useLastLoadable(pinnedAgentIds$);
  const pinnedIds =
    pinnedLoadable.state === "hasData" ? pinnedLoadable.data : [];
  const savePinnedIds = useSet(updatePinnedAgentIds$);
  const showPinPill =
    currentChatAgentId !== null && !pinnedIds.includes(currentChatAgentId);
  const handlePin = () => {
    if (currentChatAgentId) {
      detach(
        savePinnedIds([...pinnedIds, currentChatAgentId]),
        Reason.DomCallback,
      );
    }
  };

  const handleSend = (text: string, opts?: { modelProvider: string }) => {
    setInput("");
    onSendMessage?.(text, opts);
  };

  if (showIdeation) {
    return (
      <ZeroIdeationPage
        onBack={() => setShowIdeation(false)}
        onSelectPrompt={(prompt) => {
          setInput(prompt);
          setShowIdeation(false);
        }}
      />
    );
  }

  // Landing page: full content (title, triggers, composer, actions, prompts)
  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <header
        className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-2"
        aria-hidden="true"
      />

      <main className="flex flex-1 flex-col justify-center overflow-auto px-4 sm:px-6 py-12">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-8 -mt-24">
          <div className="flex items-center gap-4 w-full">
            <div className="relative shrink-0">
              <button
                type="button"
                aria-label="View agent profile"
                className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent cursor-pointer"
                onClick={onAvatarClick}
              >
                <img
                  src={zeroAvatarSrc}
                  alt=""
                  role="presentation"
                  className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
                />
              </button>
              {showPinPill && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handlePin}
                        className="absolute -top-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-[0.7px] border-[hsl(var(--gray-400))] bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground hover:shadow-md cursor-pointer"
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
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
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
            agentName={agentName}
            onManageConnectors={() => onNavigateToMeet?.("connectors")}
          />

          {/* Suggested prompts */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 w-full">
            {suggestedPrompts.map(
              ({ title, description, connectors, prompt }) => (
                <button
                  key={title}
                  type="button"
                  className="zero-card cursor-pointer p-4 text-left flex flex-col gap-3 relative group"
                  onClick={() => setInput(prompt)}
                >
                  <IconArrowUpRight
                    size={14}
                    stroke={2}
                    className="absolute top-2.5 right-2.5 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
                  />
                  <div className="flex items-center gap-3">
                    {connectors?.map((type) => (
                      <ConnectorIcon key={type} type={type} size={16} />
                    ))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {title}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {description}
                    </p>
                  </div>
                </button>
              ),
            )}
            <button
              type="button"
              className="zero-card cursor-pointer p-4 text-left flex flex-col gap-3 relative group"
              onClick={() => setShowIdeation(true)}
            >
              <IconArrowUpRight
                size={14}
                stroke={2}
                className="absolute top-2.5 right-2.5 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
              />
              <img
                src={chatFolderImg}
                alt=""
                role="presentation"
                loading="lazy"
                className="h-8 w-8 object-contain"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  Explore more ideas
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Browse use cases across all connectors
                </p>
              </div>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
