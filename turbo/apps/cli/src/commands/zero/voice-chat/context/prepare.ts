import { readFileSync } from "fs";
import { Command } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { writeVoiceChatPreparation } from "../../../../lib/api";

export const voiceChatContextPrepareCommand = new Command()
  .name("prepare")
  .description("Write voice-chat preparation output")
  .option(
    "--content <content>",
    "Preparation content (reads from stdin if not provided)",
  )
  .addHelpText(
    "after",
    `
Examples:
  With content:   zero voice-chat context prepare --content "Initial directive for the fast-brain."
  Pipe from stdin: echo "directive text" | zero voice-chat context prepare`,
  )
  .action(
    withErrorHandler(async (options: { content?: string }) => {
      let content = options.content;

      // Read from stdin if content not provided and stdin is piped
      if (!content && process.stdin.isTTY === false) {
        content = readFileSync("/dev/stdin", "utf8").trim();
      }

      if (!content) {
        throw new Error(
          "Content is required. Use --content or pipe from stdin.",
        );
      }

      const data = await writeVoiceChatPreparation(content);
      console.log(JSON.stringify(data, null, 2));
    }),
  );
