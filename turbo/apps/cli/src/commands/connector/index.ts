import { Command } from "commander";
import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { disconnectCommand } from "./disconnect";

export const connectorCommand = new Command()
  .name("connector")
  .description("Manage third-party service connections")
  .addCommand(listCommand)
  .addCommand(connectCommand)
  .addCommand(disconnectCommand);
