import { Command } from "commander";
import { questionCommand } from "./question";

export const zeroAskUserCommand = new Command()
  .name("ask-user")
  .description("Ask the user a question and wait for the answer")
  .addCommand(questionCommand)
  .addHelpText(
    "after",
    `
Examples:
  zero ask-user question "Deploy to production?" --option "Yes" --option "No"

Notes:
  - The command blocks until the user responds or the timeout expires (default 300s)
  - The user's answer is printed to stdout for your consumption`,
  );
