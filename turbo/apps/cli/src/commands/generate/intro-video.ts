import { Command } from "commander";
import {
  INTRO_VIDEO_TEMPLATE_ITEMS,
  INTRO_VIDEO_TEMPLATES_ENABLED_ENV,
  findIntroVideoTemplateItem,
} from "@okouai/core/intro-video-template-items";

import { withErrorHandler } from "../../lib/command/with-error-handler";
import { createIntroVideoTemplateAuthoringPacket } from "../shared/intro-video-template-authoring";
import { dispatchGenerate } from "./lib/dispatch";

interface IntroVideoOptions {
  readonly prompt?: string;
  readonly template?: string;
}

export function introVideoTemplatesEnabled(): boolean {
  return process.env[INTRO_VIDEO_TEMPLATES_ENABLED_ENV] === "1";
}

function unknownTemplateError(id: string): Error {
  const available = INTRO_VIDEO_TEMPLATE_ITEMS.map((item) => {
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
  .description("Prepare a pinned intro-video template authoring packet")
  .option("--prompt <text>", "Video brief; can also be piped via stdin")
  .requiredOption("--template <id>", "Intro-video template id")
  .addHelpText(
    "after",
    `
Examples:
  Prepare Interview:  okou generate intro-video --template intro-video-template:interview --prompt "Turn this interview into a concise explainer"
  Pipe a brief:       cat brief.txt | okou generate intro-video --template intro-video-template:interview

Output:
  Prints a locked authoring packet. This scaffold does not render on the Okou server.`,
  )
  .action(
    withErrorHandler(async (options: IntroVideoOptions) => {
      if (!introVideoTemplatesEnabled()) {
        throw new Error("Intro-video templates are not enabled for this run.");
      }
      const template = findIntroVideoTemplateItem(options.template ?? "");
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
      const packet = createIntroVideoTemplateAuthoringPacket({
        prompt: dispatch.prompt,
        template,
      });
      console.log(packet.instructions);
    }),
  );
