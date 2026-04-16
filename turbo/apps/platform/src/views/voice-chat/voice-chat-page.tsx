// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { Button, Tabs, TabsList, TabsTrigger, cn } from "@vm0/ui";
import {
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
  IconLoader2,
  IconRefresh,
  IconUsers,
  IconCheck,
} from "@tabler/icons-react";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  vcStatus$,
  vcSlowBrainEvents$,
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
  vcModel$,
  setVcModel$,
  vcConversationItems$,
  type RealtimeModel,
} from "../../signals/voice-chat/voice-chat-session.ts";
import {
  setTranscriptScrollContainer$,
  setEventsScrollContainer$,
} from "../../signals/voice-chat/voice-chat-auto-scroll.ts";
import {
  meetingPrepStatus$,
  meetingPrepPrompt$,
  freshPreparations$,
  triggerPreparation$,
  clearPreparation$,
} from "../../signals/voice-chat/voice-chat-preparation.ts";
import {
  VoiceUserBubble,
  VoiceAssistantBubble,
  SlowBrainIndicator,
} from "./voice-chat-bubbles.tsx";

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

function VoiceChatFooter({
  status,
  muted,
  toggleMute,
  onEnd,
  onRetry,
}: {
  status: string;
  muted: boolean;
  toggleMute: () => void;
  onEnd: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="border-t px-4 py-3 flex items-center justify-center gap-3">
      {status === "disconnected" ? (
        <Button
          variant="secondary"
          className="h-10 rounded-full px-5"
          onClick={onRetry}
        >
          <IconRefresh size={18} className="mr-2" />
          Retry
        </Button>
      ) : (
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
      )}
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
  );
}

function MeetingBox() {
  const pageSignal = useGet(pageSignal$);
  const agentId = useLastResolved(vcAgentId$);
  const meetingPrompt = useGet(vcMeetingPromptInput$);
  const setMeetingPrompt = useSet(setMeetingPromptInput$);
  const startMeeting = useSet(startVoiceMeeting$);
  const prepStatus = useGet(meetingPrepStatus$);
  const prepPrompt = useGet(meetingPrepPrompt$);
  const triggerPrep = useSet(triggerPreparation$);
  const clearPrep = useSet(clearPreparation$);
  const promptMatchesPrep = prepPrompt === meetingPrompt;

  return (
    <div className="w-full max-w-md rounded-lg border border-input p-5 flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Voice Meeting</h2>
      <p className="text-sm text-muted-foreground">
        Set a topic to guide a structured conversation.
      </p>
      <textarea
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        rows={3}
        placeholder="What would you like to discuss?"
        value={meetingPrompt}
        onChange={(e) => {
          setMeetingPrompt(e.target.value);
          if (prepPrompt && e.target.value !== prepPrompt) {
            clearPrep();
          }
        }}
      />
      {prepStatus === "preparing" && promptMatchesPrep && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <IconLoader2 size={16} className="animate-spin" />
          Preparing...
        </div>
      )}
      {prepStatus === "ready" && promptMatchesPrep && (
        <div className="flex items-center gap-2 text-sm text-green-600">
          <IconCheck size={16} />
          Preparation ready
        </div>
      )}
      {prepStatus === "failed" && promptMatchesPrep && (
        <div className="text-sm text-destructive">Preparation failed</div>
      )}
      <div className="flex gap-2">
        {!(prepStatus === "ready" && promptMatchesPrep) && (
          <Button
            size="lg"
            variant="outline"
            className="flex-1"
            onClick={() => {
              detach(
                triggerPrep(meetingPrompt, pageSignal),
                Reason.DomCallback,
              );
            }}
            disabled={
              !agentId ||
              !meetingPrompt.trim() ||
              (prepStatus === "preparing" && promptMatchesPrep)
            }
          >
            {prepStatus === "preparing" && promptMatchesPrep
              ? "Preparing..."
              : "Prepare"}
          </Button>
        )}
        <Button
          size="lg"
          variant="secondary"
          className="flex-1"
          onClick={() => {
            detach(startMeeting(meetingPrompt, pageSignal), Reason.DomCallback);
          }}
          disabled={!agentId || !meetingPrompt.trim()}
        >
          <IconUsers size={18} className="mr-2" />
          Start Meeting
        </Button>
      </div>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function ReadyMeetings() {
  const preparations = useLastResolved(freshPreparations$);
  const pageSignal = useGet(pageSignal$);
  const startMeeting = useSet(startVoiceMeeting$);
  const agentId = useLastResolved(vcAgentId$);

  if (!preparations || preparations.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-md flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        Ready Meetings
      </h2>
      {preparations.map((prep) => {
        return (
          <div
            key={prep.id}
            className="flex items-center justify-between rounded-lg border border-input px-4 py-3"
          >
            <div className="flex-1 min-w-0 mr-3">
              <p className="text-sm truncate">{prep.prompt}</p>
              <p className="text-xs text-muted-foreground">
                {formatRelativeTime(prep.createdAt)}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                detach(
                  startMeeting(prep.prompt!, pageSignal),
                  Reason.DomCallback,
                );
              }}
              disabled={!agentId}
            >
              Start
            </Button>
          </div>
        );
      })}
    </div>
  );
}

