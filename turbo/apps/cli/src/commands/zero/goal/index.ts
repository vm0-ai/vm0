import { Command, InvalidArgumentError } from "commander";

import {
  blockGoal,
  completeGoal,
  createGoal,
  getGoal,
  resumeGoal,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface CreateOptions {
  readonly objective: string;
  readonly tokenBudget?: number;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

const createCommand = new Command()
  .name("create")
  .description("Create a persistent goal for the current thread")
  .requiredOption("--objective <text>", "Goal objective")
  .option("--token-budget <tokens>", "Optional token budget", (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(
        "--token-budget must be a positive integer",
      );
    }
    return parsed;
  })
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
  .addCommand(getCommand)
  .addCommand(completeCommand)
  .addCommand(blockCommand)
  .addCommand(resumeCommand);
