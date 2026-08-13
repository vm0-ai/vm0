import { Command } from "commander";

import { cancelCommand } from "./cancel";
import { createCommand } from "./create";
import { getCommand } from "./get";
import { listCommand } from "./list";
import { messagesCommand } from "./messages";
import { modelCommand } from "./model";
import { renameCommand } from "./rename";
import { sendCommand } from "./send";

export const zeroChatCommand = new Command()
  .name("chat")
  .description("Manage web chat threads")
  .addCommand(createCommand)
  .addCommand(sendCommand)
  .addCommand(cancelCommand)
  .addCommand(getCommand)
  .addCommand(messagesCommand)
  .addCommand(listCommand)
  .addCommand(modelCommand)
  .addCommand(renameCommand)
  .addHelpText(
    "after",
    `
Examples:
  Create a chat:     okou chat create "Launch plan"
  Send a message:    okou chat send --text "Continue"
  Cancel a run:      okou chat cancel --thread-id <thread-id> --run-id <run-id>
  List agent chats:  okou chat list
  Show this chat:    okou chat get
  Show another:      okou chat get --thread-id <thread-id>
  Read messages:     okou chat messages --thread-id <thread-id>
  Switch model:      okou chat model claude-sonnet-5
  Switch another:    okou chat model --thread <thread-id> claude-sonnet-5
  Rename this chat:  okou chat rename "Launch plan"
  Rename another:    okou chat rename --thread <thread-id> "Launch plan"`,
  );
