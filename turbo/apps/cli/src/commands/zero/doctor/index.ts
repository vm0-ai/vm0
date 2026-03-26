import { Command } from "commander";
import { missingTokenCommand } from "./missing-token";

export const zeroDoctorCommand = new Command()
  .name("doctor")
  .description("Diagnose runtime issues (missing tokens, connectors)")
  .addCommand(missingTokenCommand);
