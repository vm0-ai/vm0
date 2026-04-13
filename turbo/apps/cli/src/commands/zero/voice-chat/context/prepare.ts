import { readFileSync } from "fs";
import { Command } from "commander";
import { withErrorHandler } from "../../../../lib/command";
import { completeVoiceChatPreparation } from "../../../../lib/api";

export const voiceChatContextPrepareCommand = new Command()
  .name("prepare")
  .description("Submit preparation directive content for a voice-chat run")
  .option(
    "--content <content>",
    "Directive content (reads from stdin if not provided)",
  )
  .addHelpText(
    "after",
    `
Examples:
  With content:    zero voice-chat context prepare --content "User is a backend engineer..."
  Pipe from stdin: echo "User is a backend engineer..." | zero voice-chat context prepare`,
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
          "Content is required. Provide --content or pipe via stdin.",
        );
      }

      const data = await completeVoiceChatPreparation(content);
      console.log(JSON.stringify(data, null, 2));
    }),
  );
