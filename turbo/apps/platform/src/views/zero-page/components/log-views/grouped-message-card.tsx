import { IconCheck, IconCircleDashed, IconLoader } from "@tabler/icons-react";
import { Markdown } from "../../../components/markdown.tsx";
import {
  isTaskEventData,
  type GroupedMessage,
  type ToolOperation,
} from "./log-detail-utils.ts";
import { ToolSummary } from "./tool-summary.tsx";
import {
  SystemInitContent,
  ResultEventContent,
  formatEventTime,
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
  return <Markdown source={text} />;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function ThinkingSummary({
  text,
  searchTerm,
  timestamp,
  showConnector,
  isDashed,
}: {
  text: string;
  searchTerm?: string;
  timestamp: string;
  showConnector: boolean;
  isDashed: boolean;
}) {
  const hasSearchMatch = Boolean(
    searchTerm &&
    searchTerm.trim() &&
    text.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  return (
    <div className={`${MESSAGE_SPACING} relative`}>
      {showConnector && <Connector isDashed={isDashed} />}
      <details className="group" open={hasSearchMatch}>
        <summary className="cursor-pointer list-none w-full text-left">
          <div className="flex items-center gap-2">
            <StatusDot variant="success" />
            <span className="font-semibold text-sm text-foreground shrink-0">
              Thinking
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

        <div className="mt-1 flex items-start gap-1.5 ml-[18px] overflow-hidden">
          <span className="text-muted-foreground text-xs shrink-0">└</span>
          <div className="flex-1 min-w-0 text-sm text-foreground">
            <MarkdownContent text={text} />
          </div>
        </div>
      </details>
    </div>
  );
}

function AssistantSection({
  children,
  timestamp,
  showConnector,
  isDashed,
}: {
  children: React.ReactNode;
  timestamp?: string;
  showConnector: boolean;
  isDashed: boolean;
}) {
  return (
    <div className={`${MESSAGE_SPACING} relative`}>
      {showConnector && <Connector isDashed={isDashed} />}
      <div className="flex gap-2 items-start relative">
        <StatusDot variant="neutral" className="mt-1.5" />
        <div className="flex-1 min-w-0">{children}</div>
        {timestamp && (
          <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
            {timestamp}
          </span>
        )}
      </div>
      {timestamp && (
        <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
          {timestamp}
        </div>
      )}
    </div>
  );
}

export function GroupedMessageCard({
  message,
  searchTerm,
  currentMatchIndex,
  matchStartIndex = 0,
  showConnector = false,
}: GroupedMessageCardProps) {
  // System event
  if (message.type === "system") {
    return (
      <SystemMessageCard
        message={message}
        searchTerm={searchTerm}
        showConnector={showConnector}
      />
    );
  }

  // Result event
  if (message.type === "result") {
    return (
      <ResultMessageCard message={message} showConnector={showConnector} />
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

function TaskMessageCard({
  message,
  searchTerm,
  showConnector = false,
}: {
  message: GroupedMessage;
  searchTerm?: string;
  showConnector?: boolean;
}) {
  const taskData = isTaskEventData(message.eventData)
    ? message.eventData
    : null;
  const description =
    stringValue(taskData?.description) ??
    stringValue(taskData?.task_summary) ??
    "";
  const taskStatus = stringValue(taskData?.task_status);
  const isFailed = taskStatus === "error" || taskStatus === "failed";
  const isRunning = !taskStatus;
  const timestamp = formatEventTime(message.createdAt);
  const children = message.childMessages ?? [];
  const hasChildren = children.length > 0;

  // Count tool operations across child messages
  const toolCount = children.reduce((sum, child) => {
    return sum + (child.toolOperations?.length ?? 0);
  }, 0);

  if (!hasChildren) {
    return (
      <div className={`${MESSAGE_SPACING} relative`}>
        {showConnector && (
          <div
            className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
            aria-hidden="true"
          />
        )}
        <div className="flex gap-2 items-center relative">
          {isRunning ? (
            <IconLoader className="h-3 w-3 text-yellow-600 animate-spin shrink-0" />
          ) : (
            <StatusDot variant={isFailed ? "error" : "success"} />
          )}
          <span className="font-semibold text-sm text-foreground shrink-0">
            Task
          </span>
          {description && (
            <span className="text-sm text-muted-foreground truncate">
              {description}
            </span>
          )}
          <span className="flex-1" />
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

  return (
    <div className="relative">
      {showConnector && (
        <div
          className="absolute left-[3px] top-6 bottom-[-8px] w-[1px] bg-border/70"
          aria-hidden="true"
        />
      )}
      <details className="group relative">
        <summary className="cursor-pointer list-none relative py-2">
          <div className="flex gap-2 items-center">
            {isRunning ? (
              <IconLoader className="h-3 w-3 text-yellow-600 animate-spin shrink-0" />
            ) : (
              <StatusDot variant={isFailed ? "error" : "success"} />
            )}
            <span className="font-semibold text-sm text-foreground shrink-0">
              Task
            </span>
            {description && (
              <span className="text-sm text-muted-foreground truncate min-w-0">
                {description}
              </span>
            )}
            {toolCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground shrink-0">
                {toolCount} steps
              </span>
            )}
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground shrink-0 ml-4 whitespace-nowrap hidden sm:inline">
              {timestamp}
            </span>
          </div>
          <div className="text-xs text-muted-foreground pl-5 mt-1 sm:hidden">
            {timestamp}
          </div>
        </summary>
        <div className="mt-1">
          {children.map((child, i) => {
            return (
              <GroupedMessageCard
                key={child.sequenceNumber}
                message={child}
                searchTerm={searchTerm}
                showConnector={i < children.length - 1}
              />
            );
          })}
        </div>
      </details>
    </div>
  );
}

function SystemMessageCard({
  message,
  searchTerm,
  showConnector = false,
}: {
  message: GroupedMessage;
  searchTerm?: string;
  showConnector?: boolean;
}) {
  const eventData = isRecord(message.eventData) ? message.eventData : {};
  const subtype =
    typeof eventData.subtype === "string" ? eventData.subtype : undefined;

  // Task events are rendered by TaskMessageCard
  if (subtype === "task_started" || subtype === "task_notification") {
    return (
      <TaskMessageCard
        message={message}
        searchTerm={searchTerm}
        showConnector={showConnector}
      />
    );
  }

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
  showConnector = false,
}: {
  message: GroupedMessage;
  showConnector?: boolean;
}) {
  const eventData = isRecord(message.eventData) ? message.eventData : {};
  const timestamp = formatEventTime(message.createdAt);
  const isError = eventData.is_error === true || eventData.success === false;
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
            <StatusDot variant={isError ? "error" : "primary"} />
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
        <div className="ml-[18px] mt-2 relative">
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
  const topLevelTodos = todoItems.filter((t) => {
    return !isSubtask(t.content);
  });
  const inProgressTask = topLevelTodos.find((t) => {
    return t.status === "in_progress";
  });
  const completedCount = topLevelTodos.filter((t) => {
    return t.status === "completed";
  }).length;
  const totalCount = topLevelTodos.length;

  // Check if any todo item matches search
  const hasSearchMatch = Boolean(
    searchTerm &&
    searchTerm.trim() &&
    todoItems.some((t) => {
      return t.content.toLowerCase().includes(searchTerm.toLowerCase());
    }),
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
          {todoItems.map((item) => {
            return (
              <div
                key={item.content}
                className="flex items-center gap-2 text-sm"
              >
                <span className="shrink-0">
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
            );
          })}
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

function countMatches(text: string | undefined, searchTerm?: string): number {
  if (!searchTerm || !text) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  const normalizedSearch = searchTerm.toLowerCase();
  let count = 0;
  let index = normalizedText.indexOf(normalizedSearch);

  while (index !== -1) {
    count++;
    index = normalizedText.indexOf(
      normalizedSearch,
      index + normalizedSearch.length,
    );
  }

  return count;
}

interface ToolGroup {
  toolName: string;
  operations: ToolOperation[];
}

/**
 * Group consecutive tool operations by tool name.
 * Non-consecutive operations of the same type stay in separate groups.
 */
function groupConsecutiveTools(operations: ToolOperation[]): ToolGroup[] {
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
              <span className="font-semibold text-sm text-foreground truncate min-w-0">
                {group.toolName}
              </span>
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground shrink-0">
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
            {group.operations.map((op) => {
              return (
                <ToolSummary
                  key={op.toolUseId}
                  operation={op}
                  searchTerm={searchTerm}
                  currentMatchIndex={currentMatchIndex}
                  matchStartIndex={matchStartIndex}
                />
              );
            })}
          </div>
        </details>
      </div>
    </div>
  );
}

function renderToolElements(params: {
  toolOperations: ToolOperation[];
  textAfter?: string;
  toolMatchStart: number;
  currentMatchIndex?: number;
  searchTerm?: string;
  showConnector: boolean;
  timestamp: string;
}): React.ReactNode[] {
  const {
    toolOperations,
    textAfter,
    toolMatchStart,
    currentMatchIndex,
    searchTerm,
    showConnector,
    timestamp,
  } = params;
  const elements: React.ReactNode[] = [];
  const toolGroups = groupConsecutiveTools(toolOperations);

  for (let gi = 0; gi < toolGroups.length; gi++) {
    const group = toolGroups[gi]!;
    const isLastGroup = gi === toolGroups.length - 1;
    const isLastElement = isLastGroup && !textAfter;
    const { showConnector: showConnectorHere } = shouldShowAssistantConnector({
      isLastElementInMessage: isLastElement,
      showConnectorToNextMessage: showConnector,
    });
    const nextGroup = toolGroups[gi + 1];
    const isDashed = nextGroup ? nextGroup.toolName === group.toolName : false;

    if (group.operations.length === 1) {
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
              timestamp={timestamp}
            />
          </div>
        </div>,
      );
    } else {
      elements.push(
        <CollapsedToolGroup
          key={`group-${group.operations[0]!.toolUseId}`}
          group={group}
          searchTerm={searchTerm}
          currentMatchIndex={currentMatchIndex}
          matchStartIndex={toolMatchStart}
          timestamp={timestamp}
          showConnector={showConnectorHere}
          isDashed={isDashed}
        />,
      );
    }
  }

  return elements;
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
  const { thinkingBlocks, textBefore, textAfter, toolOperations } = message;
  const thinkingText = thinkingBlocks?.join("\n\n");
  const hasTools = toolOperations && toolOperations.length > 0;
  const currentOffset = matchStartIndex ?? 0;
  const textBeforeMatches = countMatches(textBefore, searchTerm);
  const thinkingMatches = countMatches(thinkingText, searchTerm);
  const elements: React.ReactNode[] = [];
  const timestamp = formatEventTime(message.createdAt);

  if (thinkingText) {
    const isLastElement = !textBefore && !hasTools && !textAfter;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInMessage: isLastElement,
        showConnectorToNextMessage: showConnector,
      });

    elements.push(
      <ThinkingSummary
        key="thinking"
        text={thinkingText}
        searchTerm={searchTerm}
        timestamp={timestamp}
        showConnector={showConnectorHere}
        isDashed={isDashed}
      />,
    );
  }

  if (textBefore) {
    const isLastElement = !hasTools && !textAfter;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInMessage: isLastElement,
        showConnectorToNextMessage: showConnector,
      });

    elements.push(
      <AssistantSection
        key="text-before"
        timestamp={timestamp}
        showConnector={showConnectorHere}
        isDashed={isDashed}
      >
        <CollapsibleText text={textBefore} />
      </AssistantSection>,
    );
  }

  if (hasTools) {
    const toolMatchStart = currentOffset + thinkingMatches + textBeforeMatches;
    elements.push(
      ...renderToolElements({
        toolOperations,
        textAfter,
        toolMatchStart,
        currentMatchIndex,
        searchTerm,
        showConnector,
        timestamp,
      }),
    );
  }

  if (textAfter) {
    const isLastElement = true;
    const { showConnector: showConnectorHere, isDashed } =
      shouldShowAssistantConnector({
        isLastElementInMessage: isLastElement,
        showConnectorToNextMessage: showConnector,
      });

    elements.push(
      <AssistantSection
        key="text-after"
        showConnector={showConnectorHere}
        isDashed={isDashed}
      >
        <CollapsibleText text={textAfter} />
      </AssistantSection>,
    );
  }

  return <>{elements}</>;
}
