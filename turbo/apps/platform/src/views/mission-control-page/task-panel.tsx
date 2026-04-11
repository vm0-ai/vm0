import { useGet, useSet, useResolved } from "ccstate-react";
import {
  IconX,
  IconArrowsMaximize,
  IconArrowsMinimize,
} from "@tabler/icons-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  openThreadEntries$,
  closeMissionControlThread$,
} from "../../signals/mission-control-page/mission-control-threads.ts";
import {
  setThreadGroupRef$,
  maximizedThreadId$,
  toggleMaximizeThread$,
} from "../../signals/mission-control-page/mission-control-panels.ts";
import { ZeroChatThreadPageInner } from "../zero-page/zero-chat-thread-page.tsx";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";

export function ThreadPanel() {
  const entries = useGet(openThreadEntries$);
  const setGroupRef = useSet(setThreadGroupRef$);
  const maximizedId = useGet(maximizedThreadId$);

  return (
    <Group
      orientation="vertical"
      id="mc-threads"
      groupRef={setGroupRef}
      className="flex-1 min-h-0"
    >
      {entries.flatMap(([threadId, signals], index) => {
        const elements = [];
        if (index > 0) {
          elements.push(
            <Separator key={`sep-${threadId}`} className="h-px bg-border" />,
          );
        }
        elements.push(
          <Panel
            key={threadId}
            id={`thread-${threadId}`}
            minSize={maximizedId !== null ? 0 : 60}
          >
            <ThreadCard threadId={threadId} signals={signals} />
          </Panel>,
        );
        return elements;
      })}
    </Group>
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
  const toggleMaximize = useSet(toggleMaximizeThread$);
  const maximizedId = useGet(maximizedThreadId$);

  const isMaximized = maximizedId === threadId;
  const anotherMaximized = maximizedId !== null && !isMaximized;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <span className="text-xs text-muted-foreground font-medium truncate">
          {displayName ?? threadId}
        </span>
        <div className="flex items-center gap-0.5">
          {!anotherMaximized && (
            <button
              type="button"
              onClick={() => {
                toggleMaximize(threadId);
              }}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label={isMaximized ? "Restore thread" : "Maximize thread"}
            >
              {isMaximized ? (
                <IconArrowsMinimize size={14} stroke={1.5} />
              ) : (
                <IconArrowsMaximize size={14} stroke={1.5} />
              )}
            </button>
          )}
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
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <ZeroChatThreadPageInner thread={signals} />
      </div>
    </div>
  );
}
