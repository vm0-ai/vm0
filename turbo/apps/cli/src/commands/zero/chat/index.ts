import { Command } from "commander";

import { getCommand } from "./get";
import { listCommand } from "./list";
import { modelCommand } from "./model";
import { renameCommand } from "./rename";

export const zeroChatCommand = new Command()
  .name("chat")
  .description("Manage web chat threads")
  .addCommand(getCommand)
  .addCommand(listCommand)
  .addCommand(modelCommand)
  .addCommand(renameCommand)
  .addHelpText(
    "after",
    `
Examples:
  List agent chats:  zero chat list
  Show this chat:    zero chat get
  Switch model:      zero chat model claude-sonnet-5
  Switch another:    zero chat model --thread <thread-id> claude-sonnet-5
  Rename this chat:  zero chat rename "Launch plan"
  Rename another:    zero chat rename --thread <thread-id> "Launch plan"`,
  );
