import { useGet } from "ccstate-react";
import type { VoiceChatPanelSignals } from "../../signals/mission-control-page/create-voice-chat-panel-signals.ts";
import { VoiceChatEventItem } from "../voice-chat/voice-chat-bubbles.tsx";

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
