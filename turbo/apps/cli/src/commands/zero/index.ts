import { Command } from "commander";
import { zeroOrgCommand } from "./org";
import { agentCommand } from "./agent";
import { zeroScheduleCommand } from "./schedule";

export const zeroCommand = new Command("zero")
  .description("Zero platform commands")
  .addCommand(zeroOrgCommand)
  .addCommand(agentCommand)
  .addCommand(zeroScheduleCommand);
