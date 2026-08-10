import { configureChatRunFinishedEventCommand } from "./chat-run-finished-event-dispatch.service";
import { dispatchChatRunFinishedAutomationEvents$ } from "./chat-run-finished-automation-event.service";

/** Wire the chat-run-finished implementation at the API composition root. */
export function configureChatRunFinishedEventDispatcher(): void {
  configureChatRunFinishedEventCommand(
    dispatchChatRunFinishedAutomationEvents$,
  );
}
