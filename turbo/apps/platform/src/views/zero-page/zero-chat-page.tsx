import { Component } from "react";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { user$ } from "../../signals/auth.ts";
import {
  IconPlug,
  IconUser,
  IconUsers,
  IconCheck,
  IconArrowLeft,
  IconArrowUpRight,
  IconChartLine,
  IconCalendar,
} from "@tabler/icons-react";
import { Button, cn } from "@vm0/ui";
import { ZERO_TEAM_JOBS } from "./zero-mock-data";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { Link } from "../router/link.tsx";
import {
  chatPageInput$,
  setChatPageInput$,
  chatPageConversationActive$,
  setChatPageConversationActive$,
  chatPageStreamedCount$,
  setChatPageConversationEndEl$,
  setChatPageSubAgentListEl$,
  chatPageApproveDone$,
  setChatPageApproveDone$,
  chatPageSelectedOption$,
  setChatPageSelectedOption$,
  chatPageTeamPersonalChoice$,
  setChatPageTeamPersonalChoice$,
  chatPageConnectorConnected$,
  setChatPageConnectorConnected$,
  chatPageCommandAllowed$,
  setChatPageCommandAllowed$,
  chatPageShowSubAgentList$,
  chatPageTaglineIndex$,
  toggleChatPageSubAgentList$,
} from "../../signals/zero-page/zero-chat-page.ts";
import chatFolderImg from "./assets/chat-folder.png";
import chatCoffeeImg from "./assets/chat-coffee.png";
import chatMacImg from "./assets/chat-mac.png";
import zeroAvatarImg from "./assets/zero-avatar.png";

type DemoScenarioId =
  | "hello-from-zero"
  | "approve"
  | "ask-options"
  | "team-personal"
  | "connect-connector"
  | "rich-summary"
  | "agent-operations";

const SUGGESTED_PROMPTS = [
  {
    title: "Auto-organize inbox",
    description: "Smart categorization, reply, and daily email digest",
    image: chatFolderImg,
    imageClassName: "h-12 w-12",
    prompt:
      "Set up auto-organization for my inbox with smart categorization, auto-reply rules, and a daily email digest",
  },
  {
    title: "Daily morning brief",
    description: "Trending topics on a schedule, your personalized digest",
    image: chatCoffeeImg,
    imageClassName: "h-14 w-14 -mt-1",
    prompt:
      "Create a daily morning brief that curates trending topics and delivers a personalized digest every morning",
  },
  {
    title: "Create a sub-agent",
    description: "Build a specialized agent for a specific workflow",
    image: chatMacImg,
    imageClassName: "h-[4.5rem] w-[4.5rem]",
    prompt:
      "I want to create a new sub-agent to handle a specific workflow for my team",
  },
] as const;

function getStreamedScenarios(agentName: string): readonly Readonly<{
  id: DemoScenarioId;
  userMessage: string;
  assistantMessage: string;
}>[] {
  return [
    {
      id: "hello-from-zero",
      userMessage: "Hi",
      assistantMessage: "",
    },
    {
      id: "approve",
      userMessage: "Run the deployment to production",
      assistantMessage: `This action requires approval. Allow ${agentName} to run the deployment?`,
    },
    {
      id: "ask-options",
      userMessage: "Send a summary of this week’s activity",
      assistantMessage: "Where should I send the summary?",
    },
    {
      id: "team-personal",
      userMessage:
        "Create a daily digest workflow that summarizes important updates",
      assistantMessage:
        "I can create a Daily Digest workflow. Would you like this to be a Team workflow or a Personal workflow?",
    },
    {
      id: "connect-connector",
      userMessage: "Notify #releases when a PR is merged",
      assistantMessage: "Connect Slack to enable this workflow.",
    },
    {
      id: "rich-summary",
      userMessage: "Run the HN AI daily digest workflow",
      assistantMessage: "",
    },
    {
      id: "agent-operations",
      userMessage: "Test the Google Calendar connector and show me the steps",
      assistantMessage: "",
    },
  ];
}

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

