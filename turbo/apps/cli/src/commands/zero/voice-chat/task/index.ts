import { Command } from "commander";
import { voiceChatTaskCreateCommand } from "./create";
import { voiceChatTaskGetCommand } from "./get";
import { voiceChatTaskListCommand } from "./list";

export const voiceChatTaskCommand = new Command()
  .name("task")
  .description("Dispatch and inspect voice-chat Tasker runs")
  .addCommand(voiceChatTaskCreateCommand)
  .addCommand(voiceChatTaskGetCommand)
  .addCommand(voiceChatTaskListCommand);
