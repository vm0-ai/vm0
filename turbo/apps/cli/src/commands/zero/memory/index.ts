import { Command } from "commander";

import { contextCommand } from "./context";
import { recallCommand } from "./recall";
import { searchCommand } from "./search";

export const zeroMemoryCommand = new Command()
  .name("memory")
  .description("Recall and search structured memory")
  .addCommand(recallCommand)
  .addCommand(searchCommand)
  .addCommand(contextCommand);
