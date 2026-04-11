import { useGet } from "ccstate-react";
import { missionControlPanelVisible$ } from "../../signals/mission-control-page/mission-control-threads.ts";
import { TaskList } from "./task-list.tsx";
import { ThreadPanel } from "./task-panel.tsx";

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
      {panelVisible && <ThreadPanel />}
    </div>
  );
}
