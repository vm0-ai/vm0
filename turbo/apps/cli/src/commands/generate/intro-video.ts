import { Command } from "commander";
import { HYPERFRAMES_VIDEO_TEMPLATES_ENABLED_ENV } from "@okouai/core/hyperframes-source";
import {
  HYPERFRAMES_TEMPLATE_ITEMS,
  findHyperframesTemplateItem,
} from "@okouai/core/hyperframes-template-items";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createHyperframesTemplateAuthoringPacket } from "../shared/hyperframes-template-authoring";
import { dispatchGenerate } from "./lib/dispatch";

interface IntroVideoOptions {
  readonly prompt?: string;
  readonly template?: string;
}

export function hyperframesVideoTemplatesEnabled(): boolean {
  return process.env[HYPERFRAMES_VIDEO_TEMPLATES_ENABLED_ENV] === "1";
}

function unknownTemplateError(id: string): Error {
  const available = HYPERFRAMES_TEMPLATE_ITEMS.map((item) => {
    return `- ${item.id} (${item.title})`;
  });
  return new Error(
    [
      `Unknown intro-video template: ${id}`,
      "",
      "Available intro-video templates:",
      ...available,
    ].join("\n"),
  );
}

export const introVideoCommand = new Command()
  .name("intro-video")
  .description("Prepare a pinned HyperFrames intro-video authoring packet")
  .option("--prompt <text>", "Video brief; can also be piped via stdin")
  .requiredOption("--template <id>", "HyperFrames template id")
  .addHelpText(
    "after",
    `
Examples:
  Prepare Interview:  okou generate intro-video --template hyperframes-template:interview --prompt "Turn this interview into a concise explainer"
  Pipe a brief:       cat brief.txt | okou generate intro-video --template hyperframes-template:interview

Output:
  Prints a locked authoring packet. This scaffold does not render on the Okou server.`,
  )
  .action(
    withErrorHandler(async (options: IntroVideoOptions) => {
      if (!hyperframesVideoTemplatesEnabled()) {
        throw new Error(
          "HyperFrames intro-video templates are not enabled for this run.",
        );
      }
      const template = findHyperframesTemplateItem(options.template ?? "");
      if (!template) {
        throw unknownTemplateError(options.template ?? "");
      }
      const dispatch = await dispatchGenerate({
        generationType: "video",
        prompt: options.prompt,
        listOnMissingPrompt: false,
        missingPromptError: "Intro-video prompt is required",
      });
      if (dispatch.outcome === "handled") {
        return;
      }
      const packet = createHyperframesTemplateAuthoringPacket({
        prompt: dispatch.prompt,
        template,
      });
      console.log(packet.instructions);
    }),
  );