interface StreamedScenario {
  id: DemoScenarioId;
  userMessage: string;
  assistantMessage: string;
}

interface ChatScenarioBlockProps {
  scene: StreamedScenario;
  commandAllowed: boolean;
  setCommandAllowed: (v: boolean) => void;
  approveDone: boolean;
  setApproveDone: (v: boolean) => void;
  selectedOption: string | null;
  setSelectedOption: (v: string | null) => void;
  teamPersonalChoice: "team" | "personal" | null;
  setTeamPersonalChoice: (v: "team" | "personal" | null) => void;
  connectorConnected: boolean;
  setConnectorConnected: (v: boolean) => void;
  zeroAvatarSrc?: string;
  agentName?: string;
}

function HelloFromZeroBlock({
  zeroAvatarSrc = zeroAvatarImg,
  agentName = "Zero",
}: {
  zeroAvatarSrc?: string;
  agentName?: string;
}) {
  const avatarButton = (
    <div className="h-9 w-9 shrink-0 mt-0.5 overflow-hidden rounded-xl">
      <img
        src={zeroAvatarSrc}
        alt=""
        role="presentation"
        className="h-9 w-9 rounded-full object-cover object-top"
      />
    </div>
  );
  return (
    <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-[36px_1fr] sm:grid-cols-[48px_1fr] gap-3 items-start">
        {avatarButton}
        <div className="zero-chat-bubble-assistant rounded-xl backdrop-blur-sm py-4 text-sm leading-relaxed min-w-0">
          <p className="text-foreground">
            Hi! I&apos;m {agentName}, your AI teammate. I help you automate
            tasks, run workflows, and get things done across your connected
            tools.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[36px_1fr] sm:grid-cols-[48px_1fr] gap-3 items-start">
        {avatarButton}
        <div className="zero-chat-bubble-assistant rounded-xl backdrop-blur-sm py-4 text-sm leading-relaxed min-w-0 flex flex-col gap-2">
          <p className="font-medium text-foreground">
            You&apos;ve connected Notion.
          </p>
          <p className="text-muted-foreground">
            Here are a few ways you can use me with it:
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>Create a weekly summary page from your meeting notes</li>
            <li>Sync action items from Slack into a Notion database</li>
            <li>
              Generate doc outlines from a prompt and save to a Notion page
            </li>
            <li>Turn emails into structured Notion tasks with due dates</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function ChatScenarioBlock({
  scene,
  commandAllowed,
  setCommandAllowed,
  approveDone,
  setApproveDone,
  selectedOption,
  setSelectedOption,
  teamPersonalChoice,
  setTeamPersonalChoice,
  connectorConnected,
  setConnectorConnected,
  zeroAvatarSrc = zeroAvatarImg,
  agentName = "Zero",
}: ChatScenarioBlockProps) {
  return (
    <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-[36px_1fr] sm:grid-cols-[48px_1fr] gap-3 items-start">
        <div className="w-9 h-9 shrink-0" />
        <div className="flex min-w-0 justify-end">
          <div className="zero-chat-bubble-user rounded-xl px-4 py-3 max-w-[85%] text-sm leading-relaxed">
            {scene.userMessage}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[36px_1fr] sm:grid-cols-[48px_1fr] gap-3 items-start">
        <div className="h-9 w-9 shrink-0 mt-0.5 overflow-hidden rounded-xl">
          <img
            src={zeroAvatarSrc}
            alt=""
            role="presentation"
            className="h-9 w-9 rounded-full object-cover object-top"
          />
        </div>
        <div className="zero-chat-bubble-assistant rounded-xl backdrop-blur-sm py-4 text-sm leading-relaxed min-w-0 flex flex-col gap-0">
          <ChatScenarioAssistantContent
            scene={scene}
            commandAllowed={commandAllowed}
            setCommandAllowed={setCommandAllowed}
            approveDone={approveDone}
            setApproveDone={setApproveDone}
            selectedOption={selectedOption}
            setSelectedOption={setSelectedOption}
            teamPersonalChoice={teamPersonalChoice}
            setTeamPersonalChoice={setTeamPersonalChoice}
            connectorConnected={connectorConnected}
            setConnectorConnected={setConnectorConnected}
            agentName={agentName}
          />
        </div>
      </div>
    </div>
  );
}

type ChatScenarioAssistantContentProps = ChatScenarioBlockProps;

function ChatScenarioAssistantContent({
  scene,
  commandAllowed,
  setCommandAllowed,
  approveDone,
  setApproveDone,
  selectedOption,
  setSelectedOption,
  teamPersonalChoice,
  setTeamPersonalChoice,
  connectorConnected,
  setConnectorConnected,
  agentName = "Zero",
}: ChatScenarioAssistantContentProps) {
  if (scene.id === "rich-summary") {
    return (
      <div className="text-foreground text-sm leading-relaxed space-y-3">
        <p className="font-medium">
          Scheduled run for hn-ai-digest completed. {"Here's"} what was
          accomplished:
        </p>
        <h3 className="text-sm font-semibold text-foreground leading-6 mt-4 mb-1.5">
          Summary
        </h3>
        <p className="text-muted-foreground">
          Found 7 AI-related stories from the top 50 HN posts, selected the top
          5 by score:
        </p>
        <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
          <li>
            <strong className="text-foreground font-medium">
              [Discussion]
            </strong>{" "}
            Pope tells priests to use their brains, not AI (520 pts, 411
            comments)
          </li>
          <li>
            <strong className="text-foreground font-medium">
              [Open Source]
            </strong>{" "}
            FreeBSD Wi-Fi driver built with AI assistance (160 pts, 124
            comments)
          </li>
          <li>
            <strong className="text-foreground font-medium">[Product]</strong>{" "}
            AI Timeline tracking 171 LLMs (131 pts, 48 comments)
          </li>
          <li>
            <strong className="text-foreground font-medium">[Industry]</strong>{" "}
            Goldman Sachs: AI added zero to US GDP growth (32 pts, 2 comments)
          </li>
          <li>
            <strong className="text-foreground font-medium">
              [Discussion]
            </strong>{" "}
            Magical Mushroom mycelium packaging (342 pts, 111 comments)
          </li>
        </ol>
        <h3 className="text-sm font-semibold text-foreground leading-6 mt-4 mb-1.5">
          Files created
        </h3>
        <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
          <li>
            <code className="text-foreground bg-muted/50 px-1 rounded text-xs font-mono">
              ~/digest-2026-02-24.md
            </code>{" "}
            — Full markdown digest with summaries
          </li>
          <li>
            <code className="text-foreground bg-muted/50 px-1 rounded text-xs font-mono">
              ~/slack_digest.json
            </code>{" "}
            — Slack Block Kit formatted message ready to post
          </li>
        </ul>
        <p className="text-muted-foreground text-xs mt-3">
          The digest has been saved to your HOME directory. To post to Slack,
          set up a valid Slack Bot Token and run the post command.
        </p>
        <pre className="mt-2 p-3 rounded-lg bg-muted/30 text-xs font-mono text-foreground overflow-x-auto border border-border/40">
          <code>{`curl -s -X POST "https://slack.com/api/chat.postMessage" \\
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d @~/slack_digest.json`}</code>
        </pre>
        <div className="mt-3.5 pt-3.5 border-t border-border/30">
          <Link
            pathname="/:tab"
            options={{ pathParams: { tab: "activity" } }}
            className="zero-chat-btn inline-flex items-center rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border"
          >
            <IconChartLine size={13} />
            View activity
          </Link>
        </div>
      </div>
    );
  }
  if (scene.id === "agent-operations") {
    return (
      <ChatScenarioAgentOperations
        commandAllowed={commandAllowed}
        setCommandAllowed={setCommandAllowed}
        agentName={agentName}
      />
    );
  }
  return (
    <>
      <p className="text-foreground text-sm leading-relaxed">
        {scene.assistantMessage}
      </p>
      {scene.id === "approve" && (
        <>
          {!approveDone ? (
            <div className="mt-3.5 pt-3.5 border-t border-border/30 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                style={{ borderWidth: "0.7px" }}
                className="rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                onClick={() => setApproveDone(true)}
              >
                <IconCheck size={13} />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="zero-chat-btn rounded-lg h-8 px-3.5 text-sm font-medium border"
                onClick={() => setApproveDone(false)}
              >
                Deny
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Approved
            </p>
          )}
        </>
      )}
      {scene.id === "ask-options" && (
        <>
          <div className="mt-3.5 pt-3.5 border-t border-border/30 rounded-lg bg-muted/5 py-2 flex flex-wrap gap-2">
            {["Email", "Slack", "Both"].map((opt) => (
              <button
                key={opt}
                type="button"
                className={cn(
                  "zero-chat-btn rounded-lg h-8 px-3.5 text-sm font-medium border transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  selectedOption === opt &&
                    "border-primary/40 bg-primary/10 text-primary ring-1 ring-primary/20 ring-inset",
                )}
                onClick={() =>
                  setSelectedOption(selectedOption === opt ? null : opt)
                }
              >
                {opt}
              </button>
            ))}
          </div>
          {selectedOption && (
            <p className="mt-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Chose {selectedOption}
            </p>
          )}
        </>
      )}
      {scene.id === "team-personal" && (
        <>
          <div className="mt-3.5 pt-3.5 border-t border-border/30 rounded-lg bg-muted/5 py-2 flex flex-wrap gap-2">
            <button
              type="button"
              className={cn(
                "zero-chat-btn rounded-lg h-8 px-3.5 text-sm font-medium border transition-all duration-200 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                teamPersonalChoice === "team" &&
                  "border-primary/40 bg-primary/10 text-primary ring-1 ring-primary/20 ring-inset",
              )}
              onClick={() =>
                setTeamPersonalChoice(
                  teamPersonalChoice === "team" ? null : "team",
                )
              }
            >
              <IconUsers size={13} />
              Team
            </button>
            <button
              type="button"
              className={cn(
                "zero-chat-btn rounded-lg h-8 px-3.5 text-sm font-medium border transition-all duration-200 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                teamPersonalChoice === "personal" &&
                  "border-primary/40 bg-primary/10 text-primary ring-1 ring-primary/20 ring-inset",
              )}
              onClick={() =>
                setTeamPersonalChoice(
                  teamPersonalChoice === "personal" ? null : "personal",
                )
              }
            >
              <IconUser size={13} />
              Personal
            </button>
          </div>
          {teamPersonalChoice && (
            <p className="mt-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {teamPersonalChoice === "team"
                ? "Team workflow"
                : "Personal workflow"}
            </p>
          )}
        </>
      )}
      {scene.id === "connect-connector" && (
        <>
          {!connectorConnected ? (
            <div className="mt-3.5 pt-3.5 border-t border-border/30">
              <Button
                size="sm"
                variant="outline"
                style={{ borderWidth: "0.7px" }}
                className="rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                onClick={() => setConnectorConnected(true)}
              >
                <IconPlug size={13} />
                Connect Slack
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Slack connected
            </p>
          )}
        </>
      )}
    </>
  );
}

function ChatScenarioAgentOperations({
  commandAllowed,
  setCommandAllowed,
  agentName = "Zero",
}: {
  commandAllowed: boolean;
  setCommandAllowed: (v: boolean) => void;
  agentName?: string;
}) {
  return (
    <div className="text-foreground text-sm leading-relaxed">
      <p className="mb-5 leading-relaxed">
        {"I'll"} run the Google Calendar connector demo: discover tools, fetch
        live data, and verify the environment.
      </p>
      <div className="relative">
        <div
          className="absolute left-0 top-0 bottom-0 w-4 flex justify-center pointer-events-none"
          aria-hidden
        >
          <div className="w-px h-full border-l border-dotted border-border/80" />
        </div>
        <div className="flex gap-3 items-start">
          <div className="w-4 shrink-0 flex justify-center pt-1.5 relative z-[1]">
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-muted/80 shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
              <span
                className="h-1.5 w-1.5 rounded-full bg-primary"
                aria-hidden
              />
            </span>
          </div>
          <div className="flex-1 min-w-0 pb-6">
            <h4 className="text-sm font-semibold text-foreground leading-6">
              Discover available Google Calendar MCP tools
            </h4>
            <p className="text-muted-foreground text-sm mt-1.5 leading-relaxed">
              Initiating discovery of MCP tools before fetching live data.
            </p>
          </div>
        </div>
        <div className="flex gap-3 items-start">
          <div className="w-4 shrink-0 flex justify-center pt-1.5 relative z-[1]">
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-muted/80 shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
              <span
                className="h-1.5 w-1.5 rounded-full bg-primary"
                aria-hidden
              />
            </span>
          </div>
          <div className="flex-1 min-w-0 pb-6">
            <h4 className="text-sm font-semibold text-foreground leading-6">
              Fetch live data (calendars, events)
            </h4>
            <p className="text-muted-foreground text-sm mt-1.5 leading-relaxed">
              Discovery done. Testing live data retrieval next.
            </p>
          </div>
        </div>
        <div className="flex gap-3 items-start">
          <div className="w-4 shrink-0 flex justify-center pt-1.5 relative z-[1]">
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border shadow-[0_1px_2px_rgba(0,0,0,0.06)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
                commandAllowed
                  ? "border-border bg-muted/80"
                  : "border-border bg-muted/60 dark:bg-muted/50",
              )}
            >
              {commandAllowed && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-primary"
                  aria-hidden
                />
              )}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-foreground leading-6">
              Verify environment and run command
            </h4>
            <p className="text-muted-foreground text-sm mt-1.5 leading-relaxed">
              Allow {agentName} to run the following command to verify Node and
              npm.
            </p>
            {!commandAllowed ? (
              <div className="mt-3 rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
                <p className="text-sm text-foreground leading-relaxed">
                  Allow {agentName} to run the following command to verify
                  Node.js and npm:{" "}
                  <code className="font-mono text-xs bg-muted/50 px-1.5 py-0.5 rounded">
                    node --version && npm --version
                  </code>
                </p>
                <div className="mt-3 pt-3 flex flex-wrap gap-2 border-t border-border/30">
                  <Button
                    size="sm"
                    variant="outline"
                    style={{ borderWidth: "0.7px" }}
                    className="rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                    onClick={() => setCommandAllowed(true)}
                  >
                    <IconCheck size={13} />
                    Allow once
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="zero-chat-btn rounded-lg h-8 px-3.5 text-sm font-medium border"
                    onClick={() => setCommandAllowed(false)}
                  >
                    Deny
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Command allowed
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function useUserFirstName(): string | undefined {
  const loadable = useLoadable(user$);
  if (loadable.state !== "hasData") {
    return undefined;
  }
  return loadable.data?.firstName ?? undefined;
}

type ScenarioItem = Readonly<{
  id: DemoScenarioId;
  userMessage: string;
  assistantMessage: string;
}>;

function filterScenariosToShow(
  scenarios: readonly ScenarioItem[],
  initialScenarioId: DemoScenarioId | undefined,
  conversationActive: boolean,
  streamedCount: number,
): readonly ScenarioItem[] {
  if (initialScenarioId !== undefined) {
    return scenarios.filter((s) => s.id === initialScenarioId);
  }
  if (conversationActive) {
    return scenarios.slice(0, streamedCount);
  }
  return [];
}

interface ZeroChatPageProps {
  initialScenarioId?: DemoScenarioId;
  onClearScenario?: () => void;
  onNavigateToSchedule?: () => void;
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
  initialScenarioId,
  onClearScenario,
  onNavigateToSchedule,
  onNavigateToMeet,
  onSendMessage,
  zeroAvatarSrc = zeroAvatarImg,
  chatAgentName,
  onAvatarClick,
}: ZeroChatPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const defaultAgentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const agentName = chatAgentName ?? defaultAgentName;
  const userName = useUserFirstName();

  const input = useGet(chatPageInput$);
  const setInput = useSet(setChatPageInput$);
  const conversationActive = useGet(chatPageConversationActive$);
  const setConversationActive = useSet(setChatPageConversationActive$);
  const streamedCount = useGet(chatPageStreamedCount$);
  const setConversationEndEl = useSet(setChatPageConversationEndEl$);
  const setSubAgentListEl = useSet(setChatPageSubAgentListEl$);
  const approveDone = useGet(chatPageApproveDone$);
  const setApproveDone = useSet(setChatPageApproveDone$);
  const selectedOption = useGet(chatPageSelectedOption$);
  const setSelectedOption = useSet(setChatPageSelectedOption$);
  const teamPersonalChoice = useGet(chatPageTeamPersonalChoice$);
  const setTeamPersonalChoice = useSet(setChatPageTeamPersonalChoice$);
  const connectorConnected = useGet(chatPageConnectorConnected$);
  const setConnectorConnected = useSet(setChatPageConnectorConnected$);
  const commandAllowed = useGet(chatPageCommandAllowed$);
  const setCommandAllowed = useSet(setChatPageCommandAllowed$);
  const showSubAgentList = useGet(chatPageShowSubAgentList$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline = getTagline(agentName, userName, taglineIndex);
  const toggleSubAgentList = useSet(toggleChatPageSubAgentList$);

  const handleSend = (text: string, opts?: { modelProvider: string }) => {
    setInput("");
    onSendMessage?.(text, opts);
  };

  const streamedScenarios = getStreamedScenarios(agentName);
  const scenariosToShow = filterScenariosToShow(
    streamedScenarios,
    initialScenarioId,
    conversationActive,
    streamedCount,
  );
  const showConversation =
    (initialScenarioId !== undefined && scenariosToShow.length > 0) ||
    conversationActive;

  if (showConversation && scenariosToShow.length > 0) {
    const isScenarioFromSidebar = initialScenarioId !== undefined;
    return (
      <div className="flex flex-1 flex-col min-h-0 bg-transparent">
        <header className="shrink-0 bg-transparent px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 -ml-2"
              onClick={() =>
                isScenarioFromSidebar
                  ? onClearScenario?.()
                  : setConversationActive(false)
              }
              aria-label="Back to chat home"
            >
              <IconArrowLeft size={20} stroke={1.5} />
            </Button>
            <button
              type="button"
              aria-label="View agent profile"
              className="h-8 w-8 shrink-0 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 cursor-pointer"
              onClick={onAvatarClick}
            >
              <img
                src={zeroAvatarSrc}
                alt=""
                role="presentation"
                className="h-8 w-8 rounded-full object-cover object-top"
              />
            </button>
            <span className="font-semibold text-foreground">{agentName}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-8 w-8 text-muted-foreground hover:text-foreground",
                showSubAgentList && "bg-muted/60 text-foreground",
              )}
              onClick={() => toggleSubAgentList()}
              aria-label={`${ZERO_TEAM_JOBS.length} sub-agents`}
            >
              <IconUsers size={18} stroke={1.5} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              onClick={onNavigateToSchedule}
              aria-label={`${agentName} scheduled tasks`}
            >
              <IconCalendar size={18} stroke={1.5} />
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="mx-auto max-w-[900px] flex flex-col gap-6 pb-4">
            {scenariosToShow.map((scene) =>
              scene.id === "hello-from-zero" ? (
                <HelloFromZeroBlock
                  key={scene.id}
                  zeroAvatarSrc={zeroAvatarSrc}
                  agentName={agentName}
                />
              ) : (
                <ChatScenarioBlock
                  key={scene.id}
                  scene={scene}
                  commandAllowed={commandAllowed}
                  setCommandAllowed={setCommandAllowed}
                  approveDone={approveDone}
                  setApproveDone={setApproveDone}
                  selectedOption={selectedOption}
                  setSelectedOption={setSelectedOption}
                  teamPersonalChoice={teamPersonalChoice}
                  setTeamPersonalChoice={setTeamPersonalChoice}
                  connectorConnected={connectorConnected}
                  setConnectorConnected={setConnectorConnected}
                  zeroAvatarSrc={zeroAvatarSrc}
                  agentName={agentName}
                />
              ),
            )}
            {showSubAgentList && (
              <div
                ref={setSubAgentListEl}
                className="grid grid-cols-[36px_1fr] sm:grid-cols-[48px_1fr] gap-3 items-start animate-in fade-in slide-in-from-bottom-2 duration-300"
              >
                <div className="h-9 w-9 shrink-0 mt-0.5 overflow-hidden rounded-xl">
                  <img
                    src={zeroAvatarSrc}
                    alt=""
                    role="presentation"
                    className="h-9 w-9 rounded-full object-cover object-top"
                  />
                </div>
                <div className="zero-chat-bubble-assistant rounded-xl backdrop-blur-sm overflow-hidden min-w-0 flex flex-col">
                  <div className="px-4 pt-4 pb-2">
                    <p className="text-sm text-foreground leading-relaxed">
                      You have {ZERO_TEAM_JOBS.length} sub-agents with different
                      expertise. Assign tasks as needed—I’ll route them and
                      return the results.
                    </p>
                  </div>
                  <div className="px-4 py-2.5 border-t border-border/50">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Sub-agents ({ZERO_TEAM_JOBS.length})
                    </span>
                  </div>
                  <ul role="list">
                    {ZERO_TEAM_JOBS.map((job) => (
                      <li
                        key={job.id}
                        className="hover:bg-muted/20 transition-colors"
                      >
                        <div className="min-w-0 py-3 mx-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-muted-foreground">
                              {job.agentName}
                            </span>
                            <span className="text-muted-foreground/60">·</span>
                            <span className="text-sm font-medium text-foreground">
                              {job.title}
                            </span>
                            <span className="zero-pill inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-0.5 text-xs font-medium">
                              {job.scope === "team" ? (
                                <IconUsers
                                  size={12}
                                  stroke={1.5}
                                  className="h-3 w-3 shrink-0 text-sky-600 dark:text-sky-400"
                                />
                              ) : (
                                <IconUser
                                  size={12}
                                  stroke={1.5}
                                  className="h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400"
                                />
                              )}
                              {job.scope === "team" ? "Team" : "Personal"}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground truncate">
                            {job.description}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="border-t border-border/50 px-4 py-3">
                    <Link
                      pathname="/team"
                      className="zero-btn-morandi inline-flex items-center w-fit rounded-lg h-8 px-3 text-sm font-medium border"
                    >
                      Manage in {agentName}&apos;s team
                    </Link>
                  </div>
                </div>
              </div>
            )}
            <div ref={setConversationEndEl} />
          </div>
        </main>
        <footer className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-8">
          <div className="mx-auto max-w-[900px] grid grid-cols-[36px_1fr] sm:grid-cols-[48px_1fr] gap-3">
            <div className="w-9 shrink-0" />
            <ZeroChatComposer
              className="w-full min-w-0"
              input={input}
              onInputChange={setInput}
              onSend={handleSend}
              agentName={agentName}
              onManageConnectors={() => onNavigateToMeet?.("connectors")}
            />
          </div>
        </footer>
      </div>
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
            <button
              type="button"
              aria-label="View agent profile"
              className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 cursor-pointer"
              onClick={onAvatarClick}
            >
              <img
                src={zeroAvatarSrc}
                alt=""
                role="presentation"
                className="h-14 w-14 rounded-full object-cover object-top sm:h-16 sm:w-16"
              />
            </button>
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
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
            {SUGGESTED_PROMPTS.map(
              ({ title, description, image, imageClassName, prompt }) => (
                <button
                  key={title}
                  type="button"
                  className="zero-card cursor-pointer p-4 text-left flex flex-col sm:flex-row gap-3 items-start sm:items-center relative group"
                  onClick={() => setInput(prompt)}
                >
                  <IconArrowUpRight
                    size={14}
                    stroke={2}
                    className="absolute top-2.5 right-2.5 text-muted-foreground/0 group-hover:text-muted-foreground transition-colors"
                  />
                  <img
                    src={image}
                    alt=""
                    className={`shrink-0 object-contain ${imageClassName}`}
                  />
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
          </div>
        </div>
      </main>
    </div>
  );
}
