import { useGet, useSet, useLastLoadable, useResolved } from "ccstate-react";
import {
  IconMessageCircle,
  IconCalendar,
  IconBrandSlack,
  IconMail,
  IconX,
} from "@tabler/icons-react";
import { Skeleton, Card } from "@vm0/ui";
import type { TaskItem, TaskType } from "@vm0/core";
import {
  tasks$,
  selectedTaskIndex$,
  navigateToTask$,
} from "../../signals/mission-control-page/mission-control.ts";
import {
  missionControlPanelVisible$,
  openThreadEntries$,
  openMissionControlThread$,
  closeMissionControlThread$,
} from "../../signals/mission-control-page/mission-control-threads.ts";
import { ZeroChatThreadPageInner } from "../zero-page/zero-chat-thread-page.tsx";
import { StatusBadge } from "../zero-page/components/log-views/status-badge.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";

function getTaskTypeConfig(type: TaskType): {
  label: string;
  icon: typeof IconMessageCircle;
  iconClassName: string;
} {
  switch (type) {
    case "chat": {
      return {
        label: "Chat",
        icon: IconMessageCircle,
        iconClassName: "text-sky-500",
      };
    }
    case "schedule": {
      return {
        label: "Schedule",
        icon: IconCalendar,
        iconClassName: "text-violet-500",
      };
    }
    case "slack": {
      return {
        label: "Slack",
        icon: IconBrandSlack,
        iconClassName: "text-emerald-500",
      };
    }
    case "email": {
      return {
        label: "Email",
        icon: IconMail,
        iconClassName: "text-amber-500",
      };
    }
  }
}

export function MissionControlPage() {
  const panelVisible = useGet(missionControlPanelVisible$);

  return (
    <div className="flex flex-1 min-h-0">
      {/* Left column: task list */}
      <div
        className={`flex flex-col min-h-0 transition-all duration-300 ${
          panelVisible ? "w-[360px] shrink-0 border-r" : "flex-1"
        }`}
      >
        <div className="shrink-0 px-6 pt-6 pb-2">
          <h1 className="text-lg font-semibold">Mission Control</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Active tasks across all channels
          </p>
        </div>
        <div className="flex-1 overflow-auto px-6 pb-6">
          <TaskList />
        </div>
      </div>

      {/* Right column: thread panel, slides in */}
      {panelVisible && <MissionControlThreadPanel />}
    </div>
  );
}

function MissionControlThreadPanel() {
  const entries = useGet(openThreadEntries$);

  return (
    <div className="flex flex-col flex-1 min-h-0 divide-y">
      {entries.map(([threadId, signals]) => {
        return (
          <ThreadCard key={threadId} threadId={threadId} signals={signals} />
        );
      })}
    </div>
  );
}

function ThreadCard({
  threadId,
  signals,
}: {
  threadId: string;
  signals: ChatThreadSignals;
}) {
  const closeThread = useSet(closeMissionControlThread$);
  const displayName = useResolved(signals.agentDisplayName$);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <span className="text-xs text-muted-foreground font-medium truncate">
          {displayName ?? threadId}
        </span>
        <button
          type="button"
          onClick={() => {
            closeThread(threadId);
          }}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Close thread"
        >
          <IconX size={14} stroke={1.5} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <ZeroChatThreadPageInner thread={signals} />
      </div>
    </div>
  );
}

function TaskList() {
  const tasksLoadable = useLastLoadable(tasks$);
  const tasks = tasksLoadable.state === "hasData" ? tasksLoadable.data : [];
  const loading = tasksLoadable.state === "loading";
  const error =
    tasksLoadable.state === "hasError"
      ? tasksLoadable.error instanceof Error
        ? tasksLoadable.error.message
        : "Failed to load tasks"
      : null;

  const selectedIndex = useGet(selectedTaskIndex$);

  if (loading && tasks.length === 0) {
    return (
      <div className="flex flex-col gap-3 mt-2">
        {Array.from({ length: 5 }, (_, i) => {
          return (
            <Card key={i} className="p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  if (error) {
    return <p className="py-8 text-sm text-destructive">{error}</p>;
  }

  if (tasks.length === 0) {
    return (
      <p className="py-8 text-sm text-muted-foreground text-center">
        No active tasks
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 mt-2">
      {tasks.map((task, index) => {
        return (
          <TaskCard
            key={task.id}
            task={task}
            isSelected={index === selectedIndex}
          />
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  isSelected,
}: {
  task: TaskItem;
  isSelected: boolean;
}) {
  const navigate = useSet(navigateToTask$);
  const openThread = useSet(openMissionControlThread$);
  const pageSignal = useGet(pageSignal$);

  const onClick = () => {
    if (task.type === "chat" && task.chatThreadId) {
      detach(openThread(task.chatThreadId, pageSignal), Reason.DomCallback);
    } else {
      navigate(task);
    }
  };

  const config = getTaskTypeConfig(task.type);
  const TypeIcon = config.icon;

  return (
    <Card
      ref={(el) => {
        if (isSelected && el) {
          el.scrollIntoView({ block: "nearest" });
        }
      }}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`p-4 cursor-pointer transition-colors ${
        isSelected ? "ring-2 ring-primary bg-accent" : "hover:bg-accent/50"
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center shrink-0 gap-1">
          <AvatarFromUrl
            avatarUrl={task.agent.avatarUrl}
            alt={task.agent.displayName ?? task.agent.name}
            className="h-8 w-8 rounded-full object-cover object-top"
          />
          <span className="text-[10px] text-muted-foreground truncate max-w-[4rem] leading-tight">
            {task.agent.displayName ?? task.agent.name}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <TypeIcon size={14} stroke={1.5} className={config.iconClassName} />
            <span className="text-sm font-medium truncate">
              {task.title ?? task.agent.displayName ?? task.agent.name}
            </span>
            <div className="ml-auto flex items-center gap-2 shrink-0">
              <span className="text-xs text-muted-foreground">
                last activity {formatRelativeTime(task.updatedAt)}
              </span>
              {task.status && <StatusBadge status={task.status} zeroStyle />}
            </div>
          </div>
          {task.summary && (
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {task.summary}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) {
    return "just now";
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    return `${diffHr}h ago`;
  }
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
