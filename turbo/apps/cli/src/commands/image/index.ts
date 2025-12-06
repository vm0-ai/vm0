import { Command } from "commander";
import { buildCommand } from "./build";

export const imageCommand = new Command()
  .name("image")
  .description("Manage custom images")
  .addCommand(buildCommand);
