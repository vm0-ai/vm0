import { useState, useEffect, useRef } from "react";
import {
  IconSend,
  IconPaperclip,
  IconMoodSmile,
  IconMicrophone,
  IconPlus,
  IconBriefcase,
  IconSettings,
  IconPlug,
  IconSparkles,
  IconChartBar,
  IconReceipt,
  IconUser,
  IconUsers,
  IconCheck,
  IconArrowLeft,
  IconChartLine,
  IconChevronDown,
  IconChevronUp,
} from "@tabler/icons-react";
import { Button, Card, CardContent, cn } from "@vm0/ui";

export type DemoScenarioId =
  | "approve"
  | "ask-options"
  | "team-personal"
  | "connect-connector"
  | "rich-summary"
  | "agent-operations";

const ACTION_BUTTONS: {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}[] = [
  { label: "Create workflow", icon: IconBriefcase },
  { label: "Customize Zero", icon: IconSettings },
  { label: "Add connectors", icon: IconPlug },
];

const SUGGESTED_PROMPTS: {
  title: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  iconClassName?: string;
}[] = [
  {
    title: "Daily team digest",
    description: "Summarize activity and updates for the team",
    icon: IconChartBar,
    iconClassName: "text-emerald-600 dark:text-emerald-400",
  },
  {
    title: "Reimbursement workflow",
    description: "Submit and track reimbursement requests",
    icon: IconReceipt,
    iconClassName: "text-primary",
  },
];

