import { Command } from "commander";

import { contextCommand } from "./context";
import { recallCommand } from "./recall";

export const zeroMemoryCommand = new Command()
  .name("memory")
  .description("Recall structured memory")
  .addCommand(recallCommand)
  .addCommand(contextCommand);
