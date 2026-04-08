import { Command } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { getVoiceChatContextEvents } from "../../../../lib/api";

export const voiceChatContextGetCommand = new Command()
  .name("get")
  .description("Read shared context events for a voice-chat session")
  .argument("<session-id>", "Voice-chat session ID")
  .option(
    "--after <seq>",
    "Only return events after this sequence number",
    parseInt,
  )
  .action(
    withErrorHandler(async (sessionId: string, options: { after?: number }) => {
      const data = await getVoiceChatContextEvents(sessionId, options.after);
      console.log(JSON.stringify(data, null, 2));
    }),
  );
