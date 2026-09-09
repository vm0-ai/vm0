import type { ChatRunVideoOptionsRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { buildVideoRunOptionsPrompt } from "@okouai/core/video-run-options-prompt";
import type { ComposerCreateMode } from "./composer-create.ts";

/** Freeze the composer's selections as agent-only context for this message. */
export function buildComposerAdditionalInfo(
  mode: ComposerCreateMode | null,
  videoRunOptions: ChatRunVideoOptionsRequest | undefined,
): string | undefined {
  const text = [
    buildVideoRunOptionsPrompt(videoRunOptions ?? null),
    mode ? `Create ${mode === "image" ? "an" : "a"} ${mode}.` : "",
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
  return text.length > 0 ? text : undefined;
}
