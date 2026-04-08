import { Command } from "commander";
import { voiceChatContextCommand } from "./context";

export const zeroVoiceChatCommand = new Command()
  .name("voice-chat")
  .description("Read and write voice-chat shared context events")
  .addCommand(voiceChatContextCommand)
  .addHelpText(
    "after",
    `
Examples:
  Read all events:       zero voice-chat context get <session-id>
  Read new events:       zero voice-chat context get <session-id> --after 5
  Append an event:       zero voice-chat context append <session-id> --source worker --type result --content "Done"`,
  );
