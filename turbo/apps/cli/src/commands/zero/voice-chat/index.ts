import { Command } from "commander";
import { voiceChatContextCommand } from "./context";
import { voiceChatTaskCommand } from "./task";

export const zeroVoiceChatCommand = new Command()
  .name("voice-chat")
  .description("Read and write voice-chat shared context and tasks")
  .addCommand(voiceChatContextCommand)
  .addCommand(voiceChatTaskCommand)
  .addHelpText(
    "after",
    `
Examples:
  Read all events:       zero voice-chat context get <session-id>
  Read new events:       zero voice-chat context get <session-id> --after 5
  Append an event:       zero voice-chat context append <session-id> --source slow-brain --type directive --content "Done"
  Create a task:         zero voice-chat task create <session-id> --prompt "Summarize the latest PR"
  List tasks:            zero voice-chat task list <session-id>
  Get a task:            zero voice-chat task get <session-id> <task-id>`,
  );
