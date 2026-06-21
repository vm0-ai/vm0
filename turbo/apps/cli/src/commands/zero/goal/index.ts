import { Command, InvalidArgumentError } from "commander";

import {
  blockGoal,
  completeGoal,
  createGoal,
  editGoal,
  getGoal,
  resumeGoal,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface CreateOptions {
  readonly objective: string;
  readonly tokenBudget?: number;
}

interface EditOptions {
  readonly objective?: string;
  readonly tokenBudget?: number;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function parseTokenBudget(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("--token-budget must be a positive integer");
  }
  return parsed;
}

const createCommand = new Command()
  .name("create")
  .description(
    "Create a persistent goal for the current thread. Create a goal ONLY when the user explicitly asks for a persistent, autonomous, cross-turn task; do not infer a goal from an ordinary one-off request.",
  )
  .requiredOption(
    "--objective <text>",
    "Goal objective. Set a goal ONLY on an explicit user request for autonomous cross-turn work; never infer one from a one-off request.",
  )
  .option("--token-budget <tokens>", "Optional token budget", parseTokenBudget)
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      printJson(
        await createGoal({
          objective: options.objective,
          ...(options.tokenBudget ? { tokenBudget: options.tokenBudget } : {}),
        }),
      );
    }),
  );

const editCommand = new Command()
  .name("edit")
  .description("Edit the current thread goal's objective or token budget")
  .option("--objective <text>", "New goal objective")
  .option("--token-budget <tokens>", "New token budget", parseTokenBudget)
  .action(
    withErrorHandler(async (options: EditOptions) => {
      printJson(
        await editGoal({
          ...(options.objective !== undefined
            ? { objective: options.objective }
            : {}),
          ...(options.tokenBudget !== undefined
            ? { tokenBudget: options.tokenBudget }
            : {}),
        }),
      );
    }),
  );

const getCommand = new Command()
  .name("get")
  .description("Get the current thread goal")
  .action(
    withErrorHandler(async () => {
      printJson(await getGoal());
    }),
  );

const completeCommand = new Command()
  .name("complete")
  .description("Mark the current thread goal complete")
  .action(
    withErrorHandler(async () => {
      printJson(await completeGoal());
    }),
  );

const blockCommand = new Command()
  .name("block")
  .description("Pause continuation for the current thread goal")
  .action(
    withErrorHandler(async () => {
      printJson(await blockGoal());
    }),
  );

const resumeCommand = new Command()
  .name("resume")
  .description("Resume continuation for the current thread goal")
  .action(
    withErrorHandler(async () => {
      printJson(await resumeGoal());
    }),
  );

export const zeroGoalCommand = new Command()
  .name("goal")
  .description("Manage the current thread goal")
  .addCommand(createCommand)
  .addCommand(editCommand)
  .addCommand(getCommand)
  .addCommand(completeCommand)
  .addCommand(blockCommand)
  .addCommand(resumeCommand);
