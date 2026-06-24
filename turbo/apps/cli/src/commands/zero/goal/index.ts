import { Command } from "commander";

import {
  blockGoal,
  clearGoal,
  completeGoal,
  createGoal,
  editGoal,
  getGoal,
  pauseGoal,
  resumeGoal,
} from "../../../lib/api";
import { withErrorHandler } from "../../../lib/command";

interface CreateOptions {
  readonly objective: string;
}

interface EditOptions {
  readonly objective: string;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
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
  .action(
    withErrorHandler(async (options: CreateOptions) => {
      printJson(await createGoal({ objective: options.objective }));
    }),
  );

const editCommand = new Command()
  .name("edit")
  .description("Edit the current thread goal objective")
  .requiredOption("--objective <text>", "New goal objective")
  .action(
    withErrorHandler(async (options: EditOptions) => {
      printJson(await editGoal({ objective: options.objective }));
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
  .description("Mark the current thread goal blocked")
  .action(
    withErrorHandler(async () => {
      printJson(await blockGoal());
    }),
  );

const pauseCommand = new Command()
  .name("pause")
  .description("Pause the current thread goal")
  .action(
    withErrorHandler(async () => {
      printJson(await pauseGoal());
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

const clearCommand = new Command()
  .name("clear")
  .description("Clear the current thread goal")
  .action(
    withErrorHandler(async () => {
      printJson(await clearGoal());
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
  .addCommand(pauseCommand)
  .addCommand(resumeCommand)
  .addCommand(clearCommand);
