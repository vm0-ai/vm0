import { getEventStyle } from "../constants/event-styles.ts";
import { CollapsibleJson } from "./collapsible-json.tsx";
import type { AgentEvent } from "../../../signals/logs-page/types.ts";

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

function ToolUseEventContent({ event }: { event: AgentEvent }) {
  const eventData = event.eventData as Record<string, unknown>;

  return (
    <div className="mt-2">
      {eventData.input !== undefined && (
        <CollapsibleJson data={eventData.input} label="Input" />
      )}
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

  if (typeof content === "string") {
    // Text content - show with optional highlighting
    const lines = content.split("\n");
    const isLong = lines.length > 10 || content.length > 500;

    if (isLong) {
      return (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            Output ({lines.length} lines)
          </summary>
          <pre className="mt-2 text-sm whitespace-pre-wrap overflow-x-auto bg-muted/30 p-3 rounded max-h-96 overflow-y-auto">
            {searchTerm ? highlightText(content, searchTerm) : content}
          </pre>
        </details>
      );
    }

    return (
      <pre className="mt-2 text-sm whitespace-pre-wrap overflow-x-auto">
        {searchTerm ? highlightText(content, searchTerm) : content}
      </pre>
    );
  }

  // JSON content
  return (
    <div className="mt-2">
      <CollapsibleJson data={content} label="Output" />
    </div>
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

  return (
    <div className="mt-2 space-y-1 text-sm">
      {eventData.session !== null && eventData.session !== undefined && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Session:</span>
          <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(eventData.session)}
          </code>
        </div>
      )}
      {eventData.model !== null && eventData.model !== undefined && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Model:</span>
          <span className="font-medium">{String(eventData.model)}</span>
        </div>
      )}
      {Array.isArray(eventData.tools) && eventData.tools.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Tools ({eventData.tools.length})
          </summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {(eventData.tools as unknown[]).map((tool) => (
              <span
                key={String(tool)}
                className="text-xs bg-muted px-1.5 py-0.5 rounded"
              >
                {String(tool)}
              </span>
            ))}
          </div>
        </details>
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
