import { IconCheck, IconCircle, IconLoader } from "@tabler/icons-react";
import MarkdownPreview from "@uiw/react-markdown-preview";
import type { GroupedMessage } from "../log-detail/utils.ts";
import { ToolSummary } from "./tool-summary.tsx";
import {
  SystemInitContent,
  ResultEventContent,
  formatEventTime,
  type EventData,
} from "./event-card.tsx";
import { highlightText } from "../utils/highlight-text.tsx";
import { StatusDot } from "./status-dot.tsx";

interface GroupedMessageCardProps {
  message: GroupedMessage;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
}

// Layout constants
const MESSAGE_SPACING = "py-2";

// Auto-collapse thresholds
const TEXT_COLLAPSE_CHARS = 500;
const TEXT_COLLAPSE_LINES = 8;

function shouldCollapseText(text: string): boolean {
  const lines = text.split("\n").length;
  return text.length > TEXT_COLLAPSE_CHARS || lines > TEXT_COLLAPSE_LINES;
}

function textContainsSearch(text: string, searchTerm: string): boolean {
  if (!searchTerm.trim()) {
    return false;
  }
  return text.toLowerCase().includes(searchTerm.toLowerCase());
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
        fontFamily: "var(--font-family-sans)",
      }}
    />
  );
}

function HighlightedMarkdownContent({
  text,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
}: {
  text: string;
  searchTerm: string;
  currentMatchIndex: number;
  matchStartIndex: number;
}) {
  // For markdown, we highlight the plain text but render as markdown
  // This is a simplified approach - highlighting inside markdown is complex
  const hasMatch = textContainsSearch(text, searchTerm);

  if (!hasMatch) {
    return <MarkdownContent text={text} />;
  }

  // When there's a match, show highlighted plain text instead of markdown
  // This ensures the highlighting is visible
  const result = highlightText(text, {
    searchTerm,
    currentMatchIndex,
    matchStartIndex,
  });

  return (
    <div className="text-sm whitespace-pre-wrap break-words">
      {result.element}
    </div>
  );
}

