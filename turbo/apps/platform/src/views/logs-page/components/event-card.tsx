import { getEventStyle } from "../constants/event-styles.ts";
import { CollapsibleJson } from "./collapsible-json.tsx";
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
  IconLoader2,
  IconCircle,
  IconListCheck,
} from "@tabler/icons-react";

interface EventCardProps {
  event: AgentEvent;
  searchTerm?: string;
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

function highlightText(
  text: string,
  searchTerm: string,
): React.ReactNode | string {
  if (!searchTerm.trim()) {
    return text;
  }

  const escapedTerm = searchTerm.replace(
    /[.*+?^${}()|[\]\\]/g,
    String.raw`\$&`,
  );
  const parts = text.split(new RegExp(`(${escapedTerm})`, "gi"));

  return parts.map((part) =>
    part.toLowerCase() === searchTerm.toLowerCase() ? (
      <mark
        key={`${part}-${Math.random()}`}
        className="bg-yellow-200 text-yellow-900 rounded px-0.5"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
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

function SystemInitContent({ eventData }: { eventData: EventData }) {
  const tools = eventData.tools ?? [];
  const agents = eventData.agents ?? [];
  const slashCommands = eventData.slash_commands ?? [];

  return (
    <div className="mt-3 space-y-3">
      {/* Model & Session */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        {eventData.model && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              Model
            </span>
            <span className="font-medium text-foreground">
              {eventData.model}
            </span>
          </div>
        )}
        {eventData.session_id && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase tracking-wide">
              Session
            </span>
            <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded truncate max-w-[200px]">
              {eventData.session_id}
            </code>
          </div>
        )}
      </div>

      {/* Tools */}
      {tools.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground uppercase tracking-wide">
            {tools.length} Tools Available
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tools.map((tool) => (
              <span
                key={tool}
                className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
              >
                {tool}
              </span>
            ))}
          </div>
        </details>
      )}

      {/* Agents */}
      {agents.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground uppercase tracking-wide">
            {agents.length} Agents
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {agents.map((agent) => (
              <span
                key={agent}
                className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full"
              >
                {agent}
              </span>
            ))}
          </div>
        </details>
      )}

      {/* Slash Commands */}
      {slashCommands.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground uppercase tracking-wide">
            {slashCommands.length} Slash Commands
          </summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {slashCommands.map((cmd) => (
              <span
                key={cmd}
                className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-mono"
              >
                /{cmd}
              </span>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ============ TEXT CONTENT ============

function TextContentView({
  content,
  searchTerm,
}: {
  content: TextContent;
  searchTerm?: string;
}) {
  const text = content.text;
  if (!text) {
    return null;
  }

  return (
    <div className="text-sm text-foreground whitespace-pre-wrap">
      {searchTerm ? highlightText(text, searchTerm) : text}
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

  return (
    <div className="space-y-2">
      {/* Tool header */}
      <div className="flex items-center gap-2">
        {ToolIcon && <ToolIcon className="h-4 w-4 text-muted-foreground" />}
        <span className="font-medium text-foreground">{toolName}</span>
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
              className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline break-all"
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
      <div className="flex items-start gap-2 text-sm">
        <IconTerminal className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <code className="font-mono text-xs bg-foreground/90 text-background px-2 py-1 rounded block w-full overflow-x-auto whitespace-pre-wrap">
          {command}
        </code>
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
        <code className="font-mono text-xs bg-muted px-2 py-1 rounded">
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
        <div className="space-y-1.5 text-sm">
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
                  ? IconLoader2
                  : IconCircle;
            const statusColor =
              status === "completed"
                ? "text-emerald-600 dark:text-emerald-400"
                : status === "in_progress"
                  ? "text-blue-600 dark:text-blue-400"
                  : "text-muted-foreground";
            return (
              <div
                key={`${status}-${content}`}
                className="flex items-start gap-2"
              >
                <StatusIcon
                  className={`h-4 w-4 shrink-0 mt-0.5 ${statusColor}`}
                />
                <span
                  className={
                    status === "completed"
                      ? "text-muted-foreground line-through"
                      : "text-foreground"
                  }
                >
                  {content}
                </span>
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
            ? "text-emerald-600 dark:text-emerald-400 text-xs font-medium"
            : "text-muted-foreground text-xs"
        }
      >
        {value ? "true" : "false"}
      </span>
    );
  }

  if (typeof value === "number") {
    return (
      <span className="text-violet-600 dark:text-violet-400 text-xs font-medium">
        {value}
      </span>
    );
  }

  if (typeof value === "string") {
    if (value.length > 100) {
      return (
        <details className="group inline">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground text-xs">
            &quot;{value.slice(0, 50)}...&quot;
          </summary>
          <div className="mt-1 text-xs bg-muted/50 p-2 rounded whitespace-pre-wrap">
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
}: {
  content: ToolResultContent;
  toolMeta?: ToolResultMeta;
  searchTerm?: string;
}) {
  const isError = content.is_error === true;
  const resultText = content.content;

  // Error display
  if (isError) {
    return (
      <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded text-sm">
        <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-medium mb-2">
          <IconAlertCircle className="h-4 w-4" />
          Error
        </div>
        <pre className="whitespace-pre-wrap overflow-x-auto text-xs text-red-700 dark:text-red-400">
          {searchTerm ? highlightText(resultText, searchTerm) : resultText}
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
              className="bg-muted px-2 py-0.5 rounded text-muted-foreground"
            >
              {item.label}:{" "}
              <span className="text-foreground">{item.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Result content */}
      <ResultContent text={resultText} searchTerm={searchTerm} />
    </div>
  );
}

function ResultContent({
  text,
  searchTerm,
}: {
  text: string;
  searchTerm?: string;
}) {
  if (!text || text.trim() === "") {
    return (
      <div className="text-sm text-muted-foreground italic">(empty output)</div>
    );
  }

  const lines = text.split("\n");
  const isLong = lines.length > 10 || text.length > 500;

  // Check if it looks like code
  const looksLikeCode =
    text.includes("function ") ||
    text.includes("const ") ||
    text.includes("import ") ||
    text.includes("class ") ||
    text.includes("```") ||
    /^\s{2,}/m.test(text);

  const preClass = looksLikeCode
    ? "bg-foreground/90 text-background"
    : "bg-muted/30 text-foreground";

  if (isLong) {
    return (
      <details className="group" open={lines.length <= 15}>
        <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
          Output ({lines.length} lines)
        </summary>
        <pre
          className={`mt-2 text-xs whitespace-pre-wrap overflow-x-auto p-3 rounded max-h-80 overflow-y-auto ${preClass}`}
        >
          {searchTerm ? highlightText(text, searchTerm) : text}
        </pre>
      </details>
    );
  }

  return (
    <pre
      className={`text-xs whitespace-pre-wrap overflow-x-auto p-2 rounded ${preClass}`}
    >
      {searchTerm ? highlightText(text, searchTerm) : text}
    </pre>
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
                  className="flex items-center justify-between text-xs bg-muted/50 p-2 rounded"
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
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
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
        <div
          className={`p-3 rounded text-sm ${isError ? "bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400" : "bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400"}`}
        >
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
      <Icon className={`h-4 w-4 ${style.textColor}`} />
      <span
        className={`px-2 py-0.5 rounded-full text-xs font-medium ${style.badgeColor}`}
      >
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

export function EventCard({ event, searchTerm }: EventCardProps) {
  const eventData = event.eventData as EventData;
  const style = getEventStyle(event.eventType);

  // System event (init)
  if (event.eventType === "system") {
    const subtype = eventData.subtype;
    return (
      <div
        className={`rounded-lg border-l-4 ${style.borderColor} ${style.bgColor} p-3`}
      >
        <EventHeader
          event={event}
          label="System"
          sublabel={subtype === "init" ? "Initialize" : subtype}
        />
        {subtype === "init" && <SystemInitContent eventData={eventData} />}
        {subtype !== "init" && eventData.message?.content === null && (
          <div className="mt-2">
            <CollapsibleJson data={eventData} label="Event Data" />
          </div>
        )}
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
        className={`rounded-lg border-l-4 ${resultStyle.borderColor} ${resultStyle.bgColor} p-3`}
      >
        <EventHeader event={event} label={isError ? "Failed" : "Completed"} />
        <ResultEventContent eventData={eventData} />
      </div>
    );
  }

  // Assistant or User event - render message.content array
  const message = eventData.message;
  const contents = message?.content;

  if (!contents || !Array.isArray(contents) || contents.length === 0) {
    // Fallback: show raw data
    return (
      <div
        className={`rounded-lg border-l-4 ${style.borderColor} ${style.bgColor} p-3`}
      >
        <EventHeader event={event} label={event.eventType} />
        <div className="mt-2">
          <CollapsibleJson data={eventData} label="Event Data" />
        </div>
      </div>
    );
  }

  // Render each content block
  return (
    <div
      className={`rounded-lg border-l-4 ${style.borderColor} ${style.bgColor} p-3 space-y-3`}
    >
      <EventHeader
        event={event}
        label={event.eventType === "assistant" ? "Assistant" : "User"}
      />

      {contents.map((content) => {
        const contentKey = `${event.sequenceNumber}-${content.type}-${(content as ToolUseContent).id ?? (content as ToolResultContent).tool_use_id ?? Math.random()}`;

        if (content.type === "text") {
          return (
            <div key={contentKey}>
              <TextContentView
                content={content as TextContent}
                searchTerm={searchTerm}
              />
            </div>
          );
        }

        if (content.type === "tool_use") {
          const toolContent = content as ToolUseContent;
          const toolStyle = getEventStyle("tool_use");
          return (
            <div
              key={contentKey}
              className={`rounded border-l-2 ${toolStyle.borderColor} ${toolStyle.bgColor} p-2`}
            >
              <ToolUseContentView content={toolContent} />
            </div>
          );
        }

        if (content.type === "tool_result") {
          const resultContent = content as ToolResultContent;
          const isError = resultContent.is_error === true;
          const resultStyle = getEventStyle(
            isError ? "tool_result_error" : "tool_result",
          );
          return (
            <div
              key={contentKey}
              className={`rounded border-l-2 ${resultStyle.borderColor} ${resultStyle.bgColor} p-2`}
            >
              <ToolResultContentView
                content={resultContent}
                toolMeta={eventData.tool_use_result ?? undefined}
                searchTerm={searchTerm}
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
  );
}
