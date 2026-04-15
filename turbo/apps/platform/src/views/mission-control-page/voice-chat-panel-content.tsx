import { useGet } from "ccstate-react";
import { IconBrain } from "@tabler/icons-react";
import type {
  VoiceChatPanelSignals,
  VoiceChatEvent,
} from "../../signals/mission-control-page/create-voice-chat-panel-signals.ts";
import { Markdown } from "../components/markdown.tsx";

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

type EventCategory = "user" | "assistant" | "slow-brain" | "system";

function categorizeEvent(event: VoiceChatEvent): EventCategory {
  if (event.source === "user" && event.type === "speech") {
    return "user";
  }
  if (event.source === "fast-brain" && event.type === "response") {
    return "assistant";
  }
  if (event.source === "slow-brain") {
    return "slow-brain";
  }
  return "system";
}

function slowBrainLabel(type: string): string {
  switch (type) {
    case "directive": {
      return "Directive";
    }
    case "thinking": {
      return "Thinking";
    }
    case "observation": {
      return "Observation";
    }
    default: {
      return type;
    }
  }
}

// ---------------------------------------------------------------------------
// Bubbles
// ---------------------------------------------------------------------------

function VoiceUserBubble({ content }: { content: string }) {
  if (!content.trim()) {
    return null;
  }
  return (
    <div className="flex justify-end">
      <div className="zero-chat-bubble-user rounded-xl max-w-[85%] px-4 py-3 text-sm leading-relaxed break-words overflow-hidden">
        <Markdown source={content} />
      </div>
    </div>
  );
}

function VoiceAssistantBubble({ content }: { content: string }) {
  if (!content.trim()) {
    return null;
  }
  return (
    <div className="flex justify-start">
      <div className="zero-chat-bubble-assistant rounded-xl max-w-[85%] px-4 py-3 text-sm leading-relaxed break-words overflow-hidden">
        <Markdown source={content} />
      </div>
    </div>
  );
}

function SlowBrainIndicator({
  type,
  content,
}: {
  type: string;
  content: string | null;
}) {
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 text-xs text-muted-foreground">
      <IconBrain size={14} className="shrink-0 mt-0.5" />
      <div className="min-w-0">
        <span className="font-medium">{slowBrainLabel(type)}</span>
        {content?.trim() && (
          <p className="mt-0.5 text-muted-foreground/80 line-clamp-3 break-words">
            {content}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event renderer
// ---------------------------------------------------------------------------

function VoiceChatEventItem({ event }: { event: VoiceChatEvent }) {
  const category = categorizeEvent(event);
  switch (category) {
    case "user": {
      return <VoiceUserBubble content={event.content ?? ""} />;
    }
    case "assistant": {
      return <VoiceAssistantBubble content={event.content ?? ""} />;
    }
    case "slow-brain": {
      return <SlowBrainIndicator type={event.type} content={event.content} />;
    }
    case "system": {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function VoiceChatPanelContent({
  signals,
}: {
  signals: VoiceChatPanelSignals;
}) {
  const events = useGet(signals.events$);

  if (events.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          No conversation events yet
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 overflow-auto @container">
      <div className="mx-auto w-full max-w-[900px] px-4 pt-4 pb-8">
        <div className="flex flex-col gap-4">
          {events.map((event) => {
            return <VoiceChatEventItem key={event.id} event={event} />;
          })}
        </div>
      </div>
    </div>
  );
}
