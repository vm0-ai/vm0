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
}

export interface ChatForwardContext extends ChatAgentRunSource, FeedbackInput {}
