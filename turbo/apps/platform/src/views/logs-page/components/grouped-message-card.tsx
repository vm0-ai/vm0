import { IconCheck, IconCircleDashed, IconLoader } from "@tabler/icons-react";
import MarkdownPreview from "@uiw/react-markdown-preview";
import type { GroupedMessage, ToolOperation } from "../log-detail/utils.ts";
import { ToolSummary } from "./tool-summary.tsx";
import {
  SystemInitContent,
  ResultEventContent,
  formatEventTime,
  type EventData,
} from "./event-card.tsx";
import { StatusDot } from "./status-dot.tsx";

interface GroupedMessageCardProps {
  message: GroupedMessage;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  showConnector?: boolean;
}

// Layout constants
const MESSAGE_SPACING = "py-2";

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

function CollapsibleText({ text }: { text: string }) {
  // Check if text is long (more than ~100 characters or contains newlines)
  const isLong = text.length > 100 || text.includes("\n");

  if (!isLong) {
    return <MarkdownContent text={text} />;
  }

  return (
    <details className="group cursor-pointer">
      <summary className="list-none">
        <div className="line-clamp-1 group-open:line-clamp-none">
          <MarkdownContent text={text} />
        </div>
      </summary>
    </details>
  );
}

export function GroupedMessageCard({
  message,
  searchTerm,
  currentMatchIndex,
  matchStartIndex = 0,
  showConnector = false,
}: GroupedMessageCardProps) {
  const eventData = message.eventData as EventData;

  // System event
  if (message.type === "system") {
    return (
      <SystemMessageCard
        message={message}
        eventData={eventData}
        showConnector={showConnector}
      />
    );
  }

  // Result event
  if (message.type === "result") {
    return (
      <ResultMessageCard
        message={message}
        eventData={eventData}
        showConnector={showConnector}
      />
    );
  }

  // Todo card (standalone)
  if (message.type === "todo") {
    return (
      <TodoCard
        message={message}
        searchTerm={searchTerm}
        showConnector={showConnector}
      />
    );
  }

  // Assistant message
  return (
    <AssistantMessageCard
      message={message}
      searchTerm={searchTerm}
      currentMatchIndex={currentMatchIndex}
      matchStartIndex={matchStartIndex}
      showConnector={showConnector}
    />
  );
}

function SystemMessageCard({
  message,
  eventData,
  showConnector = false,
}: {
  message: GroupedMessage;
  eventData: EventData;
  showConnector?: boolean;
}) {
  const subtype = eventData.subtype;
  const timestamp = formatEventTime(message.createdAt);
  return (
    <div className={`${MESSAGE_SPACING} relative`}>
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
          aria-hidden="true"
        />
      )}
      <div className="flex gap-2 items-center relative">
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
  message,
  eventData,
  showConnector = false,
}: {
  message: GroupedMessage;
  eventData: EventData;
  showConnector?: boolean;
}) {
  const timestamp = formatEventTime(message.createdAt);
  return (
    <div className="relative">
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
          aria-hidden="true"
        />
      )}
      <details className="group relative" open>
        <summary className="cursor-pointer list-none relative py-2">
          <div className="flex gap-2 items-center">
            <StatusDot variant="primary" />
            <span className="font-semibold text-sm text-foreground">
              Summary
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
        {/* Vertical line from dot to content */}
        <div className="absolute left-[2px] top-[2.25rem] bottom-0 w-[1px] bg-border/70 group-open:block hidden" />
        <div className="ml-[16px] mt-2 relative">
          <ResultEventContent eventData={eventData} />
        </div>
      </details>
    </div>
  );
}

function getTodoStatusIcon(status: string) {
  switch (status) {
    case "completed": {
      return <IconCheck className="h-4 w-4 text-green-600" />;
    }
    case "in_progress": {
      return <IconLoader className="h-4 w-4 text-yellow-500" />;
    }
    default: {
      return <IconCircleDashed className="h-4 w-4 text-muted-foreground" />;
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
  showConnector = false,
}: {
  message: GroupedMessage;
  searchTerm?: string;
  showConnector?: boolean;
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
    <div className={`${MESSAGE_SPACING} relative`}>
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
          aria-hidden="true"
        />
      )}
      <details className="group" open={hasSearchMatch}>
        <summary className="cursor-pointer list-none relative">
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
    </div>
  );
}

/**
 * Determine if a connector should be shown for an element within an assistant message.
 * Returns an object with showConnector and isDashed properties.
 */
function shouldShowAssistantConnector(params: {
  isLastElementInMessage: boolean;
  showConnectorToNextMessage: boolean;
}): { showConnector: boolean; isDashed: boolean } {
  const { isLastElementInMessage, showConnectorToNextMessage } = params;
  const showConnector = !isLastElementInMessage || showConnectorToNextMessage;
  // Default to solid lines - dashed lines only for same tool types
  const isDashed = false;
  return { showConnector, isDashed };
}

/**
 * Render a connector line between elements.
 */
function Connector({ isDashed }: { isDashed: boolean }) {
  return (
    <div
      className={`absolute left-[3px] top-6 bottom-[-8px] w-[1px] ${
        isDashed
          ? "border-l border-dashed border-border/70 bg-transparent"
          : "bg-border/70"
      }`}
      aria-hidden="true"
    />
  );
}

