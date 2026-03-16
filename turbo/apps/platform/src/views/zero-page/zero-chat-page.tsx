import { Component, type ChangeEvent } from "react";
import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { onRef, detach, Reason } from "../../signals/utils.ts";
import { user$ } from "../../signals/auth.ts";
import {
  zeroChatAttachments$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
} from "../../signals/zero-page/zero-chat.ts";
import {
  IconSend,
  IconPaperclip,
  IconPlug,
  IconUser,
  IconUsers,
  IconCheck,
  IconArrowLeft,
  IconArrowUpRight,
  IconChartLine,
  IconCalendar,
  IconPlus,
} from "@tabler/icons-react";
import {
  Button,
  Card,
  CardContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@vm0/ui";
import { ZERO_TEAM_JOBS } from "./zero-mock-data";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { AttachmentChips } from "./zero-attachment-chips.tsx";
import type { ConnectorType } from "@vm0/core";
import { ConnectorIcon } from "../settings-page/connector-icons.tsx";
import {
  AddConnectionDialog,
  ConnectModal,
} from "../settings-page/add-connection-dialog.tsx";
import { skills$ } from "../../data/skills.ts";
import {
  allConnectorTypes$,
  connectConnector$,
  selectedConnectorType$,
  setSelectedConnectorType$,
  justConnectedTypes$,
  clearJustConnectedTypes$,
} from "../../signals/settings-page/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  zeroAddedSkills$,
  addZeroSkill$,
  saveZeroSkills$,
} from "../../signals/zero-page/zero-meet.ts";
import { toast } from "@vm0/ui/components/ui/sonner";
import { useModelSelection } from "./zero-model-preference.ts";
import { useSendKeyHandler } from "./zero-send-key.ts";

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
    image: "/images/chat-folder.png",
    imageClassName: "h-12 w-12",
    prompt:
      "Set up auto-organization for my inbox with smart categorization, auto-reply rules, and a daily email digest",
  },
  {
    title: "Daily morning brief",
    description: "Trending topics on a schedule, your personalized digest",
    image: "/images/chat-coffee.png",
    imageClassName: "h-14 w-14 -mt-1",
    prompt:
      "Create a daily morning brief that curates trending topics and delivers a personalized digest every morning",
  },
  {
    title: "Create a sub-agent",
    description: "Build a specialized agent for a specific workflow",
    image: "/images/chat-mac.png",
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

const STREAM_DELAY_MS = 1400;

function getTagline(
  agentName: string,
  userName: string,
  index: number,
): string {
  const taglines = [
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
  onNavigateToActivity?: () => void;
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
  onAvatarClick?: () => void;
  agentName?: string;
}

function HelloFromZeroBlock({
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
  agentName = "Zero",
}: {
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
  agentName?: string;
}) {
  const avatarButton = (
    <button
      type="button"
      onClick={onAvatarClick}
      className="h-9 w-9 shrink-0 mt-0.5 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="Switch Zero avatar"
    >
      <img
        src={zeroAvatarSrc}
        alt=""
        role="presentation"
        className="h-9 w-9 rounded-full object-cover object-top"
      />
    </button>
  );
  return (
    <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        {avatarButton}
        <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0">
          <p className="text-foreground">
            Hi! I&apos;m {agentName}, your AI teammate. I help you automate
            tasks, run workflows, and get things done across your connected
            tools.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        {avatarButton}
        <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0 flex flex-col gap-2">
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
  onNavigateToActivity,
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
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
  agentName = "Zero",
}: ChatScenarioBlockProps) {
  return (
    <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        <div className="w-9 h-9 shrink-0" />
        <div className="flex min-w-0 justify-end">
          <div className="zero-chat-bubble-user rounded-xl px-4 py-3 max-w-[85%] text-sm leading-relaxed">
            {scene.userMessage}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        <button
          type="button"
          onClick={onAvatarClick}
          className="h-9 w-9 shrink-0 mt-0.5 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-label="Switch Zero avatar"
        >
          <img
            src={zeroAvatarSrc}
            alt=""
            role="presentation"
            className="h-9 w-9 rounded-full object-cover object-top"
          />
        </button>
        <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0 flex flex-col gap-0">
          <ChatScenarioAssistantContent
            scene={scene}
            onNavigateToActivity={onNavigateToActivity}
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
  onNavigateToActivity,
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
          <Button
            size="sm"
            variant="outline"
            className="zero-chat-btn rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border"
            onClick={onNavigateToActivity}
          >
            <IconChartLine size={13} />
            View activity
          </Button>
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

interface ComposerConnectorItem {
  type: string;
  label: string;
  iconUrl?: string;
  connected: boolean;
}

function ConnectorTriggerIcons({
  connectors,
}: {
  connectors: ComposerConnectorItem[];
}) {
  const connected = connectors.filter((c) => c.connected).slice(0, 3);
  if (connected.length === 0) {
    return <IconPlug size={18} stroke={1.5} />;
  }
  return (
    <span className="flex items-center -space-x-1.5">
      {connected.map((c) => (
        <span
          key={c.type}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-background"
          style={{ border: "0.7px solid hsl(var(--gray-400))" }}
        >
          {c.iconUrl ? (
            <img src={c.iconUrl} alt="" className="h-4 w-4" />
          ) : (
            <ConnectorIcon type={c.type as ConnectorType} size={16} />
          )}
        </span>
      ))}
    </span>
  );
}

function ConnectorsPopoverButton({
  connectors,
  onOpenAddDialog,
  onConnect,
  onManageConnectors,
  agentName,
}: {
  connectors: ComposerConnectorItem[];
  onOpenAddDialog: () => void;
  onConnect: (type: string) => void;
  onManageConnectors?: () => void;
  agentName: string;
}) {
  return (
    <Popover>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex shrink-0 items-center rounded-lg h-9 px-1.5 hover:bg-accent transition-colors"
              >
                <ConnectorTriggerIcons connectors={connectors} />
              </button>
            </TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="top" className="text-xs">
            Connectors
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent side="top" align="start" className="w-64 p-0 rounded-xl">
        <div className="p-2">
          <div className="flex flex-col">
            {connectors.map((item) => (
              <div
                key={item.type}
                className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <span
                  className={cn(
                    "flex h-5 w-5 shrink-0 items-center justify-center",
                    !item.connected && "opacity-40",
                  )}
                >
                  {item.iconUrl ? (
                    <img src={item.iconUrl} alt="" className="h-5 w-5" />
                  ) : (
                    <ConnectorIcon
                      type={item.type as ConnectorType}
                      size={20}
                    />
                  )}
                </span>
                <span
                  className={cn(
                    "text-sm flex-1",
                    item.connected
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {item.label}
                </span>
                {item.connected ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0" />
                ) : (
                  <button
                    type="button"
                    className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      onConnect(item.type);
                    }}
                  >
                    Connect
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <div
          className={cn(
            "p-2 flex flex-col",
            connectors.length > 0 && "border-t border-border/50",
          )}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors"
            onClick={() => onOpenAddDialog()}
          >
            <IconPlus
              size={20}
              stroke={1.5}
              className="shrink-0 text-muted-foreground"
            />
            Add connector
          </button>
          {onManageConnectors && (
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-foreground hover:bg-accent transition-colors"
              onClick={onManageConnectors}
            >
              <IconPlug
                size={20}
                stroke={1.5}
                className="shrink-0 text-muted-foreground"
              />
              Manage connectors in {agentName}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function maybeClearOptimistic(
  optimistic: Set<string>,
  connectorMap: Map<ConnectorType, { connected: boolean }>,
  clear: () => void,
) {
  if (optimistic.size === 0) {
    return;
  }
  const allConfirmed = [...optimistic].every(
    (t) => connectorMap.get(t as ConnectorType)?.connected,
  );
  if (allConfirmed) {
    clear();
  }
}

function buildConnectorItem(
  name: string,
  skillMap: Map<string, { label: string; icon?: string }>,
  connectorMap: Map<ConnectorType, { label: string; connected: boolean }>,
  optimistic: Set<string>,
): ComposerConnectorItem {
  const skill = skillMap.get(name);
  const connector = connectorMap.get(name as ConnectorType);
  return {
    type: name,
    label: skill?.label ?? connector?.label ?? name,
    iconUrl: skill?.icon,
    connected: optimistic.has(name) ? true : (connector?.connected ?? false),
  };
}

function useUserFirstName(): string | undefined {
  const loadable = useLoadable(user$);
  if (loadable.state !== "hasData") {
    return undefined;
  }
  return loadable.data?.firstName ?? undefined;
}

function resolveConnectorLabel(
  type: string,
  skillMap: Map<string, { label: string }>,
  connectorMap: Map<ConnectorType, { label: string }>,
): string {
  return (
    skillMap.get(type)?.label ??
    connectorMap.get(type as ConnectorType)?.label ??
    type
  );
}

function buildModelOpts(model: string): { modelProvider: string } | undefined {
  return model !== "default" ? { modelProvider: model } : undefined;
}

function startConnectorFlow(
  type: string,
  connectorMap: Map<ConnectorType, { availableAuthMethods: string[] }>,
  setSelectedType: (t: ConnectorType | null) => void,
  connect: (t: ConnectorType, signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
) {
  const ct = connectorMap.get(type as ConnectorType);
  if (!ct) {
    return;
  }
  if (
    ct.availableAuthMethods.length === 1 &&
    ct.availableAuthMethods[0] === "api-token"
  ) {
    setSelectedType(type as ConnectorType);
  } else {
    detach(connect(type as ConnectorType, signal), Reason.DomCallback);
  }
}

interface ZeroChatPageProps {
  initialScenarioId?: DemoScenarioId;
  onClearScenario?: () => void;
  onNavigateToActivity?: () => void;
  onNavigateToSchedule?: () => void;
  onNavigateToTeam?: () => void;
  onNavigateToMeet?: (tab?: string) => void;
  onSendMessage?: (
    message: string,
    options?: { modelProvider?: string },
  ) => void;
  zeroAvatarSrc?: string;
  /** Override agent name when chatting with a sub-agent. */
  chatAgentName?: string;
  onAvatarClick?: () => void;
}

export function ZeroChatPage({
  initialScenarioId,
  onClearScenario,
  onNavigateToActivity,
  onNavigateToSchedule,
  onNavigateToTeam,
  onNavigateToMeet,
  onSendMessage,
  zeroAvatarSrc = "/zero-avatar.png",
  chatAgentName,
  onAvatarClick,
}: ZeroChatPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const defaultAgentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const agentName = chatAgentName ?? defaultAgentName;
  const userName = useUserFirstName();

  // Connector signals
  const allTypesLoadable = useLastLoadable(allConnectorTypes$);
  const addedSkillsLoadable = useLastLoadable(zeroAddedSkills$);
  const connectConnector = useSet(connectConnector$);
  const pageSignal = useGet(pageSignal$);
  const selectedConnType = useGet(selectedConnectorType$);
  const setSelectedConnType = useSet(setSelectedConnectorType$);
  const allSkills = useGet(skills$);
  const addSkill = useSet(addZeroSkill$);
  const saveSkills = useSet(saveZeroSkills$);
  const optimisticConnected = useGet(justConnectedTypes$);
  const clearOptimistic = useSet(clearJustConnectedTypes$);
  const addDialogOpen$ = useCCState(false);
  const addDialogOpen = useGet(addDialogOpen$);
  const setAddDialogOpen = useSet(addDialogOpen$);

  const allConnectors =
    allTypesLoadable.state === "hasData" ? allTypesLoadable.data : [];
  const connectorMap = new Map(allConnectors.map((c) => [c.type, c]));

  // Clear optimistic state only once fresh data confirms the connection
  maybeClearOptimistic(optimisticConnected, connectorMap, clearOptimistic);
  const skillMap = new Map(allSkills.map((s) => [s.value, s]));
  const addedSkills =
    addedSkillsLoadable.state === "hasData" ? addedSkillsLoadable.data : [];
  const addedSet = new Set(addedSkills);

  const composerConnectors: ComposerConnectorItem[] = addedSkills
    .filter((name) => connectorMap.has(name as ConnectorType))
    .map((name) =>
      buildConnectorItem(name, skillMap, connectorMap, optimisticConnected),
    );

  // Model provider selector (shared logic)
  const { modelOptions, selectedModel, setSelectedModel, persistSelection } =
    useModelSelection(agentName);
  const input$ = useCCState("");
  const input = useGet(input$);
  const setInput = useSet(input$);
  const attachments = useGet(zeroChatAttachments$);
  const uploadAttachment = useSet(uploadZeroAttachment$);
  const removeAttachment = useSet(removeZeroAttachment$);
  const fileInputEl$ = useCCState<HTMLInputElement | null>(null);
  const fileInputEl = useGet(fileInputEl$);
  const setFileInputEl = useSet(fileInputEl$);
  const conversationActive$ = useCCState(false);
  const conversationActive = useGet(conversationActive$);
  const setConversationActive = useSet(conversationActive$);
  const streamedCount$ = useCCState(0);
  const streamedCount = useGet(streamedCount$);
  const conversationEndEl$ = useCCState<HTMLDivElement | null>(null);
  const setConversationEndEl = useSet(conversationEndEl$);
  const subAgentListEl$ = useCCState<HTMLDivElement | null>(null);
  const setSubAgentListEl = useSet(subAgentListEl$);
  const approveDone$ = useCCState(false);
  const approveDone = useGet(approveDone$);
  const setApproveDone = useSet(approveDone$);
  const selectedOption$ = useCCState<string | null>(null);
  const selectedOption = useGet(selectedOption$);
  const setSelectedOption = useSet(selectedOption$);
  const teamPersonalChoice$ = useCCState<"team" | "personal" | null>(null);
  const teamPersonalChoice = useGet(teamPersonalChoice$);
  const setTeamPersonalChoice = useSet(teamPersonalChoice$);
  const connectorConnected$ = useCCState(false);
  const connectorConnected = useGet(connectorConnected$);
  const setConnectorConnected = useSet(connectorConnected$);
  const commandAllowed$ = useCCState(false);
  const commandAllowed = useGet(commandAllowed$);
  const setCommandAllowed = useSet(commandAllowed$);
  const showSubAgentList$ = useCCState(false);
  const showSubAgentList = useGet(showSubAgentList$);
  const taglineIndex$ = useCCState(Math.floor(Math.random() * 18));
  const taglineIndex = useGet(taglineIndex$);
  const tagline = userName ? getTagline(agentName, userName, taglineIndex) : "";
  // Stream tick — schedules the next streamed message after a delay
  const streamTimeoutId$ = useCCState<number | null>(null);
  const scheduleStreamTick$ = useCommand(({ get, set }) => {
    const active = get(conversationActive$);
    const count = get(streamedCount$);
    if (!active || count >= 6) {
      return;
    }
    const id = window.setTimeout(() => {
      set(streamTimeoutId$, null);
      set(streamedCount$, (c: number) => Math.min(c + 1, 6));
      // Auto-scroll conversation end into view
      const el = get(conversationEndEl$);
      if (el) {
        el.scrollIntoView({ behavior: "smooth" });
      }
      // Schedule next tick
      set(scheduleStreamTick$);
    }, STREAM_DELAY_MS);
    set(streamTimeoutId$, id);
  });
  // Clean up pending stream timeout on unmount
  const streamCleanup$ = useCommand(
    ({ get }, _el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        const id = get(streamTimeoutId$);
        if (id !== null) {
          window.clearTimeout(id);
        }
      });
    },
  );
  const streamCleanupRef$ = onRef(streamCleanup$);
  const streamCleanupRef = useSet(streamCleanupRef$);

  // Toggle sub-agent list with auto-scroll when opening
  const toggleSubAgentList$ = useCommand(({ get, set }) => {
    const current = get(showSubAgentList$);
    set(showSubAgentList$, !current);
    if (!current) {
      // Becoming visible — scroll into view after next paint
      window.requestAnimationFrame(() => {
        const el = get(subAgentListEl$);
        if (el) {
          el.scrollIntoView({ behavior: "smooth" });
        }
      });
    }
  });
  const toggleSubAgentList = useSet(toggleSubAgentList$);

  const handleConnectSuccess = (type: string) => {
    const label = resolveConnectorLabel(type, skillMap, connectorMap);
    detach(
      (async () => {
        await addSkill(type);
        await saveSkills();
        toast.success(`${label} connected`);
      })(),
      Reason.DomCallback,
    );
  };

  const handleConnectConnector = (type: string) =>
    startConnectorFlow(
      type,
      connectorMap,
      setSelectedConnType,
      connectConnector,
      pageSignal,
    );

  const handleSend = (messageOverride?: string) => {
    const text = (messageOverride ?? input).trim();
    if (!text) {
      return;
    }
    if (!messageOverride) {
      setInput("");
    }
    persistSelection();
    onSendMessage?.(text, buildModelOpts(selectedModel));
  };

  const handleKeyDown = useSendKeyHandler(handleSend);

  const handleFileSelect = () => {
    fileInputEl?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) {
      return;
    }
    for (const file of files) {
      detach(uploadAttachment(file), Reason.DomCallback);
    }
    e.target.value = "";
  };

  const streamedScenarios = getStreamedScenarios(agentName);
  const scenariosToShow = initialScenarioId
    ? streamedScenarios.filter((s) => s.id === initialScenarioId)
    : conversationActive
      ? streamedScenarios.slice(0, streamedCount)
      : [];
  const showConversation =
    (initialScenarioId !== undefined && scenariosToShow.length > 0) ||
    conversationActive;

  const fileInput = (
    <input
      ref={setFileInputEl}
      type="file"
      className="hidden"
      accept="image/*,.pdf,.txt,.csv,.md,.json"
      multiple
      onChange={handleFileChange}
    />
  );

  if (showConversation && scenariosToShow.length > 0) {
    const isScenarioFromSidebar = initialScenarioId !== undefined;
    return (
      <div
        ref={streamCleanupRef}
        className="flex flex-1 flex-col min-h-0 bg-transparent"
      >
        {fileInput}
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
              onClick={onAvatarClick}
              className="h-8 w-8 shrink-0 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch Zero avatar"
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
                  onAvatarClick={onAvatarClick}
                  agentName={agentName}
                />
              ) : (
                <ChatScenarioBlock
                  key={scene.id}
                  scene={scene}
                  onNavigateToActivity={onNavigateToActivity}
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
                  onAvatarClick={onAvatarClick}
                  agentName={agentName}
                />
              ),
            )}
            {showSubAgentList && (
              <div
                ref={setSubAgentListEl}
                className="grid grid-cols-[48px_1fr] gap-3 items-start animate-in fade-in slide-in-from-bottom-2 duration-300"
              >
                <button
                  type="button"
                  onClick={onAvatarClick}
                  className="h-9 w-9 shrink-0 mt-0.5 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  aria-label="Switch Zero avatar"
                >
                  <img
                    src={zeroAvatarSrc}
                    alt=""
                    role="presentation"
                    className="h-9 w-9 rounded-full object-cover object-top"
                  />
                </button>
                <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm overflow-hidden min-w-0 flex flex-col">
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
                    <Button
                      variant="outline"
                      size="sm"
                      className="zero-btn-morandi w-fit rounded-lg"
                      onClick={onNavigateToTeam}
                    >
                      Manage in {agentName}&apos;s team
                    </Button>
                  </div>
                </div>
              </div>
            )}
            <div ref={setConversationEndEl} />
          </div>
        </main>
        <footer className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-8">
          <div className="mx-auto max-w-[900px] grid grid-cols-[48px_1fr] gap-3">
            <div className="w-9 shrink-0" />
            <Card className="zero-composer w-full min-w-0 overflow-hidden transition-colors duration-200">
              <CardContent className="p-0">
                <div className="flex flex-col">
                  {attachments.length > 0 && (
                    <AttachmentChips
                      attachments={attachments}
                      onRemove={removeAttachment}
                    />
                  )}
                  <textarea
                    className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
                    rows={3}
                    placeholder="Ask me to automate workflows, manage tasks..."
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                  <div className="flex items-center justify-between gap-2 px-4 py-3">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <button
                        type="button"
                        className="p-2 rounded-lg hover:bg-accent hover:text-foreground transition-colors duration-200"
                        aria-label="Attach"
                        onClick={handleFileSelect}
                      >
                        <IconPaperclip size={18} stroke={1.5} />
                      </button>
                      <ConnectorsPopoverButton
                        connectors={composerConnectors}
                        onOpenAddDialog={() => setAddDialogOpen(true)}
                        onConnect={handleConnectConnector}
                        onManageConnectors={() =>
                          onNavigateToMeet?.("connectors")
                        }
                        agentName={agentName}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Select
                        value={selectedModel}
                        onValueChange={setSelectedModel}
                      >
                        <SelectTrigger className="h-9 min-w-[100px] gap-1 rounded-lg border-none bg-transparent text-sm text-foreground shadow-none hover:bg-accent transition-colors [&>svg]:h-5 [&>svg]:w-5 [&>svg]:opacity-80">
                          <SelectValue placeholder="Model" />
                        </SelectTrigger>
                        <SelectContent>
                          {modelOptions.map((opt) => (
                            <SelectItem
                              key={opt.value}
                              value={opt.value}
                              className="text-sm"
                            >
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        className="rounded-lg h-9 w-9 p-0 shrink-0"
                        onClick={() => handleSend()}
                        disabled={!input.trim()}
                        aria-label="Send"
                      >
                        <IconSend size={16} stroke={2} />
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </footer>
      </div>
    );
  }

  // Landing page: full content (title, triggers, composer, actions, prompts)
  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      {fileInput}
      <header
        className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-2"
        aria-hidden="true"
      />

      <main className="flex flex-1 flex-col justify-center overflow-auto px-4 sm:px-6 py-12">
        <div className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-8 -mt-24">
          <div className="flex items-center gap-4 w-full">
            <button
              type="button"
              onClick={onAvatarClick}
              className="h-14 w-14 shrink-0 sm:h-16 sm:w-16 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="Switch Zero avatar"
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
          <Card className="zero-composer w-full overflow-hidden transition-colors duration-200">
            <CardContent className="p-0">
              <div className="flex flex-col">
                {attachments.length > 0 && (
                  <AttachmentChips
                    attachments={attachments}
                    onRemove={removeAttachment}
                  />
                )}
                <textarea
                  className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
                  rows={3}
                  placeholder="Ask me to automate workflows, manage tasks..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <button
                      type="button"
                      className="p-2 rounded-lg hover:bg-accent hover:text-foreground transition-colors duration-200"
                      aria-label="Attach"
                      onClick={handleFileSelect}
                    >
                      <IconPaperclip size={18} stroke={1.5} />
                    </button>
                    <ConnectorsPopoverButton
                      connectors={composerConnectors}
                      onOpenAddDialog={() => setAddDialogOpen(true)}
                      onConnect={handleConnectConnector}
                      onManageConnectors={() =>
                        onNavigateToMeet?.("connectors")
                      }
                      agentName={agentName}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedModel}
                      onValueChange={setSelectedModel}
                    >
                      <SelectTrigger className="h-9 min-w-[100px] gap-1 rounded-lg border-none bg-transparent text-sm text-foreground shadow-none hover:bg-accent transition-colors [&>svg]:h-5 [&>svg]:w-5 [&>svg]:opacity-80">
                        <SelectValue placeholder="Model" />
                      </SelectTrigger>
                      <SelectContent>
                        {modelOptions.map((opt) => (
                          <SelectItem
                            key={opt.value}
                            value={opt.value}
                            className="text-sm"
                          >
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="sm"
                      className="rounded-lg h-9 w-9 p-0 shrink-0"
                      onClick={() => handleSend()}
                      disabled={!input.trim()}
                      aria-label="Send"
                    >
                      <IconSend size={16} stroke={2} />
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Suggested prompts */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full">
            {SUGGESTED_PROMPTS.map(
              ({ title, description, image, imageClassName, prompt }) => (
                <button
                  key={title}
                  type="button"
                  className="zero-card cursor-pointer p-4 text-left flex gap-3 items-center relative group"
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
      <AddConnectionDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        variant="zero"
        excludeTypes={addedSet}
        onConnectSuccess={handleConnectSuccess}
        onAdd={handleConnectSuccess}
      />
      {selectedConnType && (
        <ConnectModal
          onClose={() => setSelectedConnType(null)}
          onSuccess={() => {
            if (selectedConnType && !addedSet.has(selectedConnType)) {
              handleConnectSuccess(selectedConnType);
            }
          }}
        />
      )}
    </div>
  );
}
