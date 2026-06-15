import { readFileSync } from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { sendPhoneMessage } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const messageCommand = new Command()
  .name("message")
  .description("Send an AgentPhone text message")
  .requiredOption("--to <phone>", "Connected phone handle to message")
  .option("--agent-id <id>", "AgentPhone agent ID (inferred when omitted)")
  .option("-t, --text <message>", "Message text")
  .addHelpText(
    "after",
    `
Examples:
  Send a message: zero phone message --to +15551234567 -t "Hello!"
  From stdin:     printf "Hello!" | zero phone message --to +15551234567

Notes:
  - The phone handle must already be connected to the authenticated VM0 user
  - AgentPhone agent ID is inferred from the conversation when omitted`,
  )
  .action(
    withErrorHandler(
      async (options: { to: string; agentId?: string; text?: string }) => {
        let text = options.text;
        if (!text && process.stdin.isTTY === false) {
          text = readFileSync("/dev/stdin", "utf8").trim();
        }

        if (!text) {
          throw new Error("Either --text or piped stdin must be provided", {
            cause: new Error(
              'Usage: zero phone message --to +15551234567 -t "your message"',
            ),
          });
        }

        const result = await sendPhoneMessage({
          toNumber: options.to,
          text,
          agentphoneAgentId: options.agentId,
        });

        console.log(
          chalk.green(`✓ Message sent (message_id: ${result.messageId})`),
        );
      },
    ),
  );
