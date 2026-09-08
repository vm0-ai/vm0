import { command } from "ccstate";
import { createForwardAgentComposerSignals } from "../okou-page/agent-composer-signals.ts";
import { createChatEventSignals } from "./chat-event-signals.ts";
import type {
  ChatForwardComposerState,
  ChatForwardContext,
  ChatForwardTarget,
} from "./chat-forward.ts";
import { createThreadComposerSignals } from "./create-chat-thread.ts";

export const prepareChatForwardComposer$ = command(
  async (
    { set },
    target: ChatForwardTarget,
    forward: ChatForwardContext,
    onOptimisticSend: () => void,
    signal: AbortSignal,
  ): Promise<ChatForwardComposerState> => {
    if (target.kind === "agent") {
      const composer = createForwardAgentComposerSignals(
        target.id,
        forward,
        onOptimisticSend,
      );
      set(composer.feedback.add$, forward);
      return { target, composer };
    }
    const chatEvents = createChatEventSignals(target.id);
    const composer = createThreadComposerSignals(
      target.id,
      target.agentId,
      chatEvents,
      { forward, onOptimisticSend },
    );
    set(composer.feedback.add$, forward);
    await set(chatEvents.setup$, signal);
    await set(chatEvents.catchUp$, signal);
    signal.throwIfAborted();
    return { target, composer };
  },
);
