import { Command } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { createVoiceChatTask } from "../../../../lib/api";

export const voiceChatTaskCreateCommand = new Command()
  .name("create")
  .description("Dispatch a new task to a fresh Zero sandbox run")
  .argument("<session-id>", "Voice-chat session ID")
  .requiredOption("--prompt <prompt>", "Task prompt for the Tasker")
  .action(
    withErrorHandler(async (sessionId: string, options: { prompt: string }) => {
      const task = await createVoiceChatTask(sessionId, {
        prompt: options.prompt,
      });
      console.log(JSON.stringify(task, null, 2));
    }),
  );
