import { command, computed, state } from "ccstate";
import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";

/**
 * The sent-message template chip the user tapped, held at page level so a
 * single dialog instance serves every message in the thread. Touch viewports
 * hide the chip's inline parameter echo, so this dialog is the only way a
 * phone can read back what a sent video used.
 */
interface SentTemplateDetail {
  readonly titleSnapshot: string;
  readonly template: GenerationTemplateRequest;
}

const internalSentTemplateDetail$ = state<SentTemplateDetail | null>(null);

export const sentTemplateDetail$ = computed((get) => {
  return get(internalSentTemplateDetail$);
});

export const openSentTemplateDetail$ = command(
  ({ set }, detail: SentTemplateDetail) => {
    set(internalSentTemplateDetail$, detail);
  },
);

export const closeSentTemplateDetail$ = command(({ set }) => {
  set(internalSentTemplateDetail$, null);
});
