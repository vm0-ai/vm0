import { useGet, useSet, useLastResolved } from "ccstate-react";
import {
  IconX,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@tabler/icons-react";
import { processShortcut } from "@vm0/ui";
import {
  visibleTasks$,
  closeAndFocusNextInput$,
  type TaskSignals,
  type TaskPanelEntry,
} from "../../signals/mission-control-page/mission-control-tasks.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  maximizedTaskId$,
  toggleMaximizeTask$,
} from "../../signals/mission-control-page/mission-control-panels.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ZeroChatThreadPageInner } from "../zero-page/zero-chat-thread-page.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";
import { ActivityPanelContent } from "./activity-panel-content.tsx";
import { TaskTypeIcon } from "./task-card.tsx";

export function TaskPanel() {
  const entries = useLastResolved(visibleTasks$) ?? [];

  return (
    <div className="flex h-full min-h-0">
      {entries.flatMap((ts, index) => {
        const taskId = ts.taskId;
        const elements = [];
        if (index > 0) {
          elements.push(
            <div key={`sep-${taskId}`} className="w-px bg-border shrink-0" />,
          );
        }
        elements.push(
          <div key={taskId} className="flex-1 min-w-0 h-full">
            <TaskPanelCard taskSignals={ts} />
          </div>,
        );
        return elements;
      })}
    </div>
  );
}

function TaskPanelCard({ taskSignals }: { taskSignals: TaskSignals }) {
  const closeTask = useSet(taskSignals.closeTask$);
  const toggleMaximize = useSet(toggleMaximizeTask$);
  const focusCard = useSet(taskSignals.focusCard$);
  const scrollCardIntoView = useSet(taskSignals.scrollCardIntoView$);
  const setInputFocused = useSet(taskSignals.setInputFocused$);
  const closeAndFocusNext = useSet(closeAndFocusNextInput$);
  const pageSignal = useGet(pageSignal$);
  const maximizedId = useGet(maximizedTaskId$);

  const taskId = taskSignals.taskId;
  const isMaximized = maximizedId === taskId;

  return (
    <div
      className="flex flex-col h-full min-h-0"
      onFocus={(e) => {
        if (e.target instanceof HTMLTextAreaElement) {
          scrollCardIntoView();
          setInputFocused(true);
        }
      }}
      onBlur={(e) => {
        if (e.target instanceof HTMLTextAreaElement) {
          setInputFocused(false);
        }
      }}
      onKeyDown={(e) => {
        if (
          e.key === "d" &&
          e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.altKey &&
          e.target instanceof HTMLTextAreaElement &&
          e.target.value === ""
        ) {
          e.preventDefault();
          detach(closeAndFocusNext(taskId, pageSignal), Reason.DomCallback);
          return;
        }
        processShortcut(
          {
            "mod+shift+enter": () => {
              toggleMaximize(taskId);
            },
            escape: () => {
              focusCard();
            },
          },
          e,
        );
      }}
    >
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/30">
        <TaskPanelTitle taskSignals={taskSignals} />
        <div className="flex items-center gap-0.5 shrink-0">
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
      <div className="flex flex-col flex-1 min-h-0 overflow-auto">
        <TaskPanelContent taskSignals={taskSignals} />
      </div>
    </div>
  );
}

function TaskPanelTitle({ taskSignals }: { taskSignals: TaskSignals }) {
  const task = useGet(taskSignals.task$);
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
