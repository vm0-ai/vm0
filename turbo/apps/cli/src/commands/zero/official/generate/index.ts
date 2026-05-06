import { Command } from "commander";
import { voiceCommand } from "./voice";

export const generateCommand = new Command()
  .name("generate")
  .description("Generate assets with official Zero services")
  .addCommand(voiceCommand)
  .addHelpText(
    "after",
    `
Examples:
  Generate speech:  zero official generate voice --text "Hello"`,
  );
