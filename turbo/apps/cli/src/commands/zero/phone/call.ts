import { Command } from "commander";
import chalk from "chalk";
import { createPhoneCall } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

export const callCommand = new Command()
  .name("call")
  .description("Initiate an outbound phone call")
  .argument(
    "<to-number>",
    "Phone number to call (E.164 format, e.g. +14155551234)",
  )
  .option("--greeting <message>", "Initial greeting when the recipient answers")
  .option(
    "--system-prompt <prompt>",
    "Override the agent's system prompt for this call",
  )
  .action(
    withErrorHandler(
      async (
        toNumber: string,
        options: { greeting?: string; systemPrompt?: string },
      ) => {
        // Validate E.164 format
        if (!/^\+[1-9]\d{1,14}$/.test(toNumber)) {
          console.error(
            chalk.red(
              "Invalid phone number format. Use E.164 (e.g. +14155551234)",
            ),
          );
          process.exit(1);
        }

        const result = await createPhoneCall({
          toNumber,
          greeting: options.greeting,
          systemPrompt: options.systemPrompt,
        });

        console.log(chalk.green("Call initiated"));
        console.log(`  ${"Call ID:".padEnd(12)}${chalk.cyan(result.callId)}`);
        console.log(`  ${"Status:".padEnd(12)}${result.status}`);
      },
    ),
  );
