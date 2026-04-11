import { useGet, useSet, useResolved } from "ccstate-react";
import {
  IconX,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@tabler/icons-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  openTaskEntries$,
  closeMissionControlTask$,
  type TaskPanelEntry,
} from "../../signals/mission-control-page/mission-control-tasks.ts";
import {
  setTaskGroupRef$,
  maximizedTaskId$,
  toggleMaximizeTask$,
} from "../../signals/mission-control-page/mission-control-panels.ts";
import { ZeroChatThreadPageInner } from "../zero-page/zero-chat-thread-page.tsx";
import { ActivityPanelContent } from "./activity-panel-content.tsx";

export function TaskPanel() {
  const entries = useGet(openTaskEntries$);
  const setGroupRef = useSet(setTaskGroupRef$);
  const maximizedId = useGet(maximizedTaskId$);

  return (
    <Group
      orientation="vertical"
      id="mc-tasks"
      groupRef={setGroupRef}
      className="flex-1 min-h-0"
    >
      {entries.flatMap(([taskId, entry], index) => {
        const elements = [];
        if (index > 0) {
          elements.push(
            <Separator key={`sep-${taskId}`} className="h-px bg-border" />,
          );
        }
        elements.push(
          <Panel
            key={taskId}
            id={`task-${taskId}`}
            minSize={maximizedId !== null ? 0 : 60}
          >
            <TaskPanelCard taskId={taskId} entry={entry} />
          </Panel>,
        );
        return elements;
      })}
    </Group>
  );
}

function TaskPanelCard({
  taskId,
  entry,
}: {
  taskId: string;
  entry: TaskPanelEntry;
}) {
  const closeTask = useSet(closeMissionControlTask$);
  const toggleMaximize = useSet(toggleMaximizeTask$);
  const maximizedId = useGet(maximizedTaskId$);

  const isMaximized = maximizedId === taskId;
  const anotherMaximized = maximizedId !== null && !isMaximized;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <TaskPanelTitle entry={entry} taskId={taskId} />
        <div className="flex items-center gap-0.5">
          {!anotherMaximized && (
            <button
              type="button"
              onClick={() => {
                toggleMaximize(taskId);
              }}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label={isMaximized ? "Restore task" : "Maximize task"}
            >
              {isMaximized ? (
                <IconArrowsMinimize size={14} stroke={1.5} />
              ) : (
                <IconArrowsMaximize size={14} stroke={1.5} />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              closeTask(taskId);
            }}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Close task"
          >
            <IconX size={14} stroke={1.5} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <TaskPanelContent entry={entry} />
      </div>
    </div>
  );
}

function TaskPanelTitle({
  entry,
  taskId,
}: {
  entry: TaskPanelEntry;
  taskId: string;
}) {
  if (entry.kind === "chat") {
    return <ChatPanelTitle entry={entry} taskId={taskId} />;
  }
  const title =
    entry.task.title ?? entry.task.agent.displayName ?? entry.task.agent.name;
  return (
    <span className="text-xs text-muted-foreground font-medium truncate">
      {title}
    </span>
  );
}

function ChatPanelTitle({
  entry,
  taskId,
}: {
  entry: Extract<TaskPanelEntry, { kind: "chat" }>;
  taskId: string;
}) {
  const displayName = useResolved(entry.signals.agentDisplayName$);
  return (
    <span className="text-xs text-muted-foreground font-medium truncate">
      {displayName ?? taskId}
    </span>
  );
}

function TaskPanelContent({ entry }: { entry: TaskPanelEntry }) {
  switch (entry.kind) {
    case "chat": {
      return <ZeroChatThreadPageInner thread={entry.signals} />;
    }
    case "activity": {
      return <ActivityPanelContent signals={entry.signals} />;
    }
  }
}
