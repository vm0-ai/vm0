import { configureChatRunFinishedEventCommand } from "./chat-run-finished-event-dispatch.service";
import { dispatchChatRunFinishedWorkflowEvents$ } from "./chat-run-finished-workflow-event.service";

/** Wire the chat-run-finished implementation at the API composition root. */
export function configureChatRunFinishedEventDispatcher(): void {
  configureChatRunFinishedEventCommand(dispatchChatRunFinishedWorkflowEvents$);
}
