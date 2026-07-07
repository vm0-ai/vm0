import { Command } from "commander";

import { getCommand } from "./get";
import { modelCommand } from "./model";
import { renameCommand } from "./rename";

export const zeroChatCommand = new Command()
  .name("chat")
  .description("Manage the current web chat thread")
  .addCommand(getCommand)
  .addCommand(modelCommand)
  .addCommand(renameCommand)
  .addHelpText(
    "after",
    `
Examples:
  Show this chat:    zero chat get
  Switch model:      zero chat model claude-sonnet-5
  Rename this chat:  zero chat rename "Launch plan"`,
  );
