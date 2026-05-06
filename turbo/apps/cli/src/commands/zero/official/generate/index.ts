import { Command } from "commander";
import { imageCommand } from "./image";
import { voiceCommand } from "./voice";

export const generateCommand = new Command()
  .name("generate")
  .description("Generate assets with official Zero services")
  .addCommand(imageCommand)
  .addCommand(voiceCommand)
  .addHelpText(
    "after",
    `
Examples:
  Generate image:   zero official generate image --prompt "A watercolor fox"
  Generate speech:  zero official generate voice --text "Hello"`,
  );
