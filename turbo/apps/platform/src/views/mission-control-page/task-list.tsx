import { useLastLoadable } from "ccstate-react";
import { Skeleton, Card } from "@vm0/ui";
import { taskSignals$ } from "../../signals/mission-control-page/mission-control-tasks.ts";
import { TaskCard } from "./task-card.tsx";

function TaskListSkeleton() {
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

function TaskListError({ message }: { message: string }) {
  return <p className="py-8 text-sm text-destructive">{message}</p>;
}

export function TaskList() {
  const tasksLoadable = useLastLoadable(taskSignals$);
  const tasks = tasksLoadable.state === "hasData" ? tasksLoadable.data : [];
  const loading = tasksLoadable.state === "loading";
  const error =
    tasksLoadable.state === "hasError"
      ? tasksLoadable.error instanceof Error
        ? tasksLoadable.error.message
        : "Failed to load tasks"
      : null;

  if (loading && tasks.length === 0) {
    return <TaskListSkeleton />;
  }

  if (error) {
    return <TaskListError message={error} />;
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
      {tasks.map((ts) => {
        return <TaskCard key={ts.task.id} taskSignals={ts} />;
      })}
    </div>
  );
}
