import { Command } from "commander";

import { contextCommand } from "./context";
import {
  createCommand,
  documentsCommand,
  forgetCommand,
  forgetPromptCommand,
  forgottenCommand,
  historyCommand,
  listCommand,
  updateCommand,
} from "./lifecycle";
import { recallCommand } from "./recall";
import { searchCommand } from "./search";

export const zeroMemoryCommand = new Command()
  .name("memory")
  .description("Manage, recall, and search structured memory")
  .addCommand(listCommand)
  .addCommand(createCommand)
  .addCommand(updateCommand)
  .addCommand(forgetCommand)
  .addCommand(forgetPromptCommand)
  .addCommand(historyCommand)
  .addCommand(documentsCommand)
  .addCommand(forgottenCommand)
  .addCommand(recallCommand)
  .addCommand(searchCommand)
  .addCommand(contextCommand);
