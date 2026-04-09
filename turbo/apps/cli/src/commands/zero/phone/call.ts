import * as fs from "fs";
import { Command } from "commander";
import chalk from "chalk";
import { createPhoneCall } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export const callCommand = new Command()
  .name("call")
  .description("Initiate an outbound phone call")
  .argument(
    "<to-number>",
    "Phone number to call (E.164 format, e.g. +14155551234)",
  )
  .option("--greeting <message>", "Initial greeting when the recipient answers")
  .option(
    "--greeting-file <path>",
    "Read greeting from a file (use instead of --greeting)",
  )
  .option(
    "--system-prompt <prompt>",
    "Override the agent's system prompt for this call",
  )
  .option(
    "--prompt-file <path>",
    "Read system prompt from a file (use instead of --system-prompt)",
  )
  .action(
    withErrorHandler(
      async (
        toNumber: string,
        options: {
          greeting?: string;
          greetingFile?: string;
          systemPrompt?: string;
          promptFile?: string;
        },
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

        // Validate mutual exclusivity
        if (options.systemPrompt && options.promptFile) {
          console.error(
            chalk.red("Cannot use both --system-prompt and --prompt-file"),
          );
          process.exit(1);
        }

        if (options.greeting && options.greetingFile) {
          console.error(
            chalk.red("Cannot use both --greeting and --greeting-file"),
          );
          process.exit(1);
        }

        // Resolve system prompt from file if provided
        let systemPrompt = options.systemPrompt;
        if (options.promptFile) {
          try {
            systemPrompt = fs.readFileSync(options.promptFile, "utf-8");
          } catch (err) {
            if (isErrnoException(err) && err.code === "ENOENT") {
              console.error(chalk.red(`File not found: ${options.promptFile}`));
              process.exit(1);
            }
            throw err;
          }
        }

        // Resolve greeting from file if provided
        let greeting = options.greeting;
        if (options.greetingFile) {
          try {
            greeting = fs.readFileSync(options.greetingFile, "utf-8");
          } catch (err) {
            if (isErrnoException(err) && err.code === "ENOENT") {
              console.error(
                chalk.red(`File not found: ${options.greetingFile}`),
              );
              process.exit(1);
            }
            throw err;
          }
        }

        const result = await createPhoneCall({
          toNumber,
          greeting,
          systemPrompt,
        });

        console.log(chalk.green("Call initiated"));
        console.log(`  ${"Call ID:".padEnd(12)}${chalk.cyan(result.callId)}`);
        console.log(`  ${"Status:".padEnd(12)}${result.status}`);
      },
    ),
  );
