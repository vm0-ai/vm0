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
  .option(
    "--system-prompt-file <path>",
    "File that defines the agent's persona and task context for this call",
  )
  .action(
    withErrorHandler(
      async (
        toNumber: string,
        options: {
          systemPromptFile?: string;
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

        let systemPrompt: string | undefined;
        if (options.systemPromptFile) {
          try {
            systemPrompt = fs.readFileSync(options.systemPromptFile, "utf-8");
          } catch (err) {
            if (isErrnoException(err) && err.code === "ENOENT") {
              console.error(
                chalk.red(`File not found: ${options.systemPromptFile}`),
              );
              process.exit(1);
            }
            throw err;
          }
        }

        const result = await createPhoneCall({
          toNumber,
          systemPrompt,
        });

        console.log(chalk.green("Call initiated"));
        console.log(`  ${"Call ID:".padEnd(12)}${chalk.cyan(result.callId)}`);
        console.log(`  ${"Status:".padEnd(12)}${result.status}`);
      },
    ),
  );
