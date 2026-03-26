import { Command } from "commander";
import chalk from "chalk";
import { postAskUserQuestion, getAskUserAnswer } from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface OptionItem {
  label: string;
  description?: string;
}

function collectOption(
  value: string,
  previous: OptionItem[] | undefined,
): OptionItem[] {
  const list = previous ?? [];
  list.push({ label: value });
  return list;
}

function collectDesc(value: string, previous: string[] | undefined): string[] {
  const list = previous ?? [];
  list.push(value);
  return list;
}

export const questionCommand = new Command()
  .name("question")
  .description("Ask the user a question and wait for the answer")
  .argument("<question>", "The question to ask")
  .option("--header <text>", "Short label displayed as chip/tag (max 12 chars)")
  .option("--option <label>", "Add a choice option (repeatable)", collectOption)
  .option(
    "--desc <text>",
    "Description for the preceding --option",
    collectDesc,
  )
  .option("--multi-select", "Allow multiple selections")
  .option("--timeout <seconds>", "How long to wait for answer", "300")
  .action(
    withErrorHandler(
      async (
        question: string,
        options: {
          header?: string;
          option?: OptionItem[];
          desc?: string[];
          multiSelect?: boolean;
          timeout: string;
        },
      ) => {
        const optionItems = options.option ?? [];
        const descItems = options.desc ?? [];

        // Pair --desc values with --option items
        for (let i = 0; i < descItems.length; i++) {
          const opt = optionItems[i];
          if (!opt) {
            throw new Error("--desc must follow an --option flag");
          }
          opt.description = descItems[i];
        }

        const timeoutMs = parseInt(options.timeout, 10) * 1000;
        if (isNaN(timeoutMs) || timeoutMs <= 0) {
          throw new Error("--timeout must be a positive number of seconds");
        }

        // Build question payload
        const questionItem = {
          question,
          header: options.header,
          options: optionItems.length > 0 ? optionItems : undefined,
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
            throw new Error("Question expired before user responded");
          }

          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }

        // Timeout reached
        throw new Error(
          `Timed out waiting for user response after ${options.timeout}s`,
        );
      },
    ),
  );