const STREAMED_SCENARIOS: {
  id: DemoScenarioId;
  userMessage: string;
  assistantMessage: string;
}[] = [
  {
    id: "approve",
    userMessage: "Run the deployment to production",
    assistantMessage:
      "This action requires approval. Allow Zero to run the deployment?",
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

const STREAM_DELAY_MS = 1400;

interface ChatScenarioBlockProps {
  scene: (typeof STREAMED_SCENARIOS)[number];
  onNavigateToActivity?: () => void;
  expandStep1: boolean;
  setExpandStep1: (fn: (v: boolean) => boolean) => void;
  expandStep2: boolean;
  setExpandStep2: (fn: (v: boolean) => boolean) => void;
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
}

function ChatScenarioBlock({
  scene,
  onNavigateToActivity,
  expandStep1,
  setExpandStep1,
  expandStep2,
  setExpandStep2,
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
}: ChatScenarioBlockProps) {
  return (
    <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        <div className="w-9 h-9 shrink-0" />
        <div className="flex min-w-0 justify-end">
          <div className="rounded-2xl px-4 py-3 max-w-[85%] bg-muted text-foreground text-sm leading-relaxed">
            {scene.userMessage}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        <img
          src="/zero-avatar.png"
          alt=""
          role="presentation"
          className="h-9 w-9 shrink-0 rounded-full object-cover object-top mt-0.5"
        />
        <div className="rounded-2xl border border-border/40 bg-card/98 backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0 flex flex-col gap-0">
          <ChatScenarioAssistantContent
            scene={scene}
            onNavigateToActivity={onNavigateToActivity}
            expandStep1={expandStep1}
            setExpandStep1={setExpandStep1}
            expandStep2={expandStep2}
            setExpandStep2={setExpandStep2}
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
  expandStep1,
  setExpandStep1,
  expandStep2,
  setExpandStep2,
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
            className="rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border-border/70 hover:bg-muted/40"
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
        expandStep1={expandStep1}
        setExpandStep1={setExpandStep1}
        expandStep2={expandStep2}
        setExpandStep2={setExpandStep2}
        commandAllowed={commandAllowed}
        setCommandAllowed={setCommandAllowed}
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
                className="rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                onClick={() => setApproveDone(true)}
              >
                <IconCheck size={13} />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-lg h-8 px-3.5 text-sm font-medium border-border/70 hover:bg-muted/40"
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
                  "rounded-lg h-8 px-3.5 text-sm font-medium border transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  "border-border/50 text-foreground hover:border-border hover:bg-muted/20 hover:text-foreground",
                  selectedOption === opt &&
                    "border-primary/40 bg-primary/8 text-primary ring-1 ring-primary/20 ring-inset",
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
                "rounded-lg h-8 px-3.5 text-sm font-medium border transition-all duration-200 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "border-border/50 text-foreground hover:border-border hover:bg-muted/20 hover:text-foreground",
                teamPersonalChoice === "team" &&
                  "border-primary/40 bg-primary/8 text-primary ring-1 ring-primary/20 ring-inset",
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
                "rounded-lg h-8 px-3.5 text-sm font-medium border transition-all duration-200 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "border-border/50 text-foreground hover:border-border hover:bg-muted/20 hover:text-foreground",
                teamPersonalChoice === "personal" &&
                  "border-primary/40 bg-primary/8 text-primary ring-1 ring-primary/20 ring-inset",
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
  expandStep1,
  setExpandStep1,
  expandStep2,
  setExpandStep2,
  commandAllowed,
  setCommandAllowed,
}: {
  expandStep1: boolean;
  setExpandStep1: (fn: (v: boolean) => boolean) => void;
  expandStep2: boolean;
  setExpandStep2: (fn: (v: boolean) => boolean) => void;
  commandAllowed: boolean;
  setCommandAllowed: (v: boolean) => void;
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
            <div className="mt-2.5 rounded-lg border border-border/40 bg-muted/10">
              <button
                type="button"
                onClick={() => setExpandStep1((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm text-foreground hover:bg-muted/20 transition-colors rounded-lg"
                aria-expanded={expandStep1}
              >
                <span className="min-w-0 truncate">
                  google-calendar MCP tools
                </span>
                <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground">
                  {expandStep1 ? (
                    <IconChevronUp size={14} />
                  ) : (
                    <IconChevronDown size={14} />
                  )}
                </span>
              </button>
              {expandStep1 && (
                <div className="border-t border-border/30 px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    List available tools for the google-calendar MCP server.
                  </p>
                  <ul className="space-y-1 text-sm text-foreground font-mono">
                    <li>calendar_list_calendars</li>
                    <li>calendar_get_events</li>
                    <li>calendar_create_event</li>
                    <li>calendar_update_event</li>
                    <li>calendar_delete_event</li>
                    <li>calendar_list_acl</li>
                  </ul>
                </div>
              )}
            </div>
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
            <div className="mt-2.5 rounded-lg border border-border/40 bg-muted/10">
              <button
                type="button"
                onClick={() => setExpandStep2((v) => !v)}
                className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm text-foreground hover:bg-muted/20 transition-colors rounded-lg"
                aria-expanded={expandStep2}
              >
                <span className="min-w-0 truncate">Calendar. 10 results.</span>
                <span className="shrink-0 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground">
                  {expandStep2 ? (
                    <IconChevronUp size={14} />
                  ) : (
                    <IconChevronDown size={14} />
                  )}
                </span>
              </button>
              {expandStep2 && (
                <div className="border-t border-border/30 px-4 py-3">
                  <p className="text-xs text-muted-foreground mb-2">
                    Searching Calendar. 10 results.
                  </p>
                  <ul className="space-y-1.5 text-sm text-foreground">
                    <li>Team standup — Mon 10:00</li>
                    <li>Product review — Tue 14:00</li>
                    <li>1:1 with Alex — Wed 09:30</li>
                    <li>Sprint planning — Wed 15:00</li>
                    <li>Design sync — Thu 11:00</li>
                    <li>Release prep — Thu 16:00</li>
                    <li>Stakeholder demo — Fri 10:00</li>
                    <li>Retro — Fri 14:00</li>
                    <li>Office hours — Fri 15:30</li>
                    <li>Week planning — Fri 17:00</li>
                  </ul>
                </div>
              )}
            </div>
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
              Allow Zero to run the following command to verify Node and npm.
            </p>
            {!commandAllowed ? (
              <div className="mt-3 rounded-lg border border-border/40 bg-muted/10 px-4 py-3">
                <p className="text-sm text-foreground leading-relaxed">
                  Allow Zero to run the following command to verify Node.js and
                  npm:{" "}
                  <code className="font-mono text-xs bg-muted/50 px-1.5 py-0.5 rounded">
                    node --version && npm --version
                  </code>
                </p>
                <div className="mt-3 pt-3 flex flex-wrap gap-2 border-t border-border/30">
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-lg h-8 px-3.5 text-sm font-medium gap-1.5 border-primary/40 bg-primary/10 text-primary hover:bg-primary/15"
                    onClick={() => setCommandAllowed(true)}
                  >
                    <IconCheck size={13} />
                    Allow once
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-lg h-8 px-3.5 text-sm font-medium border-border/70 hover:bg-muted/40"
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

interface ZeroChatPageProps {
  initialScenarioId?: DemoScenarioId;
  onClearScenario?: () => void;
  onNavigateToActivity?: () => void;
}

export function ZeroChatPage({
  initialScenarioId,
  onClearScenario,
  onNavigateToActivity,
}: ZeroChatPageProps) {
  const [input, setInput] = useState("");
  const [conversationActive, setConversationActive] = useState(false);
  const [streamedCount, setStreamedCount] = useState(0);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const [approveDone, setApproveDone] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [teamPersonalChoice, setTeamPersonalChoice] = useState<
    "team" | "personal" | null
  >(null);
  const [connectorConnected, setConnectorConnected] = useState(false);
  const [commandAllowed, setCommandAllowed] = useState(false);
  const [expandStep1, setExpandStep1] = useState(false);
  const [expandStep2, setExpandStep2] = useState(false);

  useEffect(() => {
    if (!conversationActive || streamedCount >= 6) {
      return;
    }
    const id = window.setTimeout(() => {
      setStreamedCount((c) => Math.min(c + 1, 6));
    }, STREAM_DELAY_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [conversationActive, streamedCount]);

  useEffect(() => {
    if (streamedCount > 0 && conversationEndRef.current) {
      conversationEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [streamedCount]);

  const handleComposerFocus = () => {
    if (!conversationActive) {
      setConversationActive(true);
      setStreamedCount(1);
    }
  };

  const handleSend = (messageOverride?: string) => {
    const text = (messageOverride ?? input).trim();
    if (!text) {
      return;
    }
    if (!messageOverride) {
      setInput("");
    }
    // TODO: send message
  };

  const LUCKY_PROMPTS = [
    "What can you help me with today?",
    "Suggest something useful I might have missed",
    "Summarize my last few days in one sentence",
    "What’s one quick win I could do right now?",
  ];

  const handleFeelingLucky = () => {
    handleComposerFocus();
    const prompt =
      LUCKY_PROMPTS[Math.floor(Math.random() * LUCKY_PROMPTS.length)];
    handleSend(prompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const scenariosToShow = initialScenarioId
    ? STREAMED_SCENARIOS.filter((s) => s.id === initialScenarioId)
    : conversationActive
      ? STREAMED_SCENARIOS.slice(0, streamedCount)
      : [];
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
            <img
              src="/zero-avatar.png"
              alt=""
              role="presentation"
              className="h-8 w-8 rounded-full object-cover object-top"
            />
            <span className="font-semibold text-foreground">Zero</span>
          </div>
        </header>
        <main className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <div className="mx-auto max-w-[748px] flex flex-col gap-6 pb-4">
            {scenariosToShow.map((scene) => (
              <ChatScenarioBlock
                key={scene.id}
                scene={scene}
                onNavigateToActivity={onNavigateToActivity}
                expandStep1={expandStep1}
                setExpandStep1={setExpandStep1}
                expandStep2={expandStep2}
                setExpandStep2={setExpandStep2}
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
              />
            ))}
            <div ref={conversationEndRef} />
          </div>
        </main>
        <footer className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-8">
          <div className="mx-auto max-w-[748px] grid grid-cols-[48px_1fr] gap-3">
            <div className="w-9 shrink-0" />
            <Card className="w-full min-w-0 rounded-2xl border border-border/60 bg-card shadow-[0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden transition-colors duration-200">
              <CardContent className="p-0">
                <div className="flex flex-col">
                  <textarea
                    className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
                    rows={3}
                    placeholder="Ask me to create workflows, manage tasks..."
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                  <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border/50">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <button
                        type="button"
                        className="p-2 rounded-lg hover:bg-muted/60 hover:text-foreground transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        aria-label="Add"
                      >
                        <IconPlus size={18} stroke={1.5} />
                      </button>
                      <button
                        type="button"
                        className="p-2 rounded-lg hover:bg-muted/60 hover:text-foreground transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        aria-label="Attach"
                      >
                        <IconPaperclip size={18} stroke={1.5} />
                      </button>
                      <button
                        type="button"
                        className="p-2 rounded-lg hover:bg-muted/60 hover:text-foreground transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        aria-label="Emoji"
                      >
                        <IconMoodSmile size={18} stroke={1.5} />
                      </button>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        className="p-2 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        aria-label="Voice input"
                      >
                        <IconMicrophone size={18} stroke={1.5} />
                      </button>
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
    <div className="flex flex-1 flex-col min-h-0">
      <header
        className="shrink-0 bg-transparent px-4 sm:px-6 pt-10 pb-2"
        aria-hidden="true"
      />

      <main className="flex flex-1 flex-col justify-center overflow-auto px-4 sm:px-6 py-12">
        <div className="mx-auto max-w-[700px] flex flex-col items-center gap-8 -mt-24">
          <div className="flex items-center gap-4 w-full">
            <img
              src="/zero-avatar.png"
              alt=""
              role="presentation"
              className="h-14 w-14 shrink-0 rounded-full object-cover object-top sm:h-16 sm:w-16"
            />
            <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-foreground">
              What are we pushing live next?
            </h2>
          </div>

          {/* Composer */}
          <Card className="w-full rounded-2xl border border-border/60 bg-card shadow-[0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden transition-colors duration-200">
            <CardContent className="p-0">
              <div className="flex flex-col">
                <textarea
                  className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
                  rows={3}
                  placeholder="Ask me to create workflows, manage tasks..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onFocus={handleComposerFocus}
                />
                <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border/50">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <button
                      type="button"
                      className="p-2 rounded-lg hover:bg-muted/60 hover:text-foreground transition-colors"
                      aria-label="Add"
                    >
                      <IconPlus size={18} stroke={1.5} />
                    </button>
                    <button
                      type="button"
                      className="p-2 rounded-lg hover:bg-muted/60 hover:text-foreground transition-colors"
                      aria-label="Attach"
                    >
                      <IconPaperclip size={18} stroke={1.5} />
                    </button>
                    <button
                      type="button"
                      className="p-2 rounded-lg hover:bg-muted/60 hover:text-foreground transition-colors"
                      aria-label="Emoji"
                    >
                      <IconMoodSmile size={18} stroke={1.5} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="p-2 rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                      aria-label="Voice input"
                    >
                      <IconMicrophone size={18} stroke={1.5} />
                    </button>
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

          {/* Action buttons */}
          <div className="flex flex-wrap justify-between items-center gap-2 w-full">
            <div className="flex flex-wrap gap-2">
              {ACTION_BUTTONS.map(({ label, icon: Icon }) => (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  className="rounded-lg h-8 px-3.5 text-sm font-medium gap-2 border-border/70 hover:bg-muted/40"
                >
                  <Icon size={16} />
                  {label}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg h-8 px-3.5 text-sm font-medium gap-2 border-primary/30 text-primary hover:bg-primary/5 hover:border-primary/50 shrink-0"
              type="button"
              onClick={handleFeelingLucky}
            >
              <IconSparkles size={16} />
              Feeling great
            </Button>
          </div>

          {/* Suggested prompts grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
            {SUGGESTED_PROMPTS.map(
              ({ title, description, icon: Icon, iconClassName }) => (
                <button
                  key={title}
                  type="button"
                  className={cn(
                    "rounded-xl border border-border/70 bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
                    "p-4 text-left hover:bg-muted/40 hover:border-border transition-colors",
                    "flex gap-3 items-start",
                  )}
                >
                  <span
                    className={cn(
                      "shrink-0 mt-0.5 rounded-lg p-1.5 bg-muted/50",
                      iconClassName ?? "text-muted-foreground",
                    )}
                  >
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0">
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
