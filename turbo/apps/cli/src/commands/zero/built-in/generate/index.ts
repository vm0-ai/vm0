import { Command } from "commander";
import { imageCommand } from "./image";
import { voiceCommand } from "./voice";

export const generateCommand = new Command()
  .name("generate")
  .description("Generate assets with built-in vm0 services")
  .addCommand(imageCommand)
  .addCommand(voiceCommand)
  .addHelpText(
    "after",
    `
Examples:
  Generate image:   zero built-in generate image --prompt "A watercolor fox"
  Generate speech:  zero built-in generate voice --text "Hello"`,
  );
