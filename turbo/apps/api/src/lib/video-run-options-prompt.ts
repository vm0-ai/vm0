import type { ChatRunVideoOptionsRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { selectedRunOwnedVideoParameters } from "./generation-template-prompt";

/**
 * The video parameters the composer sent with this message, as a system-prompt
 * block.
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
    "# Video Generation Settings",
    "The user chose these video parameters for this message. They apply to this run only:",
    ...parameters.map((parameter) => {
      return `- ${parameter.label}`;
    }),
    ...(flags.length > 0
      ? [`Pass \`${flags}\` verbatim to the final video generation command.`]
      : []),
  ].join("\n");
}
