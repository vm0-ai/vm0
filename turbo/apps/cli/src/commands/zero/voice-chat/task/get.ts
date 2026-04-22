import { Command } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { getVoiceChatTask } from "../../../../lib/api";

export const voiceChatTaskGetCommand = new Command()
  .name("get")
  .description("Get a single voice-chat task")
  .argument("<session-id>", "Voice-chat session ID")
  .argument("<task-id>", "Task ID")
  .action(
    withErrorHandler(async (sessionId: string, taskId: string) => {
      const task = await getVoiceChatTask(sessionId, taskId);
      console.log(JSON.stringify(task, null, 2));
    }),
  );
