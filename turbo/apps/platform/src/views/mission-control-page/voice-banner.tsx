import { useGet, useLastResolved, useSet } from "ccstate-react";
import {
  IconMicrophone,
  IconMicrophoneOff,
  IconPhoneOff,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import {
  vcStatus$,
  vcTranscript$,
  vcMuted$,
  vcEnabled$,
  startMissionControlVoiceChat$,
  endVoiceChat$,
  retryVoiceChat$,
  toggleVoiceChatMute$,
} from "../../signals/voice-chat/voice-chat-session.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function VoiceButton() {
  const enabled = useLastResolved(vcEnabled$) ?? false;
  const status = useGet(vcStatus$);
  const muted = useGet(vcMuted$);
  const startChat = useSet(startMissionControlVoiceChat$);
  const endChat = useSet(endVoiceChat$);
  const toggleMute = useSet(toggleVoiceChatMute$);
  const pageSignal = useGet(pageSignal$);

  if (!enabled) {
    return null;
  }

  if (status === "idle") {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          detach(startChat(pageSignal), Reason.DomCallback);
        }}
      >
        <IconMicrophone size={14} stroke={1.5} />
        Voice On
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={toggleMute}
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        aria-label={muted ? "Unmute" : "Mute"}
      >
        {muted ? (
          <IconMicrophoneOff size={14} stroke={1.5} />
        ) : (
          <IconMicrophone size={14} stroke={1.5} />
        )}
      </button>
      <button
        type="button"
        onClick={endChat}
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        aria-label="End voice"
      >
        <IconPhoneOff size={14} stroke={1.5} />
      </button>
    </div>
  );
}

export function VoiceBanner() {
  const status = useGet(vcStatus$);
  const transcript = useGet(vcTranscript$);
  const retryChat = useSet(retryVoiceChat$);
  const endChat = useSet(endVoiceChat$);
  const pageSignal = useGet(pageSignal$);

  if (status === "idle") {
    return null;
  }

  if (
    status === "preparing" ||
    status === "connecting" ||
    status === "reconnecting"
  ) {
    const label = status === "reconnecting" ? "Reconnecting..." : "Enabling...";
    return (
      <div className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground bg-muted/30 border-b">
        <IconLoader2 size={12} className="animate-spin" />
        {label}
      </div>
    );
  }

  if (status === "disconnected") {
    return (
      <div className="flex items-center gap-2 px-6 py-2 text-xs text-destructive bg-destructive/5 border-b">
        <span>Voice disconnected</span>
        <button
          type="button"
          onClick={() => {
            detach(retryChat(pageSignal), Reason.DomCallback);
          }}
          className="inline-flex items-center gap-1 text-xs underline"
        >
          <IconRefresh size={12} />
          Retry
        </button>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex items-center gap-2 px-6 py-2 text-xs text-destructive bg-destructive/5 border-b">
        <span>Voice error</span>
        <button
          type="button"
          onClick={endChat}
          className="inline-flex items-center gap-1 text-xs underline shrink-0"
        >
          Dismiss
        </button>
      </div>
    );
  }

  // connected — show last transcript entry
  const last = transcript[transcript.length - 1];
  if (!last) {
    return (
      <div className="flex items-center gap-2 px-6 py-2 text-xs text-muted-foreground bg-muted/30 border-b">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
        Listening...
      </div>
    );
  }

  const prefix = last.role === "user" ? "You" : "AI";

  return (
    <div className="flex items-center gap-2 px-6 py-2 text-xs bg-muted/30 border-b">
      <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
      <span className="truncate">
        <span className="font-medium">{prefix}:</span> {last.text}
      </span>
    </div>
  );
}
