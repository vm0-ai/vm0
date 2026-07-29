import { Command } from "commander";

import { cancelCommand } from "./cancel";
import { getCommand } from "./get";
import { listCommand } from "./list";
import { modelCommand } from "./model";
import { queuedCommand } from "./queued";
import { renameCommand } from "./rename";
import { sendCommand } from "./send";

export const zeroChatCommand = new Command()
  .name("chat")
  .description("Manage web chat threads")
  .addCommand(sendCommand)
  .addCommand(queuedCommand)
  .addCommand(cancelCommand)
  .addCommand(getCommand)
  .addCommand(listCommand)
  .addCommand(modelCommand)
  .addCommand(renameCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send a message:    zero chat send --text "Continue"
  Show queued:       zero chat queued --thread-id <thread-id>
  Cancel a run:      zero chat cancel --thread-id <thread-id> --run-id <run-id>
  List agent chats:  zero chat list
  Show this chat:    zero chat get
  Switch model:      zero chat model claude-sonnet-5
  Switch another:    zero chat model --thread <thread-id> claude-sonnet-5
  Rename this chat:  zero chat rename "Launch plan"
  Rename another:    zero chat rename --thread <thread-id> "Launch plan"`,
  );