interface ToolGroup {
  toolName: string;
  operations: ToolOperation[];
}

/**
 * Group consecutive tool operations by tool name.
 * Non-consecutive operations of the same type stay in separate groups.
 */
export function groupConsecutiveTools(
  operations: ToolOperation[],
): ToolGroup[] {
  const groups: ToolGroup[] = [];
  for (const op of operations) {
    const last = groups[groups.length - 1];
    if (last && last.toolName === op.toolName) {
      last.operations.push(op);
    } else {
      groups.push({ toolName: op.toolName, operations: [op] });
    }
  }
  return groups;
}

function CollapsedToolGroup({
  group,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
  timestamp,
  showConnector,
  isDashed,
}: {
  group: ToolGroup;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  timestamp: string;
  showConnector: boolean;
  isDashed: boolean;
}) {
  const count = group.operations.length;
  const label =
    group.toolName === "Read"
      ? `${count} files`
      : group.toolName === "Grep"
        ? `${count} searches`
        : `${count} calls`;

  return (
    <div className={`${MESSAGE_SPACING} relative`}>
      {showConnector && <Connector isDashed={isDashed} />}
      <div className="relative">
        <details className="group">
          <summary className="cursor-pointer list-none w-full text-left">
            <div className="flex items-center gap-2">
              <StatusDot variant="success" />
              <span className="font-semibold text-sm text-foreground shrink-0">
                {group.toolName}
              </span>
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {label}
              </span>
              {timestamp && (
                <span className="text-xs text-muted-foreground shrink-0 ml-auto whitespace-nowrap hidden sm:inline">
                  {timestamp}
                </span>
              )}
            </div>
          </summary>
          <div className="mt-1 ml-5 space-y-1">
            {group.operations.map((op) => (
              <ToolSummary
                key={op.toolUseId}
                operation={op}
                searchTerm={searchTerm}
                currentMatchIndex={currentMatchIndex}
                matchStartIndex={matchStartIndex}
              />
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

function AssistantMessageCard({
  message,
  searchTerm,
  currentMatchIndex,
  matchStartIndex,
  showConnector = false,
}: {
  message: GroupedMessage;
  searchTerm?: string;
  currentMatchIndex?: number;
  matchStartIndex?: number;
  showConnector?: boolean;
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
    const isLastElement = !hasTools && !textAfter;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInMessage: isLastElement,
        showConnectorToNextMessage: showConnector,
      });

    elements.push(
      <div key="text-before" className={`${MESSAGE_SPACING} relative`}>
        {showConnectorHere && <Connector isDashed={isDashed} />}
        <div className="flex gap-2 items-start relative">
          <StatusDot variant="neutral" className="mt-1.5" />
          <div className="flex-1 min-w-0">
            <CollapsibleText text={textBefore} />
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

  // Tool operations - group consecutive same-type tools
  if (hasTools) {
    const toolGroups = groupConsecutiveTools(toolOperations);
    const toolMatchStart = currentOffset + textBeforeMatches;

    for (let gi = 0; gi < toolGroups.length; gi++) {
      const group = toolGroups[gi]!;
      const isLastGroup = gi === toolGroups.length - 1;
      const isLastElement = isLastGroup && !textAfter;

      const { showConnector: showConnectorHere } = shouldShowAssistantConnector(
        {
          isLastElementInMessage: isLastElement,
          showConnectorToNextMessage: showConnector,
        },
      );

      // Dashed line if next group is the same tool type
      const nextGroup = toolGroups[gi + 1];
      const isDashed = nextGroup
        ? nextGroup.toolName === group.toolName
        : false;

      if (group.operations.length === 1) {
        // Single operation: render as before
        const op = group.operations[0]!;
        elements.push(
          <div key={op.toolUseId} className={`${MESSAGE_SPACING} relative`}>
            {showConnectorHere && <Connector isDashed={isDashed} />}
            <div className="relative">
              <ToolSummary
                operation={op}
                searchTerm={searchTerm}
                currentMatchIndex={currentMatchIndex}
                matchStartIndex={toolMatchStart}
                timestamp={formatEventTime(message.createdAt)}
              />
            </div>
          </div>,
        );
      } else {
        // Multiple consecutive same-type operations: render collapsed group
        elements.push(
          <CollapsedToolGroup
            key={`group-${group.operations[0]!.toolUseId}`}
            group={group}
            searchTerm={searchTerm}
            currentMatchIndex={currentMatchIndex}
            matchStartIndex={toolMatchStart}
            timestamp={formatEventTime(message.createdAt)}
            showConnector={showConnectorHere}
            isDashed={isDashed}
          />,
        );
      }
    }
  }

  // Text after tools
  if (textAfter) {
    const isLastElement = true;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInMessage: isLastElement,
        showConnectorToNextMessage: showConnector,
      });

    elements.push(
      <div key="text-after" className={`${MESSAGE_SPACING} relative`}>
        {showConnectorHere && <Connector isDashed={isDashed} />}
        <div className="flex gap-2 items-start relative w-full">
          <StatusDot variant="neutral" className="mt-1.5" />
          <div className="flex-1 min-w-0">
            <CollapsibleText text={textAfter} />
          </div>
        </div>
      </div>,
    );
  }

  return <>{elements}</>;
}
