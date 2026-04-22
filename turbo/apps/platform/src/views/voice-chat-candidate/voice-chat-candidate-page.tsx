import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button, cn } from "@vm0/ui";
import type {
  VoiceChatCandidateSession,
  VoiceChatCandidateTask,
} from "@vm0/core";
import {
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
  IconLoader2,
} from "@tabler/icons-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  vccStatus$,
  vccMuted$,
  vccError$,
  vccEnabled$,
  vccAgentId$,
  vccTasksById$,
  vccConversationItems$,
  vccConversationSummary$,
  vccWorkingTasksSummary$,
  vccFinishedTasksFullText$,
  vccRecentTaskLogs$,
  vccSummarySeq$,
  vccLastSummaryAt$,
  vccTalkerInstructionTokens$,
  vccSessionList$,
  startVoiceChatCandidate$,
  endVoiceChatCandidate$,
  toggleVoiceChatCandidateMute$,
} from "../../signals/voice-chat-candidate/voice-chat-candidate-session.ts";
import { setVoiceChatCandidateScrollContainer$ } from "../../signals/voice-chat-candidate/voice-chat-candidate-auto-scroll.ts";
import {
  VoiceCandidateAssistantBubble,
  VoiceCandidateItemBubble,
  VoiceCandidateToolCallBubble,
  VoiceCandidateUserBubble,
} from "./voice-chat-candidate-bubbles.tsx";

type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

function StatusBadge({ status }: { status: ConnectionStatus }) {
  const label: Record<ConnectionStatus, string> = {
    idle: "Ready",
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Disconnected",
    error: "Error",
  };
  const color: Record<ConnectionStatus, string> = {
    idle: "bg-muted text-muted-foreground",
    connecting:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    connected:
      "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    disconnected: "bg-muted text-muted-foreground",
    error: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        color[status],
      )}
    >
      {status === "connecting" && (
        <IconLoader2 size={12} className="animate-spin" />
      )}
      {status === "connected" && (
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
      )}
      {label[status]}
    </span>
  );
}

function VoiceChatCandidateHeader({ status }: { status: ConnectionStatus }) {
  return (
    <div className="shrink-0 border-b px-4 py-2 hidden md:flex items-center gap-2">
      <span className="text-sm font-medium text-foreground">
        Voice Chat (Candidate)
      </span>
      <StatusBadge status={status} />
    </div>
  );
}

