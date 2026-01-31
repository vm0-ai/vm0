import {
  IconUser,
  IconSettings,
  IconCheck,
  IconX,
  IconCircle,
  IconLoader,
  IconListCheck,
} from "@tabler/icons-react";
import { highlightText } from "../utils/highlight-text.tsx";
import type { GroupedMessage, TodoItem } from "../log-detail/utils.ts";
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
const TEXT_COLLAPSE_CHARS = 200;
const TEXT_COLLAPSE_LINES = 3;

function shouldCollapseText(text: string): boolean {
  const lines = text.split("\n").length;
  return text.length > TEXT_COLLAPSE_CHARS || lines > TEXT_COLLAPSE_LINES;
}

function checkTextSearchMatch(
  text: string,
  searchTerm: string | undefined,
): boolean {
  if (!searchTerm || !searchTerm.trim()) {
    return false;
  }
  return text.toLowerCase().includes(searchTerm.toLowerCase());
}

function CollapsibleText({
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
  const shouldCollapse = shouldCollapseText(text);
  const hasSearchMatch = checkTextSearchMatch(text, searchTerm);
  const defaultOpen = !shouldCollapse || hasSearchMatch;

  const contentElement = searchTerm
    ? highlightText(text, {
        searchTerm,
        currentMatchIndex,
        matchStartIndex,
      }).element
    : text;

  if (!shouldCollapse) {
    return (
      <div className="text-sm text-foreground whitespace-pre-wrap">
        {contentElement}
      </div>
    );
  }

  // Collapsed view with details/summary
  const truncatedText = text.slice(0, 150) + "...";
  const truncatedElement = searchTerm
    ? highlightText(truncatedText, {
        searchTerm,
        currentMatchIndex,
        matchStartIndex,
      }).element
    : truncatedText;

  return (
    <details className="group" open={defaultOpen}>
      <summary className="cursor-pointer list-none">
        <span className="text-sm text-foreground whitespace-pre-wrap group-open:hidden">
          {truncatedElement}
        </span>
        <span className="ml-1 text-xs text-blue-600 hover:underline group-open:hidden">
          Show more
        </span>
      </summary>
      <div className="text-sm text-foreground whitespace-pre-wrap">
        {contentElement}
        <button
          type="button"
          className="ml-2 text-xs text-muted-foreground hover:text-foreground"
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
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium bg-sky-600/10 border border-sky-600 text-sky-600">
            <IconSettings className="h-4 w-4" />
            System
          </span>
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
  const badgeColor = isError
    ? "bg-red-500/10 border-red-500 text-red-500"
    : "bg-lime-600/10 border-lime-600 text-lime-600";
  const StatusIcon = isError ? IconX : IconCheck;

  return (
    <div className={`rounded-lg border ${borderColor} ${bgColor} p-4`}>
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-2">
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium border ${badgeColor}`}
          >
            <StatusIcon className="h-4 w-4" />
            {isError ? "Failed" : "Result"}
          </span>
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

function TodoSummaryCard({
  todoItems,
  createdAt,
}: {
  todoItems: TodoItem[];
  createdAt: string;
}) {
  return (
    <div className="rounded-lg border border-purple-600/30 bg-purple-600/5 p-4">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-3">
          {/* Badge */}
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium bg-purple-600/10 border border-purple-600 text-purple-600">
            <IconListCheck className="h-4 w-4" />
            Tasks
          </span>

          {/* Todo list */}
          <div className="space-y-1.5">
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
        </div>

        {/* Timestamp */}
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatEventTime(createdAt)}
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
  const { textBefore, textAfter, toolOperations, todoSummary } = message;
  const hasTools = toolOperations && toolOperations.length > 0;

  // If this is a todo summary card (no text, no tools, just todoSummary)
  if (todoSummary && todoSummary.length > 0 && !textBefore && !hasTools) {
    return (
      <TodoSummaryCard todoItems={todoSummary} createdAt={message.createdAt} />
    );
  }

  return (
    <div className="rounded-lg border border-yellow-600/30 bg-yellow-600/5 p-4">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-3">
          {/* Badge */}
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-xs font-medium bg-yellow-600/10 border border-yellow-600 text-yellow-600">
            <IconUser className="h-4 w-4" />
            Claude
          </span>

          {/* Text before tools */}
          {textBefore && (
            <CollapsibleText
              text={textBefore}
              searchTerm={searchTerm}
              currentMatchIndex={currentMatchIndex}
              matchStartIndex={matchStartIndex}
            />
          )}

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
          {textAfter && (
            <CollapsibleText
              text={textAfter}
              searchTerm={searchTerm}
              currentMatchIndex={currentMatchIndex}
              matchStartIndex={matchStartIndex}
            />
          )}
        </div>

        {/* Timestamp */}
        <span className="shrink-0 text-sm text-muted-foreground">
          {formatEventTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}
