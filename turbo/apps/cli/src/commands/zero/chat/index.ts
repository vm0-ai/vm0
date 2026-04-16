import { Command } from "commander";
import { zeroChatMessageCommand } from "./message";

export const zeroChatCommand = new Command()
  .name("chat")
  .description("Send messages to web chat threads")
  .addCommand(zeroChatMessageCommand)
  .addHelpText(
    "after",
    `
Examples:
  Send to thread:   zero chat message send -t <thread-id> --text "Hello!"
  Send to user:     zero chat message send -u <user-id> -a <agent-id> --text "Hello!"`,
  );
