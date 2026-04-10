// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button, cn } from "@vm0/ui";
import {
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import { defaultAgentName$ } from "../../signals/agent.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  vcStatus$,
  vcTranscript$,
  vcEvents$,
  vcMuted$,
  vcError$,
  vcEnabled$,
  vcAgentId$,
  vcPrompt$,
  vcPrepElapsedMs$,
  vcReconnectAttempt$,
  vcMeetingPromptInput$,
  setMeetingPromptInput$,
  startVoiceChat$,
  startVoiceMeeting$,
  endVoiceChat$,
  retryVoiceChat$,
  toggleVoiceChatMute$,
} from "../../signals/voice-chat/voice-chat-session.ts";
import {
  setTranscriptScrollContainer$,
  setEventsScrollContainer$,
} from "../../signals/voice-chat/voice-chat-auto-scroll.ts";
import {
  useTranscriptAutoScroll,
  useEventsAutoScroll,
} from "./use-voice-chat-auto-scroll.ts";

type ConnectionStatus =
  | "idle"
  | "preparing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

function StatusBadge({
  status,
  reconnectAttempt,
}: {
  status: ConnectionStatus;
  reconnectAttempt?: number;
}) {
  const label: Record<ConnectionStatus, string> = {
    idle: "Ready",
    preparing: "Preparing...",
    connecting: "Connecting...",
    connected: "Connected",
    reconnecting: "Reconnecting...",
    disconnected: "Disconnected",
    error: "Error",
  };
  const color: Record<ConnectionStatus, string> = {
    idle: "bg-muted text-muted-foreground",
    preparing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    connecting:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    connected:
      "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    reconnecting:
      "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    disconnected: "bg-muted text-muted-foreground",
    error: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  };
  const displayLabel =
    status === "reconnecting" && reconnectAttempt
      ? `Reconnecting (${reconnectAttempt}/5)...`
      : label[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        color[status],
      )}
    >
      {(status === "connecting" ||
        status === "preparing" ||
        status === "reconnecting") && (
        <IconLoader2 size={12} className="animate-spin" />
      )}
      {status === "connected" && (
        <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
      )}
      {displayLabel}
    </span>
  );
}

