import { getEventStyle } from "../constants/event-styles.ts";
import { CollapsibleJson } from "./collapsible-json.tsx";
import type { AgentEvent } from "../../../signals/logs-page/types.ts";
import { IconFile, IconCode, IconTerminal } from "@tabler/icons-react";

interface EventCardProps {
  event: AgentEvent;
  searchTerm?: string;
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

function EventHeader({
  event,
  style,
}: {
  event: AgentEvent;
  style: ReturnType<typeof getEventStyle>;
}) {
  const Icon = style.icon;
  const eventData = event.eventData as Record<string, unknown>;

  // Get tool name for tool_use events
  const toolName =
    event.eventType === "tool_use"
      ? String(eventData.name ?? eventData.tool ?? "")
      : "";

  return (
    <div className="flex items-center gap-2 text-sm">
      <Icon className={`h-4 w-4 ${style.textColor}`} />
      <span
        className={`px-2 py-0.5 rounded-full text-xs font-medium ${style.badgeColor}`}
      >
        {style.label}
      </span>
      {toolName && (
        <span className="font-medium text-foreground">{toolName}</span>
      )}
      <span className="text-muted-foreground ml-auto">
        {formatEventTime(event.createdAt)}
      </span>
    </div>
  );
}

function TextEventContent({
  event,
  searchTerm,
}: {
  event: AgentEvent;
  searchTerm?: string;
}) {
  const eventData = event.eventData as Record<string, unknown>;
  const content = String(eventData.content ?? "");

  return (
    <div className="mt-2 text-sm text-foreground whitespace-pre-wrap">
      {searchTerm ? highlightText(content, searchTerm) : content}
    </div>
  );
}

/** Render a single parameter value in a user-friendly way */
function ParameterValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic">null</span>;
  }

  if (typeof value === "boolean") {
    return (
      <span
        className={
          value
            ? "text-green-600 dark:text-green-400"
            : "text-red-600 dark:text-red-400"
        }
      >
        {value ? "true" : "false"}
      </span>
    );
  }

  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  }

  if (typeof value === "string") {
    // Check if it looks like a file path
    if (value.startsWith("/") || value.includes("/")) {
      return (
        <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded inline-flex items-center gap-1">
          <IconFile className="h-3 w-3 text-muted-foreground" />
          {value}
        </span>
      );
    }

    // Check if it's a multi-line string (likely code or content)
    if (value.includes("\n")) {
      const lines = value.split("\n");
      if (lines.length > 5) {
        return (
          <details className="group">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground text-xs">
              {lines.length} lines
            </summary>
            <pre className="mt-1 text-xs bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
              {value}
            </pre>
          </details>
        );
      }
      return (
        <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto whitespace-pre-wrap">
          {value}
        </pre>
      );
    }

    // Regular string
    if (value.length > 100) {
      return (
        <details className="group inline">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            &quot;{value.slice(0, 50)}...&quot;
          </summary>
          <div className="mt-1 text-xs bg-muted/50 p-2 rounded">{value}</div>
        </details>
      );
    }

    return (
      <span className="text-green-700 dark:text-green-400">
        &quot;{value}&quot;
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">[]</span>;
    }
    return <CollapsibleJson data={value} />;
  }

  if (typeof value === "object") {
    return <CollapsibleJson data={value} />;
  }

  return <span>{String(value)}</span>;
}

