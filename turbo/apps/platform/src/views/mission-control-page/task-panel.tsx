import { useGet, useSet, useResolved } from "ccstate-react";
import { IconX } from "@tabler/icons-react";
import {
  openThreadEntries$,
  closeMissionControlThread$,
} from "../../signals/mission-control-page/mission-control-threads.ts";
import { ZeroChatThreadPageInner } from "../zero-page/zero-chat-thread-page.tsx";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";

export function ThreadPanel() {
  const entries = useGet(openThreadEntries$);

  return (
    <div className="flex flex-col flex-1 min-h-0 divide-y">
      {entries.map(([threadId, signals]) => {
        return (
          <ThreadCard key={threadId} threadId={threadId} signals={signals} />
        );
      })}
    </div>
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <span className="text-xs text-muted-foreground font-medium truncate">
          {displayName ?? threadId}
        </span>
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
      <div className="flex-1 min-h-0 overflow-hidden">
        <ZeroChatThreadPageInner thread={signals} />
      </div>
    </div>
  );
}
