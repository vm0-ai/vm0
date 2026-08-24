import { command, computed, state } from "ccstate";
import { createForwardAgentComposerSignals } from "../okou-page/agent-composer-signals.ts";
import { onRef } from "../utils.ts";
import { createChatEventSignals } from "./chat-event-signals.ts";
import type {
  ChatForwardComposerState,
  ChatForwardContext,
  ChatForwardTarget,
} from "./chat-forward.ts";
import { createThreadComposerSignals } from "./create-chat-thread.ts";

const ready$ = computed((): boolean => {
  return true;
});
const setReadyLifecycleRef$ = command(
  (_context, _element: HTMLDivElement | null): (() => void) | undefined => {
    return undefined;
  },
);

function createForwardThreadComposerState(
  target: Extract<ChatForwardTarget, { readonly kind: "thread" }>,
  forward: ChatForwardContext,
  onOptimisticSend: () => void,
): ChatForwardComposerState {
  const chatEvents = createChatEventSignals(target.id);
  const composer = createThreadComposerSignals(
    target.id,
    target.agentId,
    chatEvents,
    { forward, onOptimisticSend },
  );
  const internalReady$ = state(false);
  const threadReady$ = computed((get): boolean => {
    return get(internalReady$);
  });
  const setLifecycleRef$ = onRef(
    command(async ({ set }, _element: HTMLDivElement, signal: AbortSignal) => {
      set(internalReady$, false);
      signal.addEventListener(
        "abort",
        () => {
          set(internalReady$, false);
        },
        { once: true },
      );
      await set(chatEvents.setup$, signal);
      await set(chatEvents.catchUp$, signal);
      signal.throwIfAborted();
      set(internalReady$, true);
    }),
  );
  return {
    target,
    composer,
    ready$: threadReady$,
    setLifecycleRef$,
  };
}

function createChatForwardComposerState(
  target: ChatForwardTarget,
  forward: ChatForwardContext,
  onOptimisticSend: () => void,
): ChatForwardComposerState {
  if (target.kind === "thread") {
    return createForwardThreadComposerState(target, forward, onOptimisticSend);
  }
  const composer = createForwardAgentComposerSignals(
    target.id,
    forward,
    onOptimisticSend,
  );
  return {
    target,
    composer,
    ready$,
    setLifecycleRef$: setReadyLifecycleRef$,
  };
}

export const createChatForwardComposerState$ = command(
  (
    { set },
    target: ChatForwardTarget,
    forward: ChatForwardContext,
    onOptimisticSend: () => void,
  ): ChatForwardComposerState => {
    const composerState = createChatForwardComposerState(
      target,
      forward,
      onOptimisticSend,
    );
    set(composerState.composer.feedback.add$, forward);
    return composerState;
  },
);
