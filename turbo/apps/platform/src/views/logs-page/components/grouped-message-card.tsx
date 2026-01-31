import {
  IconCheck,
  IconCircle,
  IconLoader,
  IconListCheck,
} from "@tabler/icons-react";
import MarkdownPreview from "@uiw/react-markdown-preview";
import type { GroupedMessage } from "../log-detail/utils.ts";
import { ToolSummary } from "./tool-summary.tsx";
import {
  SystemInitContent,
  ResultEventContent,
  formatEventTime,
  type EventData,
} from "./event-card.tsx";

interface GroupedMessageCardProps {
  message: GroupedMessage;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}

// Auto-collapse thresholds
const TEXT_COLLAPSE_CHARS = 500;
const TEXT_COLLAPSE_LINES = 8;

function shouldCollapseText(text: string): boolean {
  const lines = text.split("\n").length;
  return text.length > TEXT_COLLAPSE_CHARS || lines > TEXT_COLLAPSE_LINES;
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <MarkdownPreview
      source={text}
      className="!bg-transparent !text-foreground text-sm"
      style={{
        backgroundColor: "transparent",
        fontSize: "0.875rem",
        lineHeight: "1.5",
      }}
    />
  );
}

function CollapsibleMarkdown({ text }: { text: string }) {
  const shouldCollapse = shouldCollapseText(text);

  if (!shouldCollapse) {
    return <MarkdownContent text={text} />;
  }

  // Get first few lines for preview
  const lines = text.split("\n");
  const previewText = lines.slice(0, 3).join("\n") + "...";

  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <div className="group-open:hidden">
          <MarkdownContent text={previewText} />
          <span className="text-xs text-blue-600 hover:underline">
            Show more
          </span>
        </div>
      </summary>
      <div>
        <MarkdownContent text={text} />
        <button
          type="button"
          className="mt-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            const details = e.currentTarget.closest("details");
            if (details) {
              details.open = false;
            }
          }}
        >
          Show less
        </button>
      </div>
    </details>
  );
}

export function GroupedMessageCard({
  message,
  searchTerm,
  currentMatchIndex,
  matchStartIndex = 0,
}: GroupedMessageCardProps) {
  const eventData = message.eventData as EventData;

  // System event
  if (message.type === "system") {
    return <SystemMessageCard message={message} eventData={eventData} />;
  }

  // Result event
  if (message.type === "result") {
    return <ResultMessageCard message={message} eventData={eventData} />;
  }

  // Todo card (standalone)
  if (message.type === "todo") {
    return <TodoCard message={message} />;
  }

  // Assistant message
  return (
    <AssistantMessageCard
      message={message}
      searchTerm={searchTerm}
      currentMatchIndex={currentMatchIndex}
      matchStartIndex={matchStartIndex}
    />
  );
}

function SystemMessageCard({
  message,
  eventData,
}: {
  message: GroupedMessage;
  eventData: EventData;
}) {
  const subtype = eventData.subtype;
  return (
    <div className="rounded-lg border border-sky-600/30 bg-sky-600/5 p-4">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="font-medium text-sm text-foreground">
            {subtype === "init" ? "Initialize" : subtype}
          </div>
          {subtype === "init" && <SystemInitContent eventData={eventData} />}
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatEventTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

function ResultMessageCard({
  message,
  eventData,
}: {
  message: GroupedMessage;
  eventData: EventData;
}) {
  const subtype = eventData.subtype;
  const isError = eventData.is_error === true || subtype === "error";
  const borderColor = isError ? "border-red-500/30" : "border-lime-600/30";
  const bgColor = isError ? "bg-red-500/5" : "bg-lime-600/5";
  const textColor = isError ? "text-red-600" : "text-lime-600";

  return (
    <div className={`rounded-lg border ${borderColor} ${bgColor} p-4`}>
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-2">
          <div className={`font-medium text-sm ${textColor}`}>
            {isError ? "Failed" : "Result"}
          </div>
          <ResultEventContent eventData={eventData} />
        </div>
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatEventTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

function getTodoStatusIcon(status: string) {
  switch (status) {
    case "completed": {
      return <IconCheck className="h-4 w-4 text-lime-600" />;
    }
    case "in_progress": {
      return <IconLoader className="h-4 w-4 text-yellow-600" />;
    }
    default: {
      return <IconCircle className="h-4 w-4 text-muted-foreground" />;
    }
  }
}

/**
 * Standalone todo card that shows current task status.
 * Displays in-progress task prominently with expandable full list.
 */
function TodoCard({ message }: { message: GroupedMessage }) {
  const todoItems = message.todoState ?? [];
  const inProgressTask = todoItems.find((t) => t.status === "in_progress");
  const completedCount = todoItems.filter(
    (t) => t.status === "completed",
  ).length;
  const totalCount = todoItems.length;

  return (
    <div className="rounded-lg border border-purple-600/30 bg-purple-600/5 p-4">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-3">
          {/* Header with current task */}
          <div className="flex items-center gap-2">
            <IconListCheck className="h-4 w-4 text-purple-600 shrink-0" />
            {inProgressTask ? (
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <IconLoader className="h-3.5 w-3.5 text-yellow-600 shrink-0" />
                <span className="text-sm text-foreground truncate">
                  {inProgressTask.content}
                </span>
              </div>
            ) : (
              <span className="text-sm text-muted-foreground">
                All tasks completed
              </span>
            )}
            <span className="text-xs text-muted-foreground shrink-0">
              {completedCount}/{totalCount}
            </span>
          </div>

          {/* Expandable full list */}
          <details className="group">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              View all tasks
            </summary>
            <div className="mt-2 space-y-1.5">
              {todoItems.map((item, index) => (
                <div
                  key={`${item.content}-${index}`}
                  className="flex items-start gap-2 text-sm"
                >
                  <span className="mt-0.5 shrink-0">
                    {getTodoStatusIcon(item.status)}
                  </span>
                  <span
                    className={
                      item.status === "completed"
                        ? "text-muted-foreground line-through"
                        : "text-foreground"
                    }
                  >
                    {item.content}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </div>

        {/* Timestamp */}
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatEventTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

function AssistantMessageCard({
  message,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
}: {
  message: GroupedMessage;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}) {
  const { textBefore, textAfter, toolOperations } = message;
  const hasTools = toolOperations && toolOperations.length > 0;

  return (
    <div className="rounded-lg border border-yellow-600/30 bg-yellow-600/5 p-4">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-3">
          {/* Text before tools */}
          {textBefore && <CollapsibleMarkdown text={textBefore} />}

          {/* Tool operations */}
          {hasTools && (
            <div className="space-y-1">
              {toolOperations.map((op) => (
                <ToolSummary
                  key={op.toolUseId}
                  operation={op}
                  searchTerm={searchTerm}
                  currentMatchIndex={currentMatchIndex}
                  matchStartIndex={matchStartIndex}
                />
              ))}
            </div>
          )}

          {/* Text after tools */}
          {textAfter && <CollapsibleMarkdown text={textAfter} />}
        </div>

        {/* Timestamp */}
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatEventTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}
