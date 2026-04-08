import { Command } from "commander";
import { callCommand } from "./call";
import { recordCommand } from "./record";

export const zeroPhoneCommand = new Command()
  .name("phone")
  .description("Make and manage phone calls")
  .addCommand(callCommand)
  .addCommand(recordCommand);