export function VoiceChatPage() {
  const pageSignal = useGet(pageSignal$);
  const enabled = useLastResolved(vcEnabled$);
  const agentId = useLastResolved(vcAgentId$);
  const status = useGet(vcStatus$);
  const slowBrainEvents = useGet(vcSlowBrainEvents$);
  const muted = useGet(vcMuted$);
  const error = useGet(vcError$);
  const startSession = useSet(startVoiceChat$);
  const endSession = useSet(endVoiceChat$);
  const toggleMute = useSet(toggleVoiceChatMute$);
  const reconnectAttempt = useGet(vcReconnectAttempt$);
  const retrySession = useSet(retryVoiceChat$);
  const prompt = useGet(vcPrompt$);
  const prepElapsedMs = useGet(vcPrepElapsedMs$);
  const model = useGet(vcModel$);
  const setModel = useSet(setVcModel$);
  const setTranscriptContainer = useSet(setTranscriptScrollContainer$);
  const setEventsContainer = useSet(setEventsScrollContainer$);
  const conversationItems = useGet(vcConversationItems$);

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
        <Tabs
          value={model}
          onValueChange={(v) => {
            setModel(v as RealtimeModel);
          }}
        >
          <TabsList>
            <TabsTrigger value="gpt-realtime-mini" className="text-xs px-3">
              GPT Realtime Mini
            </TabsTrigger>
            <TabsTrigger value="gpt-realtime" className="text-xs px-3">
              GPT Realtime
            </TabsTrigger>
          </TabsList>
        </Tabs>
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
        <MeetingBox />
        <ReadyMeetings />
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
          {slowBrainEvents.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">
              Waiting for slow brain to start preparation...
            </p>
          )}
          {slowBrainEvents.map((event) => {
            return (
              <SlowBrainIndicator
                key={event.seq}
                type={event.type}
                content={event.content}
              />
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
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Main content: unified conversation view */}
      <div ref={setTranscriptContainer} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-4 pt-4 pb-8">
          <div className="flex flex-col gap-4">
            {conversationItems.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                {status === "connecting"
                  ? "Connecting..."
                  : "Speak to start the conversation."}
              </p>
            )}
            {conversationItems.map((item) => {
              if (item.kind === "transcript") {
                return item.entry.role === "user" ? (
                  <VoiceUserBubble key={item.key} content={item.entry.text} />
                ) : (
                  <VoiceAssistantBubble
                    key={item.key}
                    content={item.entry.text}
                  />
                );
              }
              return (
                <SlowBrainIndicator
                  key={item.key}
                  type={item.event.type}
                  content={item.event.content}
                />
              );
            })}
          </div>
        </div>
      </div>

      <VoiceChatFooter
        status={status}
        muted={muted}
        toggleMute={toggleMute}
        onEnd={() => {
          endSession();
        }}
        onRetry={() => {
          detach(retrySession(pageSignal), Reason.DomCallback);
        }}
      />
    </div>
  );
}
