import { command, computed, state } from "ccstate";
import { createForwardAgentComposerSignals } from "../zero-page/agent-composer-signals.ts";
import type { ComposerSignals } from "../zero-page/composer-signals.ts";
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

function createSeedForwardFeedback(
  composer: ComposerSignals,
  forward: ChatForwardContext,
) {
  return command(({ get, set }): void => {
    if (get(composer.feedback.items$).length > 0) {
      return;
    }
    set(composer.feedback.add$, forward);
  });
}

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
  const seedForwardFeedback$ = createSeedForwardFeedback(composer, forward);
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
      set(seedForwardFeedback$);
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

export function createChatForwardComposerState(
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
  const seedForwardFeedback$ = createSeedForwardFeedback(composer, forward);
  return {
    target,
    composer,
    ready$,
    setLifecycleRef$: onRef<HTMLDivElement>(
      command(({ set }, _element: HTMLDivElement, signal: AbortSignal) => {
        signal.throwIfAborted();
        set(seedForwardFeedback$);
      }),
    ),
  };
}
