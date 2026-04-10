import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconMessageCircle,
  IconCalendar,
  IconBrandSlack,
  IconMail,
} from "@tabler/icons-react";
import { Skeleton, Card } from "@vm0/ui";
import type { TaskItem, TaskType } from "@vm0/core";
import {
  tasks$,
  selectedTaskIndex$,
  navigateToTask$,
} from "../../signals/mission-control-page/mission-control.ts";
import { StatusBadge } from "../zero-page/components/log-views/status-badge.tsx";
import { AgentAvatarImg } from "../zero-page/zero-sidebar-shared.tsx";

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
  return (
    <div className="flex flex-1 flex-col min-h-0">
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

  const onClick = () => {
    navigate(task);
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
        <AgentAvatarImg
          name={task.agent.name}
          alt={task.agent.displayName ?? task.agent.name}
          className="h-8 w-8 rounded-full object-cover object-top shrink-0"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">
              {task.title ?? task.agent.displayName ?? task.agent.name}
            </span>
            {task.status && <StatusBadge status={task.status} zeroStyle />}
          </div>
          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
            <TypeIcon size={13} stroke={1.5} className={config.iconClassName} />
            <span>{config.label}</span>
            <span className="text-border">·</span>
            <span>{task.agent.displayName ?? task.agent.name}</span>
            <span className="text-border">·</span>
            <span>{formatRelativeTime(task.updatedAt)}</span>
          </div>
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
