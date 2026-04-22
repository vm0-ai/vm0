import { Command } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { listVoiceChatTasks } from "../../../../lib/api";

export const voiceChatTaskListCommand = new Command()
  .name("list")
  .description("List voice-chat tasks for a session")
  .argument("<session-id>", "Voice-chat session ID")
  .action(
    withErrorHandler(async (sessionId: string) => {
      const tasks = await listVoiceChatTasks(sessionId);
      const slim = tasks.map((t) => {
        return {
          id: t.id,
          status: t.status,
          createdAt: t.createdAt,
        };
      });
      console.log(JSON.stringify(slim, null, 2));
    }),
  );
