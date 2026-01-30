import { CopyButton } from "@vm0/ui";
import { getEventStyle } from "../constants/event-styles.ts";
import { CollapsibleJson } from "./collapsible-json.tsx";
import { highlightText } from "../utils/highlight-text.tsx";
import type { AgentEvent } from "../../../signals/logs-page/types.ts";
import {
  IconFile,
  IconTerminal,
  IconWorld,
  IconSearch,
  IconClock,
  IconCurrencyDollar,
  IconAlertCircle,
  IconArrowRight,
  IconCircleCheck,
  IconProgress,
  IconCircleDashed,
  IconListCheck,
  IconChevronRight,
} from "@tabler/icons-react";

interface EventCardProps {
  event: AgentEvent;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}

// Type definitions for message content
interface TextContent {
  type: "text";
  text: string;
}

interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type MessageContent = TextContent | ToolUseContent | ToolResultContent;

interface MessageData {
  content: MessageContent[] | null;
  id: string | null;
  model: string | null;
  role: string | null;
  stop_reason: string | null;
  usage?: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
  };
}

interface ToolResultMeta {
  bytes?: number | null;
  code?: number | null;
  codeText?: string | null;
  durationMs?: number | null;
  url?: string | null;
  filePath?: string | null;
  query?: string | null;
  result?: string | null;
}

interface EventData {
  type?: string;
  subtype?: string;
  message?: MessageData;
  tool_use_result?: ToolResultMeta;
  model?: string;
  session_id?: string;
  tools?: string[];
  agents?: string[];
  slash_commands?: string[];
  total_cost_usd?: number | null;
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  num_turns?: number | null;
  modelUsage?: Record<
    string,
    {
      costUSD?: number | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
    }
  >;
  is_error?: boolean;
  result?: string | null;
}

function formatEventTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

// ============ SYSTEM EVENT (Init) ============

