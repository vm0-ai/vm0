import { Command } from "commander";
import { zeroOrgCommand } from "./org";

export const zeroCommand = new Command("zero")
  .description("Zero platform commands")
  .addCommand(zeroOrgCommand);
