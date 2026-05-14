import { Command } from "commander";
import { imageCommand } from "./image";
import { presentationCommand } from "./presentation";
import { videoCommand } from "./video";
import { voiceCommand } from "./voice";

export const generateCommand = new Command()
  .name("generate")
  .description("Generate assets with built-in vm0 services")
  .addCommand(imageCommand)
  .addCommand(presentationCommand)
  .addCommand(videoCommand)
  .addCommand(voiceCommand)
  .addHelpText(
    "after",
    `
Examples:
  Generate image:   zero built-in generate image --prompt "A watercolor fox"
  Generate deck:    zero built-in generate presentation --prompt "A product roadmap"
  Generate video:   zero built-in generate video --prompt "A cinematic city shot"
  Generate speech:  zero built-in generate voice --text "Hello"`,
  );
