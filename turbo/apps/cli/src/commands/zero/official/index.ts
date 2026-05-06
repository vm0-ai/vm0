import { Command } from "commander";
import { generateCommand } from "./generate";

export const zeroOfficialCommand = new Command()
  .name("official")
  .description("Use official Zero services")
  .addCommand(generateCommand)
  .addHelpText(
    "after",
    `
Examples:
  Generate speech:  zero official generate voice --text "Hello"`,
  );
