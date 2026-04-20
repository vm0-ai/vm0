import { readFileSync } from "fs";
import { Command } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { appendVoiceChatContextEvent } from "../../../../lib/api";

export const voiceChatContextAppendCommand = new Command()
  .name("append")
  .description("Append an event to voice-chat shared context")
  .argument("<session-id>", "Voice-chat session ID")
  .requiredOption(
    "--source <source>",
    "Event source (system|user|fast-brain|slow-brain)",
  )
  .requiredOption("--type <type>", "Event type")
  .option(
    "--content <content>",
    "Event content (reads from stdin if not provided)",
  )
  .addHelpText(
    "after",
    `
Examples:
  Append with content:   zero voice-chat context append <session-id> --source slow-brain --type directive --content "Done"
  Pipe from stdin:       echo "Done" | zero voice-chat context append <session-id> --source slow-brain --type directive`,
  )
  .action(
    withErrorHandler(
      async (
        sessionId: string,
        options: { source: string; type: string; content?: string },
      ) => {
        let content = options.content;

        // Read from stdin if content not provided and stdin is piped
        if (!content && process.stdin.isTTY === false) {
          content = readFileSync("/dev/stdin", "utf8").trim();
        }

        const data = await appendVoiceChatContextEvent(sessionId, {
          source: options.source,
          type: options.type,
          content,
        });
        console.log(JSON.stringify(data, null, 2));
      },
    ),
  );
