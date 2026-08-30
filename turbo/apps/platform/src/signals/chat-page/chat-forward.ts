import type { Command, Computed } from "ccstate";
import type { ComposerSignals } from "../okou-page/composer-signals.ts";
import type { FeedbackInput } from "../okou-page/chat-feedback.ts";
import type { ChatAgentRunSource } from "./chat-event-signals.ts";

export type ChatForwardTarget =
  | {
      readonly kind: "agent";
      readonly id: string;
      readonly title: string;
    }
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly agentId: string;
      readonly title: string;
    };

export interface ChatForwardSelection extends FeedbackInput {
  readonly threadId: string;
  readonly runId: string;
}

export interface ChatForwardComposerState {
  readonly target: ChatForwardTarget;
  readonly composer: ComposerSignals;
  readonly ready$: Computed<boolean>;
  readonly setLifecycleRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
}

export interface ChatForwardContext extends ChatAgentRunSource, FeedbackInput {}
