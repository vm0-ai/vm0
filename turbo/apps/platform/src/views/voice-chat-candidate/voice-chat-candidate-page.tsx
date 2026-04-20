import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button, cn } from "@vm0/ui";
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
  startVoiceChatCandidate$,
  endVoiceChatCandidate$,
  toggleVoiceChatCandidateMute$,
} from "../../signals/voice-chat-candidate/voice-chat-candidate-session.ts";
import { setVoiceChatCandidateScrollContainer$ } from "../../signals/voice-chat-candidate/voice-chat-candidate-auto-scroll.ts";
import {
  VoiceCandidateAssistantBubble,
  VoiceCandidateItemBubble,
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

export function VoiceChatCandidatePage() {
  const pageSignal = useGet(pageSignal$);
  const enabled = useLastResolved(vccEnabled$);
  const agentId = useLastResolved(vccAgentId$);
  const status = useGet(vccStatus$);
  const muted = useGet(vccMuted$);
  const error = useGet(vccError$);
  const tasksById = useGet(vccTasksById$);
  const conversationItems = useGet(vccConversationItems$);
  const startSession = useSet(startVoiceChatCandidate$);
  const endSession = useSet(endVoiceChatCandidate$);
  const toggleMute = useSet(toggleVoiceChatCandidateMute$);
  const setScrollContainer = useSet(setVoiceChatCandidateScrollContainer$);

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
              detach(startSession(pageSignal), Reason.DomCallback);
            }}
            disabled={!agentId}
          >
            <IconMicrophone size={18} className="mr-2" />
            Start Voice Chat
          </Button>
        </div>
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

      <div ref={setScrollContainer} className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-4 pt-4 pb-8">
          <div className="flex flex-col gap-4">
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
