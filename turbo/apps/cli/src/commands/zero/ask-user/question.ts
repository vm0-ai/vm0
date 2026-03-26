import { Command } from "commander";
import chalk from "chalk";
import { postAskUserQuestion, getAskUserAnswer } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface OptionItem {
  label: string;
  description?: string;
}

function collectOption(value: string, previous: OptionItem[]): OptionItem[] {
  previous.push({ label: value });
  return previous;
}

function collectDesc(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export const questionCommand = new Command()
  .name("question")
  .description("Ask the user a question and wait for the answer")
  .argument("<question>", "The question to ask")
  .option("--header <text>", "Short label displayed as chip/tag (max 12 chars)")
  .option(
    "--option <label>",
    "Add a choice option (repeatable)",
    collectOption,
    [] as OptionItem[],
  )
  .option(
    "--desc <text>",
    "Description for the preceding --option",
    collectDesc,
    [] as string[],
  )
  .option("--multi-select", "Allow multiple selections")
  .option("--timeout <seconds>", "How long to wait for answer", "300")
  .action(
    withErrorHandler(
      async (
        question: string,
        options: {
          header?: string;
          option: OptionItem[];
          desc: string[];
          multiSelect?: boolean;
          timeout: string;
        },
      ) => {
        // Pair --desc values with --option items
        for (let i = 0; i < options.desc.length; i++) {
          const opt = options.option[i];
          if (!opt) {
            throw new Error("--desc must follow an --option flag");
          }
          opt.description = options.desc[i];
        }

        const timeoutMs = parseInt(options.timeout, 10) * 1000;
        if (isNaN(timeoutMs) || timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number of seconds");
        }

        // Build question payload
        const questionItem = {
          question,
          header: options.header,
          options: options.option.length > 0 ? options.option : undefined,
          multiSelect: options.multiSelect,
        };

        // Post the question
        const { pendingId } = await postAskUserQuestion({
          questions: [questionItem],
        });

        console.error(
          chalk.dim(
            `⏳ Waiting for user response... (pendingId: ${pendingId})`,
          ),
        );

        // Poll for answer
        const deadline = Date.now() + timeoutMs;
        const pollIntervalMs = 1000;

        while (Date.now() < deadline) {
          const response = await getAskUserAnswer(pendingId);

          if (response.status === "answered") {
            // Print answer to stdout (for agent consumption)
            console.log(response.answer ?? "");
            return;
          }

          if (response.status === "expired") {
            console.error(
              chalk.red("✗ Question expired before user responded"),
            );
            process.exit(1);
          }

          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        // Timeout reached
        console.error(
          chalk.red(
            `✗ Timed out waiting for user response after ${options.timeout}s`,
          ),
        );
        process.exit(1);
      },
    ),
  );
