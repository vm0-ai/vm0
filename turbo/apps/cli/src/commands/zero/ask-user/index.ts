import { Command } from "commander";
import { questionCommand } from "./question";

export const zeroAskUserCommand = new Command()
  .name("ask-user")
  .description("Ask the user a question and wait for the answer")
  .addCommand(questionCommand);