export function VoiceChatPage() {
  const pageSignal = useGet(pageSignal$);
  const enabled = useLastResolved(vcEnabled$);
  const agentId = useLastResolved(vcAgentId$);
  const status = useGet(vcStatus$);
  const transcript = useGet(vcTranscript$);
  const events = useGet(vcEvents$);
  const muted = useGet(vcMuted$);
  const error = useGet(vcError$);
  const startSession = useSet(startVoiceChat$);
  const startMeeting = useSet(startVoiceMeeting$);
  const endSession = useSet(endVoiceChat$);
  const toggleMute = useSet(toggleVoiceChatMute$);
  const reconnectAttempt = useGet(vcReconnectAttempt$);
  const retrySession = useSet(retryVoiceChat$);
  const prompt = useGet(vcPrompt$);
  const prepElapsedMs = useGet(vcPrepElapsedMs$);
  const meetingPrompt = useGet(vcMeetingPromptInput$);
  const setMeetingPrompt = useSet(setMeetingPromptInput$);
  const agentName = useLastResolved(defaultAgentName$) ?? "Zero";
  const setTranscriptContainer = useSet(setTranscriptScrollContainer$);
  const setEventsContainer = useSet(setEventsScrollContainer$);

  useTranscriptAutoScroll(transcript.length);
  useEventsAutoScroll(events.length);

  const elapsedSeconds = Math.floor(prepElapsedMs / 1000);

  if (enabled === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
        <h1 className="text-2xl font-bold">Voice Chat</h1>
        <p className="text-muted-foreground">
          Voice chat is not available for your account.
        </p>
      </div>
    );
  }

  if (status === "idle") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 p-8">
        <h1 className="text-2xl font-bold">Voice Chat</h1>
        <p className="text-muted-foreground max-w-md text-center">
          Start a voice conversation with the AI agent, or prepare a meeting
          with a specific topic.
        </p>
        {error && (
          <p className="text-sm text-destructive max-w-md text-center">
            {error}
          </p>
        )}
        <textarea
          className="w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          rows={3}
          placeholder="What would you like to discuss? (required for meetings)"
          value={meetingPrompt}
          onChange={(e) => {
            setMeetingPrompt(e.target.value);
          }}
        />
        <div className="flex gap-3">
          <Button
            size="lg"
            onClick={() => {
              detach(startSession(pageSignal), Reason.DomCallback);
            }}
            disabled={!agentId}
          >
            <IconMicrophone size={18} className="mr-2" />
            Start Voice Chat
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={() => {
              detach(
                startMeeting(meetingPrompt, pageSignal),
                Reason.DomCallback,
              );
            }}
            disabled={!agentId || !meetingPrompt.trim()}
          >
            <IconLoader2 size={18} className="mr-2" />
            Start Voice Meeting
          </Button>
        </div>
        {!agentId && (
          <p className="text-xs text-muted-foreground">
            No agent selected. Please select an agent first.
          </p>
        )}
      </div>
    );
  }

  if (status === "preparing") {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">
              {prompt ? "Preparing Meeting" : "Preparing..."}
            </h1>
            {elapsedSeconds > 0 && (
              <span className="text-sm tabular-nums text-muted-foreground">
                {Math.floor(elapsedSeconds / 60)}:
                {String(elapsedSeconds % 60).padStart(2, "0")}
              </span>
            )}
            <StatusBadge status={status} />
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              endSession();
            }}
          >
            <IconPhoneOff size={16} className="mr-1.5" />
            Cancel
          </Button>
        </div>

        {prompt && (
          <div className="border-b px-4 py-3">
            <p className="text-sm text-muted-foreground">Your prompt:</p>
            <p className="text-sm mt-1">{prompt}</p>
          </div>
        )}

        <div
          ref={setEventsContainer}
          className="flex-1 overflow-y-auto p-4 space-y-2"
        >
          <h2 className="text-sm font-medium text-muted-foreground mb-3">
            Slow Brain Activity
          </h2>
          {events.filter((e) => {
            return e.source === "slow-brain";
          }).length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              Waiting for slow brain to start preparation...
            </p>
          )}
          {events
            .filter((e) => {
              return e.source === "slow-brain";
            })
            .map((event) => {
              return (
                <div
                  key={event.seq}
                  className="text-sm py-1.5 border-b border-border/50 last:border-0"
                >
                  <span className="text-muted-foreground font-mono text-xs">
                    [{event.type}]
                  </span>{" "}
                  {event.content && (
                    <span className="whitespace-pre-wrap">{event.content}</span>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Voice Chat</h1>
          <StatusBadge status={status} reconnectAttempt={reconnectAttempt} />
        </div>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            endSession();
          }}
        >
          <IconPhoneOff size={16} className="mr-1.5" />
          End Session
        </Button>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Main content: two-panel layout */}
      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-0 overflow-hidden">
        {/* Transcript panel */}
        <div className="flex flex-col border-r overflow-hidden">
          <div className="border-b px-4 py-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Live Transcript
            </h2>
          </div>
          <div
            ref={setTranscriptContainer}
            className="flex-1 overflow-y-auto p-4 space-y-3"
          >
            {transcript.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                {status === "connecting"
                  ? "Connecting..."
                  : "Speak to start the conversation."}
              </p>
            )}
            {transcript.map((entry) => {
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm max-w-[85%]",
                    entry.role === "user"
                      ? "bg-primary/10 ml-auto text-right"
                      : "bg-muted mr-auto",
                  )}
                >
                  <span className="text-xs font-medium text-muted-foreground block mb-0.5">
                    {entry.role === "user" ? "You" : agentName}
                  </span>
                  {entry.text}
                </div>
              );
            })}
          </div>
        </div>

        {/* Shared context event log */}
        <div className="flex flex-col overflow-hidden">
          <div className="border-b px-4 py-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              Shared Context Events
            </h2>
          </div>
          <div
            ref={setEventsContainer}
            className="flex-1 overflow-y-auto p-4 space-y-1"
          >
            {events.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No events yet.
              </p>
            )}
            {events.map((event) => {
              return (
                <div
                  key={event.seq}
                  className="text-xs font-mono py-1 border-b border-border/50 last:border-0"
                >
                  <span className="text-muted-foreground">[{event.seq}]</span>{" "}
                  <span className="font-semibold">{event.source}</span>
                  <span className="text-muted-foreground">:</span>{" "}
                  <span>{event.type}</span>
                  {event.content && (
                    <span className="text-muted-foreground ml-1 whitespace-pre-wrap">
                      - {event.content}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Audio controls footer */}
      <div className="border-t px-4 py-3 flex items-center justify-center gap-4">
        <Button
          variant={muted ? "destructive" : "secondary"}
          size="icon"
          className="h-12 w-12 rounded-full"
          onClick={() => {
            toggleMute();
          }}
          disabled={status !== "connected"}
        >
          {muted ? (
            <IconMicrophoneOff size={20} />
          ) : (
            <IconMicrophone size={20} />
          )}
        </Button>
        {status === "disconnected" && (
          <Button
            variant="secondary"
            size="icon"
            className="h-12 w-12 rounded-full"
            onClick={() => {
              detach(retrySession(pageSignal), Reason.DomCallback);
            }}
          >
            <IconRefresh size={20} />
          </Button>
        )}
        <Button
          variant="destructive"
          size="icon"
          className="h-12 w-12 rounded-full"
          onClick={() => {
            endSession();
          }}
        >
          <IconPhoneOff size={20} />
        </Button>
      </div>
    </div>
  );
}
