import { useGet } from "ccstate-react";
import { cn } from "@vm0/ui";
import { IconLoader2 } from "@tabler/icons-react";
import type { VoiceChatTaskStatus } from "@vm0/core";
import { vcAllTasksSorted$ } from "../../signals/voice-chat/voice-chat-session.ts";

function TaskStatusBadge({ status }: { status: VoiceChatTaskStatus }) {
  const color: Record<VoiceChatTaskStatus, string> = {
    pending: "bg-muted text-muted-foreground",
    queued: "bg-muted text-muted-foreground",
    running:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    done: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        color[status],
      )}
    >
      {status === "running" && (
        <IconLoader2 size={10} className="animate-spin mr-1" />
      )}
      {status}
    </span>
  );
}

export function TasksPanel() {
  const tasks = useGet(vcAllTasksSorted$);

  return (
    <aside className="flex flex-col min-h-0 overflow-hidden text-xs border-l">
      <div className="shrink-0 px-4 py-2 flex items-center gap-3 text-muted-foreground border-b">
        <span className="font-medium">Active tasks</span>
        <span className="font-mono">{tasks.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {tasks.length === 0 ? (
          <p className="text-muted-foreground italic text-center py-4">
            No tasks yet.
          </p>
        ) : (
          tasks.map((task) => {
            return (
              <div
                key={task.id}
                className="rounded-lg border border-border bg-muted/30 px-3 py-2 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <TaskStatusBadge status={task.status} />
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {new Date(task.createdAt).toLocaleTimeString()}
                  </span>
                </div>
                <p className="text-xs text-foreground break-words line-clamp-3">
                  {task.prompt}
                </p>
                {task.result && (
                  <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words border-t border-border/60 pt-2">
                    {task.result}
                  </p>
                )}
                {task.error && (
                  <p className="text-xs text-destructive break-words border-t border-border/60 pt-2">
                    {task.error}
                  </p>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
