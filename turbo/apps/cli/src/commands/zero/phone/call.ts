import * as fs from "fs";
import { Command, Option } from "commander";
import chalk from "chalk";
import { createPhoneCall, getPhoneCallDetail } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";
import { printTranscript, printCallInfo } from "./format";

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export const delay = {
  ms: (ms: number): Promise<void> => {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

const TERMINAL_STATUSES = new Set([
  "completed",
  "ended",
  "failed",
  "no-answer",
  "busy",
  "cancelled",
]);

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
  .addOption(
    new Option(
      "--mode <mode>",
      "onhold: wait for call to complete and return transcript. fire-and-forget: initiate and return immediately.",
    )
      .choices(["onhold", "fire-and-forget"])
      .makeOptionMandatory(),
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
          mode: "onhold" | "fire-and-forget";
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
          mode: options.mode,
        });

        console.log(chalk.green("Call initiated"));
        console.log(`  ${"Call ID:".padEnd(12)}${chalk.cyan(result.callId)}`);
        console.log(`  ${"Status:".padEnd(12)}${result.status}`);

        if (options.mode === "fire-and-forget") {
          return;
        }

        // onhold: poll until call completes
        console.log();
        console.log(
          chalk.dim("Waiting for call to complete (polling every 10s)..."),
        );

        const startTime = Date.now();

        while (Date.now() - startTime < POLL_TIMEOUT_MS) {
          await delay.ms(POLL_INTERVAL_MS);

          const detail = await getPhoneCallDetail(result.callId);
          const status = detail.call.status;
          const elapsed = Math.round((Date.now() - startTime) / 1000);

          if (TERMINAL_STATUSES.has(status)) {
            console.log();
            console.log(chalk.bold("Call Detail"));
            console.log();
            printCallInfo(detail.call, result.callId);
            console.log();
            console.log(chalk.bold("Transcript"));
            console.log();
            printTranscript(detail.transcript);

            if (status === "failed") {
              process.exit(1);
            }
            return;
          }

          console.log(chalk.dim(`  [${elapsed}s] status: ${status}`));
        }

        console.error(chalk.red("\nCall timed out after 15 minutes"));
        process.exit(1);
      },
    ),
  );
