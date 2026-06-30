import { Command } from "commander";

import { renameCommand } from "./rename";

export const zeroChatCommand = new Command()
  .name("chat")
  .description("Manage the current web chat thread")
  .addCommand(renameCommand)
  .addHelpText(
    "after",
    `
Examples:
  Rename this chat:  zero chat rename "Launch plan"`,
  );
