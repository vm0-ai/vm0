import { useGet, useSet } from "ccstate-react";
import {
  IconMessageCircle,
  IconCalendar,
  IconBrandSlack,
  IconMail,
} from "@tabler/icons-react";
import { Card } from "@vm0/ui";
import type { TaskItem, TaskType } from "@vm0/core";
import { openMissionControlTask$ } from "../../signals/mission-control-page/mission-control-tasks.ts";
import { StatusBadge } from "../zero-page/components/log-views/status-badge.tsx";
import { AvatarFromUrl } from "../zero-page/zero-sidebar-shared.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";

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

export function TaskCard({
  task,
  isSelected,
}: {
  task: TaskItem;
  isSelected: boolean;
}) {
  const openTask = useSet(openMissionControlTask$);
  const pageSignal = useGet(pageSignal$);

  const onClick = () => {
    detach(openTask(task, pageSignal), Reason.DomCallback);
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