/** Render tool input parameters as labeled key-value pairs */
function ToolParameters({ input }: { input: unknown }) {
  if (input === null || input === undefined) {
    return null;
  }

  // If input is not an object, show it directly
  if (typeof input !== "object" || Array.isArray(input)) {
    return (
      <div className="mt-2">
        <CollapsibleJson data={input} label="Input" />
      </div>
    );
  }

  const params = input as Record<string, unknown>;
  const entries = Object.entries(params);

  if (entries.length === 0) {
    return null;
  }

  // Special case: if there's only a file_path or path, show it prominently
  if (entries.length === 1 && (params.file_path || params.path)) {
    const path = String(params.file_path ?? params.path);
    return (
      <div className="mt-2 flex items-center gap-2 text-sm">
        <IconFile className="h-4 w-4 text-muted-foreground shrink-0" />
        <code className="font-mono text-xs bg-muted px-2 py-1 rounded">
          {path}
        </code>
      </div>
    );
  }

  // Special case: if there's a command, show it like a terminal
  if (params.command) {
    return (
      <div className="mt-2 space-y-2">
        <div className="flex items-start gap-2 text-sm">
          <IconTerminal className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
          <code className="font-mono text-xs bg-muted px-2 py-1 rounded block w-full overflow-x-auto">
            {String(params.command)}
          </code>
        </div>
        {entries.length > 1 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Other parameters ({entries.length - 1})
            </summary>
            <div className="mt-1 space-y-1 pl-6">
              {entries
                .filter(([key]) => key !== "command")
                .map(([key, val]) => (
                  <div key={key} className="flex items-start gap-2">
                    <span className="text-muted-foreground shrink-0">
                      {key}:
                    </span>
                    <ParameterValue value={val} />
                  </div>
                ))}
            </div>
          </details>
        )}
      </div>
    );
  }

  // General case: show all parameters
  return (
    <div className="mt-2 space-y-1.5 text-sm">
      {entries.map(([key, val]) => (
        <div key={key} className="flex items-start gap-2">
          <span className="text-muted-foreground shrink-0 min-w-[80px]">
            {key}:
          </span>
          <div className="min-w-0 flex-1">
            <ParameterValue value={val} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ToolUseEventContent({ event }: { event: AgentEvent }) {
  const eventData = event.eventData as Record<string, unknown>;

  return <ToolParameters input={eventData.input} />;
}

/** Check if text looks like code */
function looksLikeCode(text: string): boolean {
  return (
    text.includes("function ") ||
    text.includes("const ") ||
    text.includes("import ") ||
    text.includes("class ") ||
    /^\s{2,}/m.test(text)
  );
}

/** Render error content for tool results */
function ToolResultError({
  content,
  searchTerm,
}: {
  content: unknown;
  searchTerm?: string;
}) {
  const errorText =
    typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return (
    <div className="mt-2 p-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded text-sm text-red-700 dark:text-red-300">
      <div className="font-medium mb-1">Error</div>
      <pre className="whitespace-pre-wrap overflow-x-auto text-xs">
        {searchTerm ? highlightText(errorText, searchTerm) : errorText}
      </pre>
    </div>
  );
}

/** Render string content for tool results */
function ToolResultString({
  content,
  searchTerm,
}: {
  content: string;
  searchTerm?: string;
}) {
  const lines = content.split("\n");
  const isLong = lines.length > 8 || content.length > 400;
  const isCode = looksLikeCode(content);
  const codeStyle = isCode
    ? "bg-gray-900 text-gray-100 dark:bg-gray-950"
    : "bg-muted/30";

  if (isLong) {
    return (
      <details className="mt-2 group" open={lines.length <= 15}>
        <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground flex items-center gap-2">
          <IconCode className="h-3 w-3" />
          <span>Output ({lines.length} lines)</span>
        </summary>
        <pre
          className={`mt-2 text-xs whitespace-pre-wrap overflow-x-auto p-3 rounded max-h-80 overflow-y-auto ${codeStyle}`}
        >
          {searchTerm ? highlightText(content, searchTerm) : content}
        </pre>
      </details>
    );
  }

  return (
    <pre
      className={`mt-2 text-xs whitespace-pre-wrap overflow-x-auto p-2 rounded ${codeStyle}`}
    >
      {searchTerm ? highlightText(content, searchTerm) : content}
    </pre>
  );
}

/** Render array content blocks for tool results */
function ToolResultArray({
  content,
  searchTerm,
}: {
  content: unknown[];
  searchTerm?: string;
}) {
  return (
    <div className="mt-2 space-y-2">
      {content.map((item) => {
        if (typeof item === "object" && item !== null) {
          const obj = item as Record<string, unknown>;
          if (obj.type === "text" && typeof obj.text === "string") {
            const textKey = `text-${String(obj.text).slice(0, 50)}`;
            return (
              <div key={textKey} className="text-sm whitespace-pre-wrap">
                {searchTerm ? highlightText(obj.text, searchTerm) : obj.text}
              </div>
            );
          }
        }
        const itemKey = `item-${JSON.stringify(item).slice(0, 50)}`;
        return (
          <div key={itemKey}>
            <CollapsibleJson data={item} />
          </div>
        );
      })}
    </div>
  );
}

function ToolResultEventContent({
  event,
  searchTerm,
}: {
  event: AgentEvent;
  searchTerm?: string;
}) {
  const eventData = event.eventData as Record<string, unknown>;
  const content = eventData.content;
  const isError = eventData.is_error === true || eventData.isError === true;

  if (isError) {
    return <ToolResultError content={content} searchTerm={searchTerm} />;
  }

  if (typeof content === "string") {
    if (content.trim() === "") {
      return (
        <div className="mt-2 text-sm text-muted-foreground italic">
          (empty output)
        </div>
      );
    }
    return <ToolResultString content={content} searchTerm={searchTerm} />;
  }

  if (Array.isArray(content)) {
    return <ToolResultArray content={content} searchTerm={searchTerm} />;
  }

  if (content !== null && content !== undefined) {
    return (
      <div className="mt-2">
        <CollapsibleJson data={content} label="Output" />
      </div>
    );
  }

  return (
    <div className="mt-2 text-sm text-muted-foreground italic">(no output)</div>
  );
}

function ThinkingEventContent({
  event,
  searchTerm,
}: {
  event: AgentEvent;
  searchTerm?: string;
}) {
  const eventData = event.eventData as Record<string, unknown>;
  const content = String(eventData.content ?? "");

  return (
    <details className="mt-2 group">
      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground italic">
        Thinking...
      </summary>
      <div className="mt-2 text-sm text-muted-foreground italic whitespace-pre-wrap">
        {searchTerm ? highlightText(content, searchTerm) : content}
      </div>
    </details>
  );
}

function InitEventContent({ event }: { event: AgentEvent }) {
  const eventData = event.eventData as Record<string, unknown>;
  const tools = Array.isArray(eventData.tools) ? eventData.tools : [];

  return (
    <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      {eventData.model !== null && eventData.model !== undefined && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">
            Model
          </span>
          <span className="font-medium text-foreground">
            {String(eventData.model)}
          </span>
        </div>
      )}
      {eventData.session !== null && eventData.session !== undefined && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">
            Session
          </span>
          <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded truncate max-w-[200px]">
            {String(eventData.session)}
          </code>
        </div>
      )}
      {tools.length > 0 && (
        <div className="col-span-2 mt-1">
          <details className="group">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground uppercase tracking-wide">
              {tools.length} Tools Available
            </summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(tools as unknown[]).map((tool) => (
                <span
                  key={String(tool)}
                  className="text-xs bg-muted/70 text-muted-foreground px-2 py-0.5 rounded-full"
                >
                  {String(tool)}
                </span>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function GenericEventContent({ event }: { event: AgentEvent }) {
  return (
    <div className="mt-2">
      <CollapsibleJson data={event.eventData} />
    </div>
  );
}

export function EventCard({ event, searchTerm }: EventCardProps) {
  const style = getEventStyle(event.eventType);

  const renderContent = () => {
    switch (event.eventType) {
      case "text": {
        return <TextEventContent event={event} searchTerm={searchTerm} />;
      }
      case "tool_use": {
        return <ToolUseEventContent event={event} />;
      }
      case "tool_result": {
        return <ToolResultEventContent event={event} searchTerm={searchTerm} />;
      }
      case "thinking": {
        return <ThinkingEventContent event={event} searchTerm={searchTerm} />;
      }
      case "init": {
        return <InitEventContent event={event} />;
      }
      default: {
        return <GenericEventContent event={event} />;
      }
    }
  };

  return (
    <div
      className={`rounded-lg border-l-4 ${style.borderColor} ${style.bgColor} p-3`}
    >
      <EventHeader event={event} style={style} />
      {renderContent()}
    </div>
  );
}
