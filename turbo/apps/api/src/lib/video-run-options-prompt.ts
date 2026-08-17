import type { ChatRunVideoOptionsRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { selectedRunOwnedVideoParameters } from "./generation-template-prompt";

/**
 * The video parameters the composer sent with this message, as a system-prompt
 * block.
 *
 * These are defaults, and the wording has to say so. The user set them on a
 * chip before writing anything, so the message itself is the later and more
 * specific statement of intent: "make it square" has to win over a 16:9 chip
 * rather than fight it. Each parameter falls independently, so a message that
 * only names a ratio leaves the chosen duration and resolution in force.
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
  const flags = parameters
    .map((parameter) => {
      return parameter.flag;
    })
    .filter((flag) => {
      return flag.length > 0;
    })
    .join(" ");
  return [
    "# Video Generation Defaults",
    "The user set these as the default video parameters for this run:",
    ...parameters.map((parameter) => {
      return `- ${parameter.label}`;
    }),
    "They are defaults, not requirements. Use them for every video you generate in this run, except where the user's message asks for something else -- what the message says wins, for that parameter only, and the remaining defaults still apply.",
    ...(flags.length > 0
      ? [
          `With nothing in the message to the contrary, that is \`${flags}\` on the final video generation command.`,
        ]
      : []),
  ].join("\n");
}
