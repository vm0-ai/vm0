import { Command } from "commander";
import { voiceChatContextGetCommand } from "./get";
import { voiceChatContextAppendCommand } from "./append";
import { voiceChatContextPrepareCommand } from "./prepare";

export const voiceChatContextCommand = new Command()
  .name("context")
  .description("Read and write voice-chat shared context")
  .addCommand(voiceChatContextGetCommand)
  .addCommand(voiceChatContextAppendCommand)
  .addCommand(voiceChatContextPrepareCommand);
