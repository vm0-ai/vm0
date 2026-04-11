import { useLastLoadable, useSet } from "ccstate-react";
import { IconChevronRight } from "@tabler/icons-react";
import { taskSignals$ } from "../../signals/mission-control-page/mission-control-tasks.ts";
import { toggleTaskList$ } from "../../signals/mission-control-page/mission-control-panels.ts";

export function CollapsedTaskListBar() {
  const tasksLoadable = useLastLoadable(taskSignals$);
  const taskCount =
    tasksLoadable.state === "hasData" ? tasksLoadable.data.length : 0;
  const toggle = useSet(toggleTaskList$);

  return (
    <div className="flex flex-col items-center h-full py-3 gap-2">
      <button
        type="button"
        onClick={() => {
          toggle();
        }}
        className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        aria-label="Expand task list"
      >
        <IconChevronRight size={16} stroke={1.5} />
      </button>
      {taskCount > 0 && (
        <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded-full min-w-[20px] h-5 flex items-center justify-center px-1">
          {taskCount}
        </span>
      )}
    </div>
  );
}