const TOKEN_BUDGET = 32_000;

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}t`;
  }
  const k = tokens / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

function formatTokenPercent(tokens: number): string {
  const pct = (tokens / TOKEN_BUDGET) * 100;
  if (pct < 10) {
    return `${pct.toFixed(1)}%`;
  }
  return `${Math.round(pct)}%`;
}

function ReasonerSection({ title, body }: { title: string; body: string }) {
  if (!body.trim()) {
    return null;
  }
  return (
    <section>
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
        {title}
      </h3>
      <pre className="whitespace-pre-wrap font-mono text-xs text-foreground/80">
        {body}
      </pre>
    </section>
  );
}

function ReasonerPanel() {
  const conversation = useGet(vccConversationSummary$);
  const working = useGet(vccWorkingTasksSummary$);
  const finished = useGet(vccFinishedTasksFullText$);
  const recentLogs = useGet(vccRecentTaskLogs$);
  const summarySeq = useGet(vccSummarySeq$);
  const lastAt = useGet(vccLastSummaryAt$);
  const tokens = useGet(vccTalkerInstructionTokens$);

  const updatedLabel = lastAt ? new Date(lastAt).toLocaleTimeString() : "never";
  const hasAny =
    conversation.trim() ||
    working.trim() ||
    finished.trim() ||
    recentLogs.trim();

  return (
    <aside className="flex flex-col min-h-0 overflow-hidden text-xs">
      <div className="shrink-0 px-4 py-2 flex items-center gap-3 text-muted-foreground border-b">
        <span className="font-medium">Reasoner</span>
        <span className="font-mono">seq={summarySeq}</span>
        <span className="font-mono">
          {formatTokenCount(tokens)}/{TOKEN_BUDGET / 1000}k{" "}
          {formatTokenPercent(tokens)}
        </span>
        <span>updated {updatedLabel}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
        {hasAny ? (
          <>
            <ReasonerSection title="Conversation" body={conversation} />
            <ReasonerSection title="Working tasks" body={working} />
            <ReasonerSection title="Finished tasks" body={finished} />
            <ReasonerSection title="Recent task activity" body={recentLogs} />
          </>
        ) : (
          <p className="text-muted-foreground italic">No context yet.</p>
        )}
      </div>
    </aside>
  );
}

type TaskStatus = VoiceChatCandidateTask["status"];

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const color: Record<TaskStatus, string> = {
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

function TaskerPanel({
  tasks,
}: {
  tasks: Record<string, VoiceChatCandidateTask>;
}) {
  const sorted = Object.values(tasks).sort((a, b) => {
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <aside className="flex flex-col min-h-0 overflow-hidden text-xs">
      <div className="shrink-0 px-4 py-2 flex items-center gap-3 text-muted-foreground border-b">
        <span className="font-medium">Tasker</span>
        <span className="font-mono">{sorted.length} task(s)</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {sorted.length === 0 ? (
          <p className="text-muted-foreground italic text-center py-4">
            No tasks yet.
          </p>
        ) : (
          sorted.map((task) => {
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
                {task.assistantMessages.length > 0 && (
                  <div className="max-h-40 overflow-y-auto flex flex-col gap-1.5 border-t border-border/60 pt-2">
                    {task.assistantMessages.map((entry) => {
                      return (
                        <p
                          key={`${entry.at}:${entry.content.slice(0, 32)}`}
                          className="text-xs text-foreground/80 whitespace-pre-wrap break-words"
                        >
                          {entry.content}
                        </p>
                      );
                    })}
                  </div>
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

function TalkerSection() {
  const status = useGet(vccStatus$);
  const tasksById = useGet(vccTasksById$);
  const conversationItems = useGet(vccConversationItems$);
  const setScrollContainer = useSet(setVoiceChatCandidateScrollContainer$);

  return (
    <section className="flex flex-col min-h-0 overflow-hidden">
      <div ref={setScrollContainer} className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 pt-4 pb-8 flex flex-col gap-4">
          {conversationItems.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {status === "connecting"
                ? "Connecting..."
                : "Speak to start the conversation."}
            </p>
          )}
          {conversationItems.map((entry) => {
            if (entry.kind === "streaming") {
              return entry.role === "user" ? (
                <VoiceCandidateUserBubble
                  key={entry.key}
                  content={entry.content}
                />
              ) : (
                <VoiceCandidateAssistantBubble
                  key={entry.key}
                  content={entry.content}
                />
              );
            }
            if (entry.kind === "tool_call") {
              return (
                <VoiceCandidateToolCallBubble
                  key={entry.key}
                  prompt={entry.task.prompt}
                  status={entry.task.status}
                />
              );
            }
            return (
              <VoiceCandidateItemBubble
                key={entry.key}
                item={entry.item}
                taskById={tasksById}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function VoiceChatCandidateFooter({
  status,
  muted,
  toggleMute,
  onEnd,
}: {
  status: ConnectionStatus;
  muted: boolean;
  toggleMute: () => void;
  onEnd: () => void;
}) {
  return (
    <div className="shrink-0 border-t">
      <div className="px-4 pt-3 pb-3 flex items-center justify-center gap-3">
        <Button
          variant={muted ? "destructive" : "secondary"}
          className="h-10 rounded-full px-5"
          disabled={status !== "connected"}
          onClick={toggleMute}
        >
          {muted ? (
            <IconMicrophoneOff size={18} className="mr-2" />
          ) : (
            <IconMicrophone size={18} className="mr-2" />
          )}
          {muted ? "Unmute" : "Mute"}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="h-10 rounded-full px-5"
          onClick={onEnd}
        >
          <IconPhoneOff size={18} className="mr-2" />
          End Session
        </Button>
      </div>
    </div>
  );
}

function SessionHistoryList({
  onReenter,
}: {
  onReenter: (sessionId: string) => void;
}) {
  const sessions = useLastResolved(vccSessionList$);
  if (!sessions || sessions.length === 0) {
    return null;
  }

  const statusColor: Record<VoiceChatCandidateSession["status"], string> = {
    active: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    ended: "bg-muted text-muted-foreground",
    timeout: "bg-muted text-muted-foreground",
  };

  return (
    <div className="w-full max-w-md flex flex-col gap-2">
      <h3 className="text-sm font-medium text-muted-foreground">
        Previous sessions
      </h3>
      <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
        {sessions.map((session) => {
          const created = new Date(session.createdAt);
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => {
                onReenter(session.id);
              }}
              className="flex items-center justify-between gap-3 rounded-md border border-input px-3 py-2 text-left hover:bg-muted transition"
            >
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-mono truncate">{session.id}</span>
                <span className="text-[11px] text-muted-foreground">
                  {created.toLocaleString()}
                </span>
              </div>
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide shrink-0",
                  statusColor[session.status],
                )}
              >
                {session.status}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function VoiceChatCandidatePage() {
  const pageSignal = useGet(pageSignal$);
  const enabled = useLastResolved(vccEnabled$);
  const agentId = useLastResolved(vccAgentId$);
  const status = useGet(vccStatus$);
  const muted = useGet(vccMuted$);
  const error = useGet(vccError$);
  const tasksById = useGet(vccTasksById$);
  const startSession = useSet(startVoiceChatCandidate$);
  const endSession = useSet(endVoiceChatCandidate$);
  const toggleMute = useSet(toggleVoiceChatCandidateMute$);

  if (enabled === false) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center min-h-0 gap-4 p-8">
        <h1 className="text-2xl font-bold">Voice Chat (Candidate)</h1>
        <p className="text-muted-foreground">
          Voice chat is not available for your account.
        </p>
      </div>
    );
  }

  if (status === "idle") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center min-h-0 gap-6 p-8">
        <h1 className="text-2xl font-bold">Voice Chat (Candidate)</h1>
        {error && (
          <p className="text-sm text-destructive max-w-md text-center">
            {error}
          </p>
        )}
        {!agentId && (
          <p className="text-xs text-muted-foreground">
            No agent selected. Please select an agent first.
          </p>
        )}
        <div className="w-full max-w-md rounded-lg border border-input p-5 flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Quick Chat</h2>
          <p className="text-sm text-muted-foreground">
            Jump into a voice conversation with the AI agent.
          </p>
          <Button
            size="lg"
            className="w-full"
            onClick={() => {
              detach(startSession(undefined, pageSignal), Reason.DomCallback);
            }}
            disabled={!agentId}
          >
            <IconMicrophone size={18} className="mr-2" />
            Start Voice Chat
          </Button>
        </div>
        <SessionHistoryList
          onReenter={(sessionId) => {
            detach(startSession(sessionId, pageSignal), Reason.DomCallback);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <VoiceChatCandidateHeader status={status} />

      {error && (
        <div className="shrink-0 bg-destructive/10 text-destructive px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Desktop-only 3-column layout; no responsive fallback. */}
      <div className="grid grid-cols-3 flex-1 min-h-0 divide-x divide-border">
        <ReasonerPanel />
        <TalkerSection />
        <TaskerPanel tasks={tasksById} />
      </div>

      <VoiceChatCandidateFooter
        status={status}
        muted={muted}
        toggleMute={toggleMute}
        onEnd={() => {
          endSession();
        }}
      />
    </div>
  );
}
