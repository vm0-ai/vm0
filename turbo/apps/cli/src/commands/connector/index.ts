import { Command } from "commander";
import { connectCommand } from "./connect";

export const connectorCommand = new Command()
  .name("connector")
  .description("Manage third-party service connections")
  .addCommand(connectCommand);
