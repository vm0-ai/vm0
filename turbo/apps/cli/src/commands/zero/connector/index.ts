import { Command } from "commander";
import { connectCommand } from "./connect";
import { listCommand } from "./list";
import { statusCommand } from "./status";
import { disconnectCommand } from "./disconnect";

export const zeroConnectorCommand = new Command()
  .name("connector")
  .description("Check or connect third-party services (GitHub, Slack, etc.)")
  .addCommand(listCommand)
  .addCommand(statusCommand)
  .addCommand(connectCommand)
  .addCommand(disconnectCommand);
