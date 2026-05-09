import { Command } from "commander";
import { generateCommand } from "./generate";

export const zeroBuiltInCommand = new Command()
  .name("built-in")
  .description("Use built-in vm0 services")
  .addCommand(generateCommand)
  .addHelpText(
    "after",
    `
Examples:
  Generate image:   zero built-in generate image --prompt "A watercolor fox"
  Generate speech:  zero built-in generate voice --text "Hello"`,
  );
