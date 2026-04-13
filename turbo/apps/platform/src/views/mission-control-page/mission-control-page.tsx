import { useGet, useSet, useLastResolved } from "ccstate-react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import { missionControlPanelVisible$ } from "../../signals/mission-control-page/mission-control-tasks.ts";
import {
  taskListCollapsed$,
  setTaskListPanelRef$,
  setTaskListCollapsed$,
} from "../../signals/mission-control-page/mission-control-panels.ts";
import {
  setTaskListRef$,
  newChatDialogOpen$,
  setNewChatDialogOpen$,
  createAndShowChatTask$,
} from "../../signals/mission-control-page/mission-control.ts";
import { subagents$, defaultAgentName$ } from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentListDialog } from "../zero-page/zero-sidebar-dialogs.tsx";
import { TaskList } from "./task-list.tsx";
import { TaskPanel } from "./task-panel.tsx";
import { CollapsedTaskListBar } from "./collapsed-task-list-bar.tsx";
import { VoiceButton, VoiceBanner } from "./voice-banner.tsx";

export function MissionControlPage() {
  const panelVisible = useLastResolved(missionControlPanelVisible$) ?? false;
  const collapsed = useGet(taskListCollapsed$);
  const setCollapsed = useSet(setTaskListCollapsed$);
  const setPanelRef = useSet(setTaskListPanelRef$);
  const setListRef = useSet(setTaskListRef$);
  const newChatOpen = useGet(newChatDialogOpen$);
  const setNewChatOpen = useSet(setNewChatDialogOpen$);
  const subagents = useLastResolved(subagents$) ?? [];
  const displayName = useLastResolved(defaultAgentName$) ?? "Zero";
  const createAndShowChatTask = useSet(createAndShowChatTask$);
  const pageSignal = useGet(pageSignal$);

  const onNewChat = (agentId: string | null) => {
    setNewChatOpen(false);
    detach(createAndShowChatTask(agentId, pageSignal), Reason.DomCallback);
  };

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "mc-main",
    storage: localStorage,
  });

  return (
    <Group
      orientation="horizontal"
      id="mc-main"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="flex-1 min-h-0"
    >
      <Panel
        id="task-list"
        panelRef={setPanelRef}
        defaultSize="360px"
        minSize={200}
        collapsible
        collapsedSize={40}
        groupResizeBehavior="preserve-pixel-size"
        onResize={(size) => {
          setCollapsed(size.inPixels <= 40);
        }}
      >
        {collapsed ? (
          <CollapsedTaskListBar />
        ) : (
          <div className="flex flex-col min-h-0 h-full">
            <div className="shrink-0 px-6 pt-6 pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-lg font-semibold">Mission Control</h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Active tasks across all channels
                  </p>
                </div>
                <VoiceButton />
              </div>
            </div>
            <VoiceBanner />
            <div ref={setListRef} className="flex-1 overflow-auto px-6 pb-6">
              <TaskList />
            </div>
          </div>
        )}
      </Panel>

      {panelVisible && (
        <>
          <Separator className="w-px bg-border" />
          <Panel id="task-area" minSize="30%">
            <TaskPanel />
          </Panel>
        </>
      )}
      <AgentListDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        displayName={displayName}
        subagents={subagents}
        onNewChat={onNewChat}
      />
    </Group>
  );
}
