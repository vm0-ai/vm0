import { useGet, useSet, useLastResolved } from "ccstate-react";
import {
  IconX,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@tabler/icons-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { processShortcut } from "@vm0/ui";
import {
  visibleTasks$,
  type TaskSignals,
  type TaskPanelEntry,
} from "../../signals/mission-control-page/mission-control-tasks.ts";
import {
  maximizedTaskId$,
  toggleMaximizeTask$,
} from "../../signals/mission-control-page/mission-control-panels.ts";
import { ZeroChatThreadPageInner } from "../zero-page/zero-chat-thread-page.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";
import { ActivityPanelContent } from "./activity-panel-content.tsx";
import { TaskTypeIcon, TaskStatusIcon } from "./task-card.tsx";

export function TaskPanel() {
  const entries = useLastResolved(visibleTasks$) ?? [];

  return (
    <Group orientation="horizontal" id="mc-tasks" className="flex-1 min-h-0">
      {entries.flatMap((ts, index) => {
        const taskId = ts.task.id;
        const elements = [];
        if (index > 0) {
          elements.push(
            <Separator key={`sep-${taskId}`} className="w-px bg-border" />,
          );
        }
        elements.push(
          <Panel key={taskId} id={`task-${taskId}`} minSize="60%">
            <TaskPanelCard taskSignals={ts} />
          </Panel>,
        );
        return elements;
      })}
    </Group>
  );
}

function TaskPanelCard({ taskSignals }: { taskSignals: TaskSignals }) {
  const closeTask = useSet(taskSignals.closeTask$);
  const toggleMaximize = useSet(toggleMaximizeTask$);
  const maximizedId = useGet(maximizedTaskId$);

  const taskId = taskSignals.task.id;
  const isMaximized = maximizedId === taskId;

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onKeyDown={(e) => {
        processShortcut(
          {
            "mod+shift+enter": () => {
              toggleMaximize(taskId);
            },
          },
          e,
        );
      }}
    >
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/30">
        <TaskPanelTitle taskSignals={taskSignals} />
        <div className="flex items-center gap-0.5 shrink-0">
          <TaskStatusIcon task={taskSignals.task} />
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
          <button
            type="button"
            onClick={() => {
              closeTask();
            }}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Close task"
          >
            <IconX size={14} stroke={1.5} />
          </button>
        </div>
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <TaskPanelContent taskSignals={taskSignals} />
      </div>
    </div>
  );
}

function TaskPanelTitle({ taskSignals }: { taskSignals: TaskSignals }) {
  const { task } = taskSignals;
  const agentName = task.agent.displayName ?? task.agent.name;

  return (
    <div className="flex items-center gap-1.5 min-w-0 text-xs text-muted-foreground font-medium">
      <TaskTypeIcon task={task} />
      <AvatarFromUrl
        avatarUrl={task.agent.avatarUrl}
        alt={agentName}
        className="h-4 w-4 shrink-0 rounded-full object-cover object-top"
      />
      <span className="truncate">{agentName}</span>
      {task.summary && (
        <>
          <span className="shrink-0">·</span>
          <span className="truncate">{task.summary}</span>
        </>
      )}
    </div>
  );
}

function TaskPanelContent({ taskSignals }: { taskSignals: TaskSignals }) {
  const panelEntry = useGet(taskSignals.panelEntry$);
  if (!panelEntry) {
    return null;
  }
  return <TaskPanelEntryContent entry={panelEntry} />;
}

function TaskPanelEntryContent({ entry }: { entry: TaskPanelEntry }) {
  switch (entry.kind) {
    case "chat": {
      return (
        <ZeroChatThreadPageInner thread={entry.signals} autoFocus={false} />
      );
    }
    case "activity": {
      return <ActivityPanelContent signals={entry.signals} />;
    }
  }
}
