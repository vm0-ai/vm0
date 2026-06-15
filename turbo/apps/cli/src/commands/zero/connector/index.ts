import { Command } from "commander";
import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { searchCommand } from "./search";
import { statusCommand } from "./status";

export const zeroConnectorCommand = new Command()
  .name("connector")
  .description("Check third-party service connections (GitHub, Slack, etc.)")
  .addCommand(connectCommand)
  .addCommand(listCommand)
  .addCommand(searchCommand)
  .addCommand(statusCommand);
