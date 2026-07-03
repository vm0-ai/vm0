import type { GenerationTemplateRequest } from "@vm0/api-contracts/contracts/chat-threads";
import { buildGenerationTemplatePrompt } from "./generation-template-prompt";

/**
 * Resolve the generation-template system prompt for a chat run.
 *
 * One-shot only: the prompt is built from the selection attached to *this*
 * message and nothing else. There is no thread-sticky persistence — a
 * follow-up message that doesn't reattach a template resolves to "", and the
 * agent must rely on the marker embedded in the replayed prior-run text (see
 * buildWebChatPriorRunsContext) to keep using the same template across turns.
 * This trades a DB-backed "never expires" default for one signal that lives
 * entirely in-context: no separate store to fall out of sync with what the
 * agent actually sees.
 */
export function resolveThreadGenerationTemplatePrompt(args: {
  readonly explicit: GenerationTemplateRequest | null | undefined;
  readonly presentationRunbookEnabled?: boolean;
}): string {
  if (!args.explicit) {
    return "";
  }
  const built = buildGenerationTemplatePrompt(args.explicit, {
    presentationRunbookEnabled: args.presentationRunbookEnabled,
  });
  return built.status === "resolved" ? built.prompt : "";
}