function CollapsibleSection({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="group" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-1 text-sm text-foreground hover:text-foreground/80 transition-colors">
        <span>
          {count} {title}
        </span>
        <IconChevronRight className="h-5 w-5 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

function TagList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className="text-xs font-medium text-muted-foreground bg-background border border-border px-1.5 py-0.5 rounded-md"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function SystemInitContent({ eventData }: { eventData: EventData }) {
  const tools = eventData.tools ?? [];
  const agents = eventData.agents ?? [];
  const slashCommands = eventData.slash_commands ?? [];

  return (
    <div className="mt-2 space-y-2">
      {/* Tools */}
      {tools.length > 0 && (
        <CollapsibleSection
          title="tools available"
          count={tools.length}
          defaultOpen
        >
          <TagList items={tools} />
        </CollapsibleSection>
      )}

      {/* Agents */}
      {agents.length > 0 && (
        <CollapsibleSection title="agents" count={agents.length}>
          <TagList items={agents} />
        </CollapsibleSection>
      )}

      {/* Slash Commands */}
      {slashCommands.length > 0 && (
        <CollapsibleSection title="Slash Commands" count={slashCommands.length}>
          <TagList items={slashCommands.map((cmd) => `/${cmd}`)} />
        </CollapsibleSection>
      )}
    </div>
  );
}

// ============ TEXT CONTENT ============

function TextContentView({
  content,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
}: {
  content: TextContent;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}) {
  const text = content.text;
  if (!text) {
    return null;
  }

  const contentElement = searchTerm
    ? highlightText(text, {
        searchTerm,
        currentMatchIndex,
        matchStartIndex,
      }).element
    : text;

  return (
    <div className="text-sm text-foreground whitespace-pre-wrap">
      {contentElement}
    </div>
  );
}

// ============ TOOL USE CONTENT ============

function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();
  if (name === "bash") {
    return IconTerminal;
  }
  if (name === "webfetch") {
    return IconWorld;
  }
  if (name === "websearch") {
    return IconSearch;
  }
  if (name === "todowrite") {
    return IconListCheck;
  }
  if (
    name.includes("read") ||
    name.includes("write") ||
    name.includes("edit") ||
    name.includes("glob") ||
    name.includes("grep")
  ) {
    return IconFile;
  }
  return null;
}

function ToolUseContentView({ content }: { content: ToolUseContent }) {
  const toolName = content.name;
  const input = content.input;
  const ToolIcon = getToolIcon(toolName);
  const isTodoWrite = toolName.toLowerCase() === "todowrite";

  return (
    <div className="space-y-2">
      {/* Tool header */}
      <div className="flex items-center gap-2">
        {!isTodoWrite && ToolIcon && (
          <ToolIcon className="h-4 w-4 text-muted-foreground" />
        )}
        <span className="font-medium text-sm text-foreground">{toolName}</span>
      </div>

      {/* Tool parameters */}
      <ToolInputParams input={input} toolName={toolName} />
    </div>
  );
}

function ToolInputParams({
  input,
  toolName,
}: {
  input: Record<string, unknown>;
  toolName: string;
}) {
  if (!input || Object.keys(input).length === 0) {
    return null;
  }

  // Special rendering for common tools
  const lowerName = toolName.toLowerCase();

  // WebFetch / WebSearch - show URL and prompt prominently
  if (lowerName === "webfetch" || lowerName === "websearch") {
    const url = input.url as string | undefined;
    const prompt = input.prompt as string | undefined;
    const query = input.query as string | undefined;

    return (
      <div className="space-y-2 text-sm">
        {url && (
          <div className="flex items-center gap-2">
            <IconWorld className="h-4 w-4 text-muted-foreground shrink-0" />
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-blue-600 hover:underline break-all"
            >
              {url}
            </a>
          </div>
        )}
        {query && (
          <div className="flex items-start gap-2">
            <IconSearch className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <span className="text-foreground">{query}</span>
          </div>
        )}
        {prompt && (
          <div className="text-muted-foreground text-xs mt-1 pl-6">
            {prompt}
          </div>
        )}
      </div>
    );
  }

  // Bash - show command
  if (lowerName === "bash") {
    const command = input.command as string | undefined;
    return (
      <div className="flex gap-2 items-start bg-sidebar rounded-[10px] px-4 py-3 w-full">
        <code className="flex-1 font-mono text-sm text-foreground overflow-x-auto whitespace-pre-wrap min-w-0">
          {command}
        </code>
        {command && (
          <CopyButton text={command} className="shrink-0 h-4 w-4 p-0" />
        )}
      </div>
    );
  }

  // File operations - show file path
  if (
    lowerName === "read" ||
    lowerName === "write" ||
    lowerName === "edit" ||
    lowerName === "glob" ||
    lowerName === "grep"
  ) {
    const filePath = (input.file_path ?? input.path ?? input.pattern) as
      | string
      | undefined;
    return (
      <div className="flex items-center gap-2 text-sm">
        <IconFile className="h-4 w-4 text-muted-foreground shrink-0" />
        <code className="font-mono text-xs bg-background px-2 py-1 rounded">
          {filePath}
        </code>
      </div>
    );
  }

  // TodoWrite - show as a checklist
  if (lowerName === "todowrite") {
    const todos = input.todos;
    if (Array.isArray(todos)) {
      return (
        <div className="space-y-2">
          {todos.map((todo) => {
            const item = todo as {
              content?: string;
              status?: string;
              activeForm?: string;
            };
            const content = item.content ?? String(todo);
            const status = item.status ?? "pending";
            const StatusIcon =
              status === "completed"
                ? IconCircleCheck
                : status === "in_progress"
                  ? IconProgress
                  : IconCircleDashed;
            const statusColor =
              status === "completed"
                ? "text-emerald-600"
                : status === "in_progress"
                  ? "text-yellow-600"
                  : "text-muted-foreground";
            return (
              <div
                key={`${status}-${content}`}
                className="flex items-center gap-2"
              >
                <StatusIcon className={`h-6 w-6 shrink-0 ${statusColor}`} />
                <span className="text-sm text-foreground">{content}</span>
              </div>
            );
          })}
        </div>
      );
    }
  }

  // Generic: show all parameters as key-value pairs
  const entries = Object.entries(input);
  return (
    <div className="space-y-1.5 text-sm">
      {entries.map(([key, val]) => (
        <div key={key} className="flex items-start gap-2">
          <span className="text-muted-foreground shrink-0 min-w-[80px] text-xs">
            {key}:
          </span>
          <div className="min-w-0 flex-1">
            <ParamValue value={val} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ParamValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic text-xs">null</span>;
  }

  if (typeof value === "boolean") {
    return (
      <span
        className={
          value
            ? "text-emerald-600 text-xs font-medium"
            : "text-muted-foreground text-xs"
        }
      >
        {value ? "true" : "false"}
      </span>
    );
  }

  if (typeof value === "number") {
    return <span className="text-violet-600 text-xs font-medium">{value}</span>;
  }

  if (typeof value === "string") {
    if (value.length > 100) {
      return (
        <details className="group inline">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground text-xs">
            &quot;{value.slice(0, 50)}...&quot;
          </summary>
          <div className="mt-1 text-xs bg-background p-2 rounded whitespace-pre-wrap">
            {value}
          </div>
        </details>
      );
    }
    return <span className="text-foreground text-xs">&quot;{value}&quot;</span>;
  }

  if (Array.isArray(value) || typeof value === "object") {
    return <CollapsibleJson data={value} />;
  }

  return <span className="text-xs">{String(value)}</span>;
}

// ============ TOOL RESULT CONTENT ============

function ToolResultContentView({
  content,
  toolMeta,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
}: {
  content: ToolResultContent;
  toolMeta?: ToolResultMeta;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}) {
  const isError = content.is_error === true;
  const resultText = content.content;

  // Error display
  if (isError) {
    const errorElement = searchTerm
      ? highlightText(resultText, {
          searchTerm,
          currentMatchIndex,
          matchStartIndex,
        }).element
      : resultText;
    return (
      <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-sm">
        <div className="flex items-center gap-2 text-red-600 font-medium mb-2">
          <IconAlertCircle className="h-4 w-4" />
          Error
        </div>
        <pre className="whitespace-pre-wrap overflow-x-auto text-xs text-red-600">
          {errorElement}
        </pre>
      </div>
    );
  }

  // Tool metadata (bytes, duration, etc.)
  const metaItems: { label: string; value: string }[] = [];
  if (toolMeta?.url) {
    metaItems.push({ label: "URL", value: toolMeta.url });
  }
  if (toolMeta?.code !== null && toolMeta?.code !== undefined) {
    metaItems.push({
      label: "Status",
      value: `${toolMeta.code} ${toolMeta.codeText ?? ""}`,
    });
  }
  if (toolMeta?.durationMs !== null && toolMeta?.durationMs !== undefined) {
    metaItems.push({
      label: "Duration",
      value: formatDuration(toolMeta.durationMs),
    });
  }
  if (toolMeta?.bytes !== null && toolMeta?.bytes !== undefined) {
    metaItems.push({
      label: "Size",
      value: `${(toolMeta.bytes / 1024).toFixed(1)} KB`,
    });
  }

  return (
    <div className="space-y-2">
      {/* Metadata badges */}
      {metaItems.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {metaItems.map((item) => (
            <span
              key={item.label}
              className="bg-background px-2 py-0.5 rounded text-muted-foreground"
            >
              {item.label}:{" "}
              <span className="text-foreground">{item.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Result content */}
      <ResultContent
        text={resultText}
        searchTerm={searchTerm}
        currentMatchIndex={currentMatchIndex}
        matchStartIndex={matchStartIndex}
      />
    </div>
  );
}

function ResultContent({
  text,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
}: {
  text: string;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}) {
  if (!text || text.trim() === "") {
    return (
      <div className="text-sm text-muted-foreground italic">(empty output)</div>
    );
  }

  const lines = text.split("\n");
  const isLong = lines.length > 10 || text.length > 500;

  // Check if search term matches this content
  const hasSearchMatch =
    searchTerm &&
    searchTerm.trim() &&
    text.toLowerCase().includes(searchTerm.toLowerCase());

  const contentElement = searchTerm
    ? highlightText(text, {
        searchTerm,
        currentMatchIndex,
        matchStartIndex,
      }).element
    : text;

  if (isLong) {
    // Open the details if search matches content or if it's short enough
    const shouldBeOpen = hasSearchMatch || lines.length <= 15;
    return (
      <details className="group" open={shouldBeOpen}>
        <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
          Output ({lines.length} lines)
        </summary>
        <div className="mt-2 flex gap-2 items-start bg-sidebar rounded-[10px] px-4 py-3">
          <pre className="flex-1 text-xs text-foreground whitespace-pre-wrap overflow-x-auto max-h-80 overflow-y-auto min-w-0">
            {contentElement}
          </pre>
          <CopyButton text={text} className="shrink-0 h-4 w-4 p-0" />
        </div>
      </details>
    );
  }

  return (
    <div className="flex gap-2 items-start bg-sidebar rounded-[10px] px-4 py-3">
      <pre className="flex-1 text-xs text-foreground whitespace-pre-wrap overflow-x-auto min-w-0">
        {contentElement}
      </pre>
      <CopyButton text={text} className="shrink-0 h-4 w-4 p-0" />
    </div>
  );
}

// ============ RESULT EVENT (Final stats) ============

function ResultEventContent({ eventData }: { eventData: EventData }) {
  const isError = eventData.is_error === true;
  const totalCost = eventData.total_cost_usd;
  const durationMs = eventData.duration_ms;
  const numTurns = eventData.num_turns;
  const modelUsage = eventData.modelUsage;
  const result = eventData.result;

  return (
    <div className="mt-3 space-y-3">
      {/* Summary stats */}
      <div className="flex flex-wrap gap-4 text-sm">
        {durationMs !== null && durationMs !== undefined && (
          <div className="flex items-center gap-1.5">
            <IconClock className="h-4 w-4 text-muted-foreground" />
            <span className="text-foreground">
              {formatDuration(durationMs)}
            </span>
          </div>
        )}
        {totalCost !== null && totalCost !== undefined && (
          <div className="flex items-center gap-1.5">
            <IconCurrencyDollar className="h-4 w-4 text-muted-foreground" />
            <span className="text-foreground">{formatCost(totalCost)}</span>
          </div>
        )}
        {numTurns !== null && numTurns !== undefined && (
          <div className="flex items-center gap-1.5">
            <IconArrowRight className="h-4 w-4 text-muted-foreground" />
            <span className="text-foreground">{numTurns} turns</span>
          </div>
        )}
      </div>

      {/* Model usage breakdown */}
      {modelUsage && Object.keys(modelUsage).length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground uppercase tracking-wide">
            Model Usage
          </summary>
          <div className="mt-2 space-y-2">
            {Object.entries(modelUsage).map(([model, usage]) => {
              if (!usage.inputTokens && !usage.outputTokens) {
                return null;
              }
              return (
                <div
                  key={model}
                  className="flex items-center justify-between text-xs bg-background p-2 rounded"
                >
                  <span className="font-mono text-muted-foreground">
                    {model}
                  </span>
                  <div className="flex gap-3">
                    {usage.inputTokens !== null &&
                      usage.inputTokens !== undefined && (
                        <span>In: {usage.inputTokens.toLocaleString()}</span>
                      )}
                    {usage.outputTokens !== null &&
                      usage.outputTokens !== undefined && (
                        <span>Out: {usage.outputTokens.toLocaleString()}</span>
                      )}
                    {usage.costUSD !== null && usage.costUSD !== undefined && (
                      <span className="text-emerald-600 font-medium">
                        {formatCost(usage.costUSD)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* Result text */}
      {result && (
        <div className="text-sm text-foreground">
          <div className="font-medium mb-1">
            {isError ? "Error" : "Success"}
          </div>
          <div className="whitespace-pre-wrap">{result}</div>
        </div>
      )}
    </div>
  );
}

// ============ MAIN EVENT CARD ============

function EventHeader({
  event,
  label,
  sublabel,
}: {
  event: AgentEvent;
  label: string;
  sublabel?: string;
}) {
  const style = getEventStyle(event.eventType);
  const Icon = style.icon;

  return (
    <div className="flex items-center gap-2 text-sm">
      {/* Badge with icon inside */}
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${style.badgeColor}`}
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      {sublabel && (
        <span className="font-medium text-foreground">{sublabel}</span>
      )}
      <span className="text-muted-foreground ml-auto">
        {formatEventTime(event.createdAt)}
      </span>
    </div>
  );
}

export function EventCard({
  event,
  searchTerm,
  currentMatchIndex,
  matchStartIndex = 0,
}: EventCardProps) {
  const eventData = event.eventData as EventData;
  const style = getEventStyle(event.eventType);
  const localMatchOffset = matchStartIndex;

  // System event (init)
  if (event.eventType === "system") {
    const subtype = eventData.subtype;
    const Icon = style.icon;
    return (
      <div
        className={`rounded-lg border ${style.borderColor} ${style.bgColor} p-4`}
      >
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0 space-y-2">
            {/* Badge */}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium bg-sky-600/10 border border-sky-600 text-sky-600">
              <Icon className="h-4 w-4" />
              System
            </span>
            {/* Title */}
            <div className="font-medium text-sm text-foreground">
              {subtype === "init" ? "Initialize" : subtype}
            </div>
            {subtype === "init" && <SystemInitContent eventData={eventData} />}
            {subtype !== "init" && eventData.message?.content === null && (
              <CollapsibleJson data={eventData} label="Event Data" />
            )}
          </div>
          {/* Timestamp */}
          <span className="shrink-0 text-sm text-muted-foreground">
            {formatEventTime(event.createdAt)}
          </span>
        </div>
      </div>
    );
  }

  // Result event (final stats)
  if (event.eventType === "result") {
    const subtype = eventData.subtype;
    const isError = eventData.is_error === true || subtype === "error";
    const resultStyle = isError ? getEventStyle("tool_result_error") : style;
    return (
      <div
        className={`rounded-lg border ${resultStyle.borderColor} ${resultStyle.bgColor} p-4`}
      >
        <EventHeader event={event} label={isError ? "Failed" : "Result"} />
        <ResultEventContent eventData={eventData} />
      </div>
    );
  }

  // Assistant or User event - render message.content array
  const message = eventData.message;
  const contents = message?.content;
  const Icon = style.icon;
  const isAssistant = event.eventType === "assistant";

  // Badge colors based on event type
  const badgeClass = isAssistant
    ? "bg-yellow-600/10 border border-yellow-600 text-yellow-600"
    : "bg-pink-600/10 border border-pink-600 text-pink-600";

  if (!contents || !Array.isArray(contents) || contents.length === 0) {
    // Fallback: show raw data
    return (
      <div
        className={`rounded-lg border ${style.borderColor} ${style.bgColor} p-4`}
      >
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0 space-y-2">
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium ${badgeClass}`}
            >
              <Icon className="h-4 w-4" />
              {isAssistant ? "Assistant" : "User"}
            </span>
            <CollapsibleJson data={eventData} label="Event Data" />
          </div>
          <span className="shrink-0 text-sm text-muted-foreground">
            {formatEventTime(event.createdAt)}
          </span>
        </div>
      </div>
    );
  }

  // Render each content block
  return (
    <div
      className={`rounded-lg border ${style.borderColor} ${style.bgColor} p-4`}
    >
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-2">
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium ${badgeClass}`}
          >
            <Icon className="h-4 w-4" />
            {isAssistant ? "Assistant" : "User"}
          </span>

          {contents.map((content) => {
            const contentKey = `${event.sequenceNumber}-${content.type}-${(content as ToolUseContent).id ?? (content as ToolResultContent).tool_use_id ?? Math.random()}`;

            if (content.type === "text") {
              return (
                <div key={contentKey}>
                  <TextContentView
                    content={content as TextContent}
                    searchTerm={searchTerm}
                    currentMatchIndex={currentMatchIndex}
                    matchStartIndex={localMatchOffset}
                  />
                </div>
              );
            }

            if (content.type === "tool_use") {
              const toolContent = content as ToolUseContent;
              return (
                <div key={contentKey}>
                  <ToolUseContentView content={toolContent} />
                </div>
              );
            }

            if (content.type === "tool_result") {
              const resultContent = content as ToolResultContent;
              const isError = resultContent.is_error === true;
              if (isError) {
                return (
                  <div key={contentKey}>
                    <ToolResultContentView
                      content={resultContent}
                      toolMeta={eventData.tool_use_result ?? undefined}
                      searchTerm={searchTerm}
                      currentMatchIndex={currentMatchIndex}
                      matchStartIndex={localMatchOffset}
                    />
                  </div>
                );
              }
              return (
                <div key={contentKey}>
                  <ToolResultContentView
                    content={resultContent}
                    toolMeta={eventData.tool_use_result ?? undefined}
                    searchTerm={searchTerm}
                    currentMatchIndex={currentMatchIndex}
                    matchStartIndex={localMatchOffset}
                  />
                </div>
              );
            }

            // Unknown content type - show as JSON
            const unknownContent = content as Record<string, unknown>;
            return (
              <div key={contentKey} className="mt-2">
                <CollapsibleJson
                  data={unknownContent}
                  label={`Unknown: ${String(unknownContent.type ?? "content")}`}
                />
              </div>
            );
          })}
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatEventTime(event.createdAt)}
        </span>
      </div>
    </div>
  );
}
