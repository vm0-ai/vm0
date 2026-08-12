import type { Command, Computed } from "ccstate";
import type { UserMessageInputDocument } from "@vm0/api-contracts/contracts/chat-threads";
import type { ComposerSignals } from "../zero-page/composer-signals.ts";
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

export interface ChatForwardSelection {
  readonly text: string;
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

export interface ChatForwardContext extends ChatAgentRunSource {
  readonly quote: string;
}

function quotedForwardContent(quote: string): string {
  return quote
    .trim()
    .split("\n")
    .map((line) => {
      return `> ${line}`;
    })
    .join("\n");
}

export function forwardSubmissionPrompt(
  forward: ChatForwardContext,
  note: string,
): string {
  const content = `Forwarded content:\n\n${quotedForwardContent(forward.quote)}`;
  const trimmedNote = note.trim();
  return trimmedNote
    ? `${content}\n\nAdditional context:\n\n${trimmedNote}`
    : content;
}

export function withForwardedContent(
  document: UserMessageInputDocument | null,
  forward: ChatForwardContext,
): UserMessageInputDocument {
  const prefix = forwardSubmissionPrompt(forward, "");
  const parts = document?.parts ?? [];
  return {
    version: 1,
    parts: [
      {
        type: "text",
        text:
          parts.length > 0 ? `${prefix}\n\nAdditional context:\n\n` : prefix,
      },
      ...parts,
    ],
  };
}
