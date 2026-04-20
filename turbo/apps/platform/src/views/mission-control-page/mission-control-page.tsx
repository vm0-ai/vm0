import { useGet, useSet, useLastResolved } from "ccstate-react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";
import {
  missionControlPanelVisible$,
  markAllTasksRead$,
  hasUnreadTasks$,
} from "../../signals/mission-control-page/mission-control-tasks.ts";
import {
  taskListCollapsed$,
  setTaskListPanelRef$,
  setTaskListCollapsed$,
} from "../../signals/mission-control-page/mission-control-panels.ts";
import {
  setTaskListRef$,
  newChatDialogOpen$,
  setNewChatDialogOpen$,
  shortcutHelpOpen$,
  setShortcutHelpOpen$,
  createAndShowChatTask$,
} from "../../signals/mission-control-page/mission-control.ts";
import { subagents$, defaultAgentName$ } from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentListDialog } from "../zero-page/zero-sidebar-dialogs.tsx";
import { ShortcutHelpDialog } from "../components/shortcut-help-dialog.tsx";
import { TaskList } from "./task-list.tsx";
import { TaskPanel } from "./task-panel.tsx";
import { CollapsedTaskListBar } from "./collapsed-task-list-bar.tsx";
import { VoiceButton, VoiceBanner } from "./voice-banner.tsx";

const MISSION_CONTROL_SHORTCUT_SECTIONS = [
  {
    title: "Global",
    shortcuts: [
      { key: "shift+/", label: "Show shortcuts" },
      { key: "j", label: "Next task" },
      { key: "k", label: "Previous task" },
      { key: "mod+b", label: "Toggle sidebar" },
      { key: "c", label: "New chat" },
      { key: "y", label: "Archive task" },
    ],
  },
  {
    title: "Task Card",
    shortcuts: [
      { key: "enter", label: "Open task" },
      { key: "space", label: "Toggle panel" },
    ],
  },
  {
    title: "Task Panel",
    shortcuts: [
      { key: "mod+shift+enter", label: "Maximize / restore" },
      { key: "escape", label: "Back to task card" },
      { key: "ctrl+d", label: "Close panel" },
    ],
  },
] as const;

export function MissionControlPage() {
  const panelVisible = useLastResolved(missionControlPanelVisible$) ?? false;
  const collapsed = useGet(taskListCollapsed$);
  const setCollapsed = useSet(setTaskListCollapsed$);
  const setPanelRef = useSet(setTaskListPanelRef$);
  const setListRef = useSet(setTaskListRef$);
  const newChatOpen = useGet(newChatDialogOpen$);
  const setNewChatOpen = useSet(setNewChatDialogOpen$);
  const shortcutHelp = useGet(shortcutHelpOpen$);
  const setShortcutHelp = useSet(setShortcutHelpOpen$);
  const subagents = useLastResolved(subagents$) ?? [];
  const displayName = useLastResolved(defaultAgentName$) ?? "Zero";
  const createAndShowChatTask = useSet(createAndShowChatTask$);
  const pageSignal = useGet(pageSignal$);
  const markAllRead = useSet(markAllTasksRead$);
  const hasUnread = useLastResolved(hasUnreadTasks$) ?? false;

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
                <div className="flex items-center gap-2">
                  {hasUnread && (
                    <button
                      type="button"
                      onClick={() => {
                        markAllRead();
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Read all
                    </button>
                  )}
                  <VoiceButton />
                </div>
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
      <ShortcutHelpDialog
        open={shortcutHelp}
        onOpenChange={setShortcutHelp}
        description="Available shortcuts in Mission Control"
        sections={MISSION_CONTROL_SHORTCUT_SECTIONS}
      />
    </Group>
  );
}
