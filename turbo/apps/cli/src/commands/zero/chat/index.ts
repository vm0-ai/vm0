import { Command } from "commander";

import { getCommand } from "./get";
import { renameCommand } from "./rename";

export const zeroChatCommand = new Command()
  .name("chat")
  .description("Manage the current web chat thread")
  .addCommand(getCommand)
  .addCommand(renameCommand)
  .addHelpText(
    "after",
    `
Examples:
  Show this chat:    zero chat get
  Rename this chat:  zero chat rename "Launch plan"`,
  );