function CollapsibleMarkdown({
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
  const hasSearch = searchTerm && searchTerm.trim().length > 0;
  const hasMatch = hasSearch && textContainsSearch(text, searchTerm);

  // If not collapsible or has search match, show full content
  if (!shouldCollapse || hasMatch) {
    if (hasSearch) {
      return (
        <HighlightedMarkdownContent
          text={text}
          searchTerm={searchTerm}
          currentMatchIndex={currentMatchIndex ?? 0}
          matchStartIndex={matchStartIndex ?? 0}
        />
      );
    }
    return <MarkdownContent text={text} />;
  }

  // Calculate line count for display
  const lines = text.split("\n");
  const lineCount = lines.length;
  const previewLines = lines.slice(0, 3);
  const previewText = previewLines.join("\n");
  const remainingLines = lineCount - 3;

  return (
    <details className="group">
      <summary className="cursor-pointer list-none">
        <span className="group-open:hidden">
          <MarkdownContent text={previewText} />
          <span className="text-xs text-muted-foreground hover:text-foreground">
            ... +{remainingLines} lines
          </span>
        </span>
        <span className="hidden group-open:block">
          <MarkdownContent text={text} />
          <span className="text-xs text-muted-foreground hover:text-foreground">
            ... -{remainingLines} lines
          </span>
        </span>
      </summary>
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
    return <TodoCard message={message} searchTerm={searchTerm} />;
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
  const timestamp = formatEventTime(message.createdAt);
  return (
    <div className={MESSAGE_SPACING}>
      <div className="flex gap-2 items-center">
        <StatusDot variant="neutral" />
        <span className="font-semibold text-sm text-foreground">
          {subtype === "init" ? "Initialize" : subtype}
        </span>
        <span className="flex-1">
          {subtype === "init" && <SystemInitContent eventData={eventData} />}
        </span>
        <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
          {timestamp}
        </span>
      </div>
      <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
        {timestamp}
      </div>
    </div>
  );
}

function ResultMessageCard({
  eventData,
}: {
  message: GroupedMessage;
  eventData: EventData;
}) {
  const subtype = eventData.subtype;
  const isError = eventData.is_error === true || subtype === "error";
  const borderColor = isError ? "border-red-500/30" : "border-lime-500/30";
  const bgColor = isError ? "bg-red-500/5" : "bg-lime-500/5";

  return (
    <div className={MESSAGE_SPACING}>
      <div className={`p-3 rounded-lg border ${borderColor} ${bgColor}`}>
        <ResultEventContent eventData={eventData} />
      </div>
    </div>
  );
}

function getTodoStatusIcon(status: string) {
  switch (status) {
    case "completed": {
      return <IconCheck className="h-4 w-4 text-lime-500" />;
    }
    case "in_progress": {
      return <IconLoader className="h-4 w-4 text-yellow-500" />;
    }
    default: {
      return <IconCircle className="h-4 w-4 text-muted-foreground" />;
    }
  }
}

/**
 * Standalone todo card that shows current task status as a single line.
 * Displays in-progress task with expandable full list.
 */
/**
 * Check if a todo item is a subtask (indented or prefixed with bullet).
 * Subtasks typically start with whitespace or bullet markers after whitespace.
 */
function isSubtask(content: string): boolean {
  // Matches items that start with whitespace, or start with bullet/dash after optional whitespace
  return /^\s{2,}|^\s*[-*]\s/.test(content);
}

function TodoCard({
  message,
  searchTerm,
}: {
  message: GroupedMessage;
  searchTerm?: string;
}) {
  const todoItems = message.todoState ?? [];
  // Filter out subtasks for count - only count top-level tasks
  const topLevelTodos = todoItems.filter((t) => !isSubtask(t.content));
  const inProgressTask = topLevelTodos.find((t) => t.status === "in_progress");
  const completedCount = topLevelTodos.filter(
    (t) => t.status === "completed",
  ).length;
  const totalCount = topLevelTodos.length;

  // Check if any todo item matches search
  const hasSearchMatch = Boolean(
    searchTerm &&
      searchTerm.trim() &&
      todoItems.some((t) =>
        t.content.toLowerCase().includes(searchTerm.toLowerCase()),
      ),
  );

  const timestamp = formatEventTime(message.createdAt);
  return (
    <details className={`${MESSAGE_SPACING} group`} open={hasSearchMatch}>
      <summary className="cursor-pointer list-none">
        <div className="flex gap-2 items-center">
          <StatusDot variant="todo" />
          <span className="font-semibold text-sm text-foreground shrink-0">
            Todo
          </span>
          {inProgressTask ? (
            <span
              className="text-sm text-foreground truncate"
              title={inProgressTask.content}
            >
              {inProgressTask.content}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              All tasks completed
            </span>
          )}
          <span className="text-sm text-muted-foreground shrink-0">
            [{completedCount}/{totalCount}]
          </span>
          <span className="flex-1" />
          <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
            {timestamp}
          </span>
        </div>
        <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
          {timestamp}
        </div>
      </summary>
      <div className="mt-2 space-y-1.5 ml-[18px]">
        {todoItems.map((item, index) => (
          <div
            key={`${item.content}-${index}`}
            className="flex items-center gap-2 text-sm"
          >
            <span className="shrink-0">{getTodoStatusIcon(item.status)}</span>
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

  // Calculate match offset for text sections
  const currentOffset = matchStartIndex ?? 0;

  // Count matches in textBefore for offset calculation
  const textBeforeMatches =
    searchTerm && textBefore
      ? (
          textBefore
            .toLowerCase()
            .match(new RegExp(searchTerm.toLowerCase(), "g")) ?? []
        ).length
      : 0;

  // Build array of elements to render independently
  const elements: React.ReactNode[] = [];

  // Text before tools with timestamp
  const timestamp = formatEventTime(message.createdAt);
  if (textBefore) {
    elements.push(
      <div key="text-before" className={MESSAGE_SPACING}>
        <div className="flex gap-2 items-start">
          <StatusDot variant="neutral" className="mt-1.5" />
          <div className="flex-1 min-w-0">
            <CollapsibleMarkdown
              text={textBefore}
              searchTerm={searchTerm}
              currentMatchIndex={currentMatchIndex}
              matchStartIndex={currentOffset}
            />
          </div>
          <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
            {timestamp}
          </span>
        </div>
        <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
          {timestamp}
        </div>
      </div>,
    );
  }

  // Tool operations - each independent with its own timestamp
  if (hasTools) {
    for (const op of toolOperations) {
      const toolMatchStart = currentOffset + textBeforeMatches;
      elements.push(
        <div key={op.toolUseId} className={MESSAGE_SPACING}>
          <ToolSummary
            operation={op}
            searchTerm={searchTerm}
            currentMatchIndex={currentMatchIndex}
            matchStartIndex={toolMatchStart}
            timestamp={formatEventTime(message.createdAt)}
          />
        </div>,
      );
    }
  }

  // Text after tools
  if (textAfter) {
    elements.push(
      <div
        key="text-after"
        className={`${MESSAGE_SPACING} flex gap-2 items-start`}
      >
        <StatusDot variant="neutral" className="mt-1.5" />
        <div className="flex-1 min-w-0">
          <CollapsibleMarkdown
            text={textAfter}
            searchTerm={searchTerm}
            currentMatchIndex={currentMatchIndex}
            matchStartIndex={currentOffset + textBeforeMatches}
          />
        </div>
      </div>,
    );
  }

  return <>{elements}</>;
}
