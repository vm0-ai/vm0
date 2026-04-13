import { useGet, useSet } from "ccstate-react";
import {
  IconMessageCircle,
  IconCalendar,
  IconBrandSlack,
  IconMail,
  IconMicrophone,
  IconRobot,
  IconArchive,
} from "@tabler/icons-react";
import { Card, Shortcut } from "@vm0/ui";
import type { TaskItem, TaskType } from "@vm0/core";
import {
  archiveAndFocusNext$,
  type TaskSignals,
} from "../../signals/mission-control-page/mission-control-tasks.ts";
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
    case "voice_chat": {
      return {
        label: "Voice Chat",
        icon: IconMicrophone,
        iconClassName: "text-rose-500",
      };
    }
    case "agent": {
      return {
        label: "Agent",
        icon: IconRobot,
        iconClassName: "text-cyan-500",
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

export function TaskCard({ taskSignals }: { taskSignals: TaskSignals }) {
  const openTask = useSet(taskSignals.openTask$);
  const pageSignal = useGet(pageSignal$);
  const isOpen = useGet(taskSignals.open$);
  const task = useGet(taskSignals.task$);
  const unread = useGet(taskSignals.unread$);

  const closeTask = useSet(taskSignals.closeTask$);

  const config = getTaskTypeConfig(task.type);
  const TypeIcon = config.icon;

  const focusInput = useSet(taskSignals.focusInput$);
  const setCardRef = useSet(taskSignals.setCardRef$);
  const inputFocused = useGet(taskSignals.inputFocused$);
  const archiveAndFocusNext = useSet(archiveAndFocusNext$);

  const toggle = () => {
    if (isOpen) {
      closeTask();
    } else {
      detach(openTask(pageSignal), Reason.DomCallback);
    }
  };

  const openOrFocusInput = () => {
    if (isOpen) {
      focusInput();
    } else {
      detach(
        openTask(pageSignal).then(() => {
          focusInput();
        }),
        Reason.DomCallback,
      );
    }
  };

  const archiveTask = () => {
    detach(archiveAndFocusNext(task.id, pageSignal), Reason.DomCallback);
  };

  const archiveOnClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    archiveTask();
  };

  return (
    <Shortcut
      binding={{
        enter: openOrFocusInput,
        " ": toggle,
      }}
    >
      <Card
        ref={setCardRef}
        role="button"
        tabIndex={0}
        data-task-id={task.id}
        onClick={openOrFocusInput}
        className={`group p-4 cursor-pointer transition-colors hover:bg-accent/50 focus:outline focus:outline-2 focus:outline-primary ${
          inputFocused ? "bg-accent" : unread ? "bg-primary/5" : ""
        } ${isOpen ? "border-primary" : ""}`}
      >
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <AvatarFromUrl
              avatarUrl={task.agent.avatarUrl}
              alt={task.agent.displayName ?? task.agent.name}
              className="h-5 w-5 rounded-full object-cover object-top"
            />
            <span className="text-xs font-medium truncate">
              {task.agent.displayName ?? task.agent.name}
            </span>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              {task.status && <StatusBadge status={task.status} zeroStyle />}
              <button
                aria-label="Archive task"
                onClick={archiveOnClick}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
              >
                <IconArchive size={14} stroke={1.5} />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <TypeIcon size={14} stroke={1.5} className={config.iconClassName} />
            <span className="text-sm font-medium truncate">
              {task.title ?? task.agent.displayName ?? task.agent.name}
            </span>
          </div>
          {task.summary && (
            <p className="text-xs text-muted-foreground line-clamp-2">
              {task.summary}
            </p>
          )}
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(task.updatedAt)}
          </span>
        </div>
      </Card>
    </Shortcut>
  );
}

export function TaskTypeIcon({ task }: { task: TaskItem }) {
  const config = getTaskTypeConfig(task.type);
  const Icon = config.icon;
  return (
    <Icon
      size={14}
      stroke={1.5}
      className={`${config.iconClassName} shrink-0`}
    />
  );
}
