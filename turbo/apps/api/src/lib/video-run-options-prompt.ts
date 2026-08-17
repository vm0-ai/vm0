import type { ChatRunVideoOptionsRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { selectedRunOwnedVideoParameters } from "./generation-template-prompt";

/**
 * The video parameters the composer sent with this message, as a system-prompt
 * block.
 *
 * These are defaults, and the wording has to say so. The user set them on a
 * chip before writing anything, so the message itself is the later and more
 * specific statement of intent: "make it square" has to win over a 16:9 chip
 * rather than fight it. Overrides land per parameter, so a message that names
 * only a ratio leaves the chosen duration and resolution in force.
 *
 * Values only, never the generation flags they map to. A pre-assembled flag
 * string is a ready-made answer that stops being correct the moment the
 * message overrides one value, which is the same pull toward treating these as
 * requirements that the wording above works to avoid.
 *
 * Returns "" unless the user actually changed something. Most runs never
 * generate a video, so the block has to be absent rather than merely quiet:
 * restating the model's own defaults in every run's prompt would cost every
 * unrelated run context for nothing.
 *
 * The model is not part of this block. The run already carries the video model
 * resolved from the thread pin and the member default, and the generation
 * endpoint pins that snapshot regardless of what the prompt says.
 */
export function buildVideoRunOptionsPrompt(
  options: ChatRunVideoOptionsRequest | null,
): string {
  if (!options) {
    return "";
  }
  const parameters = selectedRunOwnedVideoParameters(options);
  if (parameters.length === 0) {
    return "";
  }
  return [
    "# Video Generation Defaults",
    "The user set these for videos generated in this run:",
    ...parameters.map((parameter) => {
      return `- ${parameter.label}`;
    }),
    "Where this run's message asks for something else, the message wins, for that parameter only.",
  ].join("\n");
}
