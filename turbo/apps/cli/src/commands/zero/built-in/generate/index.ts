import { Command } from "commander";
import { imageCommand } from "./image";
import { videoCommand } from "./video";
import { voiceCommand } from "./voice";

export const generateCommand = new Command()
  .name("generate")
  .description("Generate assets with built-in vm0 services")
  .addCommand(imageCommand)
  .addCommand(videoCommand)
  .addCommand(voiceCommand)
  .addHelpText(
    "after",
    `
Examples:
  Generate image:   zero built-in generate image --prompt "A watercolor fox"
  Generate video:   zero built-in generate video --prompt "A cinematic city shot"
  Generate speech:  zero built-in generate voice --text "Hello"`,
  );
